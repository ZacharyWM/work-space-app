#!/usr/bin/env bash
# deploy to the production host (step 5.3): build the client and the Go
# server binary locally (a 1GB host is too small to trust vite builds, and
# cross-compiling spares it a Go toolchain), render the domain templates,
# rsync the runtime files, and (re)start the services. One-time host setup is
# documented in README.md.
#
# Settings come from the environment or a gitignored deploy/.env:
#   DEPLOY_HOST     ssh target, e.g. root@203.0.113.10 (required)
#   DOMAIN          public site hostname served by Caddy (required)
#   TURN_DOMAIN     hostname coturn serves TLS for; must match TURN_HOST in
#                   /etc/workspace.env (default: DOMAIN)
#   REDIRECT_HOSTS  space separated hostnames that 301 to DOMAIN (optional)
#   SSH_KEY         private key for ssh and rsync (optional; ssh defaults)
set -euo pipefail
cd "$(dirname "$0")/.."

# local deploy settings stay out of git (.gitignore covers .env files)
if [[ -f deploy/.env ]]; then
  set -a
  # shellcheck source=/dev/null
  source deploy/.env
  set +a
fi

: "${DEPLOY_HOST:?set DEPLOY_HOST (env or deploy/.env)}"
: "${DOMAIN:?set DOMAIN (env or deploy/.env)}"
TURN_DOMAIN=${TURN_DOMAIN:-$DOMAIN}
REDIRECT_HOSTS=${REDIRECT_HOSTS:-}

# hostnames are spliced into configs with sed, so allow only hostname chars
for h in "$DOMAIN" "$TURN_DOMAIN" $REDIRECT_HOSTS; do
  [[ $h =~ ^[A-Za-z0-9.-]+$ ]] || { echo "invalid hostname: $h" >&2; exit 1; }
done

DEST=/srv/workspace
SSH="ssh${SSH_KEY:+ -i $SSH_KEY}"

# production client bundle (vite reads map.json/theme.json at build time)
npm run build -w client

# static linux binary for the host; CGO off so glibc version can't matter
(cd server && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o workspace-server .)

# render the domain templates into a staging dir laid out like the repo, so
# they land at the same deploy/ paths as the tracked files
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE/deploy"
sed "s/__DOMAIN__/$DOMAIN/g" deploy/Caddyfile > "$STAGE/deploy/Caddyfile"
# one permanent redirect per extra hostname, path preserved so links still land
for h in $REDIRECT_HOSTS; do
  printf '\n%s {\n\tredir https://%s{uri} permanent\n}\n' "$h" "$DOMAIN" >> "$STAGE/deploy/Caddyfile"
done
sed "s/__TURN_DOMAIN__/$TURN_DOMAIN/g" deploy/turnserver.conf > "$STAGE/deploy/turnserver.conf"
sed "s/__TURN_DOMAIN__/$TURN_DOMAIN/g" deploy/turn-cert-sync.sh > "$STAGE/deploy/turn-cert-sync.sh"

# -R keeps the listed paths' structure under DEST; --delete only sweeps inside
# the transferred directories
rsync -azR --delete -e "$SSH" \
  map.json \
  server/workspace-server \
  client/dist \
  deploy/workspace.service \
  deploy/turn-cert-sync.service deploy/turn-cert-sync.timer \
  "$DEPLOY_HOST:$DEST/"
# rendered templates: a second pass from inside the staging dir, since macOS
# openrsync ignores the /./ relative-path marker
(cd "$STAGE" && rsync -azR -e "$SSH" \
  deploy/Caddyfile deploy/turnserver.conf deploy/turn-cert-sync.sh \
  "$DEPLOY_HOST:$DEST/")

# config install + restart. escaped \$ expands on the host — the TURN
# secret never leaves it (step 5.4)
$SSH "$DEPLOY_HOST" "set -e
cd $DEST
install -m 644 deploy/workspace.service /etc/systemd/system/workspace.service
install -m 644 deploy/Caddyfile /etc/caddy/Caddyfile
# coturn config: git-tracked settings + the host-only shared secret appended;
# group-readable so coturn's runtime user can load it
TURN_SECRET=\$(sed -n 's/^TURN_SECRET=//p' /etc/workspace.env)
{ cat deploy/turnserver.conf; printf 'static-auth-secret=%s\n' \"\$TURN_SECRET\"; } > /etc/turnserver.conf
chown root:turnserver /etc/turnserver.conf && chmod 640 /etc/turnserver.conf
install -m 755 deploy/turn-cert-sync.sh /usr/local/bin/turn-cert-sync
install -m 644 deploy/turn-cert-sync.service /etc/systemd/system/turn-cert-sync.service
install -m 644 deploy/turn-cert-sync.timer /etc/systemd/system/turn-cert-sync.timer
systemctl daemon-reload
systemctl enable --now workspace
systemctl restart workspace
systemctl enable --now turn-cert-sync.timer
/usr/local/bin/turn-cert-sync
systemctl restart coturn
systemctl reload caddy"

echo "deployed: https://$DOMAIN"

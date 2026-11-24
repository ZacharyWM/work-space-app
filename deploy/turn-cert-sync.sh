#!/usr/bin/env bash
# copy caddy's Let's Encrypt certificate into coturn's cert dir (step 5.4):
# coturn can't read caddy's storage (caddy-user permissions) and doesn't
# hot-reload certs, so a daily systemd timer re-copies and restarts coturn
# only when the certificate actually changed (LE renews every ~60 days).
# rendered (TURN_DOMAIN filled in) and installed to /usr/local/bin/turn-cert-sync by
# deploy.sh.
set -euo pipefail
SRC=/var/lib/caddy/.local/share/caddy/certificates/acme-v02.api.letsencrypt.org-directory/__TURN_DOMAIN__
DEST=/etc/coturn/certs
mkdir -p "$DEST"
if ! cmp -s "$SRC/__TURN_DOMAIN__.crt" "$DEST/__TURN_DOMAIN__.crt"; then
  # root-owned, group-readable by coturn's runtime user
  install -m 640 -g turnserver "$SRC/__TURN_DOMAIN__.crt" "$DEST/__TURN_DOMAIN__.crt"
  install -m 640 -g turnserver "$SRC/__TURN_DOMAIN__.key" "$DEST/__TURN_DOMAIN__.key"
  systemctl try-restart coturn
fi

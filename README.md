# work-space-app

A walkable 2D virtual office themed as a spaceship, with zone-based audio and
video: walk into a zone to see and hear whoever is standing there, step out to
go private. Peers connect directly over a WebRTC mesh; the server only handles
presence, signaling, and persistence.

Domain vocabulary (Zone, Workspace, Link, Visitor, Pod, and so on) is defined
in [CONTEXT.md](CONTEXT.md). Architecture decisions live in
[docs/adr/](docs/adr/).

## Features

- **Zone A/V**: camera, mic, and screen share scoped to the zone you stand in,
  with a meeting view grid. Devices are released whenever nobody can hear you.
- **Workspaces**: isolated instances of the map, each with its own roster,
  presence, chat, and A/V. Membership comes from creating a workspace,
  accepting an invite, or an approved join request.
- **Workspace links**: two workspaces can link so members of one can visit the
  other through an in-world portal.
- **Map editor**: a workspace's creator can reshape floors, zones, and points
  of interest; changes apply live to everyone aboard.
- **Presence**: status (available, busy, away), waves, emotes, chat with ship,
  zone, and announcement scopes, and claimable personal pods.
- **Decor**: anyone can place, move, and resize props on the map.
- **Mini games**: shuttle racing and shuttle blasters, played from in-world
  game tables, with per-workspace leaderboards.

## Stack

| Layer | Tech |
| --- | --- |
| Client | React, TypeScript, Vite, Canvas 2D rendering, WebRTC |
| Shared | TypeScript protocol package with zod schemas ([shared/](shared/)) |
| Server | Go WebSocket server ([server/](server/)) |
| Auth | [Clerk](https://clerk.com) |
| Storage | PostgreSQL (schema created on server startup) |
| NAT traversal | STUN by default, optional coturn TURN relay |

## Development

Prerequisites: Node.js, Go (see [server/go.mod](server/go.mod) for the
version), PostgreSQL, and a Clerk application.

```sh
createdb deep-space  # the server creates the schema on startup
npm install
npm run dev          # Go ws server on :3000 + vite client on :5173
```

Other scripts:

```sh
npm run typecheck
npm test             # client and shared unit tests (vitest)
npm run server:test  # server unit tests (go test)
npm run build        # production client build
```

### Environment

Server (`server/.env` in dev, loaded automatically):

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `CLERK_SECRET_KEY` | yes | | Clerk backend key for token verification |
| `DATABASE_URL` | no | `postgres://localhost:5432/deep-space` | PostgreSQL connection string |
| `PORT` | no | `3000` | HTTP and WebSocket port |
| `GRACE_MS` | no | `30000` | Reconnect grace window in milliseconds |
| `MAP_PATH` | no | `../map.json` | Default map, relative to the server working directory |
| `TURN_SECRET` | no | | coturn shared secret (set with `TURN_HOST` to enable TURN) |
| `TURN_HOST` | no | | Public hostname of the TURN server |

Client (`client/.env.local`):

| Variable | Required | Purpose |
| --- | --- | --- |
| `VITE_CLERK_PUBLISHABLE_KEY` | yes | Clerk frontend key |

Debug: append `?relay` to the client URL to force every peer connection
through TURN (`iceTransportPolicy: 'relay'`).

## Self hosting

The reference deployment is a single small Linux VM:

- **Caddy** terminates TLS (Let's Encrypt), serves `client/dist` statically,
  and proxies `/ws` to the Go server ([deploy/Caddyfile](deploy/Caddyfile)).
- **Go server** runs as a static binary under systemd
  ([deploy/workspace.service](deploy/workspace.service)), reading its
  environment from `/etc/workspace.env`.
- **PostgreSQL** on the same host.
- **coturn** relays A/V for clients behind restrictive NATs
  ([deploy/turnserver.conf](deploy/turnserver.conf)) in static auth secret
  mode, sharing `TURN_SECRET` with the Go server, which mints short lived
  credentials for each client. TLS on 5349 reuses Caddy's certificate, copied
  by a daily systemd timer ([deploy/turn-cert-sync.sh](deploy/turn-cert-sync.sh)).

### Deploy

Deploy settings are read from the environment or a gitignored `deploy/.env`:

| Variable | Required | Purpose |
| --- | --- | --- |
| `DEPLOY_HOST` | yes | ssh target, e.g. `root@203.0.113.10` |
| `DOMAIN` | yes | Public site hostname served by Caddy |
| `TURN_DOMAIN` | no | Hostname coturn serves TLS for (default `DOMAIN`); must match `TURN_HOST` on the host |
| `REDIRECT_HOSTS` | no | Space separated hostnames that permanently redirect to `DOMAIN` |
| `SSH_KEY` | no | Private key for ssh and rsync |

```sh
./deploy/deploy.sh
```

Builds the client and cross compiles the server (`GOOS=linux GOARCH=amd64`,
CGO off) locally, fills the domain into the Caddy and coturn templates,
rsyncs the runtime files to the host, installs the systemd units and
Caddyfile, and restarts the services. The host needs no Node or Go
toolchain.

### One time host setup (Ubuntu)

```sh
apt-get update && apt-get install -y ca-certificates curl gnupg apt-transport-https
curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key \
  | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt \
  > /etc/apt/sources.list.d/caddy-stable.list
apt-get update && apt-get install -y caddy coturn postgresql
useradd --system --home /srv/workspace --shell /usr/sbin/nologin workspace
mkdir -p /srv/workspace
# the server connects over TCP, which Ubuntu's default pg_hba authenticates
# with scram, so the role needs a password
PGPW=$(openssl rand -hex 24)
sudo -u postgres psql -c "CREATE ROLE workspace LOGIN PASSWORD '$PGPW'"
sudo -u postgres createdb -O workspace deep-space
printf 'PORT=3000\nCLERK_SECRET_KEY=<from the clerk dashboard>\n' > /etc/workspace.env && chmod 600 /etc/workspace.env
printf 'DATABASE_URL=postgres://workspace:%s@localhost:5432/deep-space\n' "$PGPW" >> /etc/workspace.env
printf 'TURN_SECRET=%s\nTURN_HOST=<your domain>\n' "$(openssl rand -hex 32)" >> /etc/workspace.env
ufw allow OpenSSH && ufw allow 80/tcp && ufw allow 443/tcp && ufw --force enable
# TURN: STUN and TURN on 3478 (udp and tcp), TURN over TLS on 5349, relay port range
ufw allow 3478 && ufw allow 5349/tcp && ufw allow 49152:65535/udp
```

Point your domain's A record at the host before Caddy requests its
certificate. Port 3000 stays firewalled; Caddy on 80 and 443 is the only
public entry.

## License

[MIT](LICENSE)

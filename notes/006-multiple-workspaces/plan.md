# Multiple Workspaces — Plan

Run multiple workspaces concurrently on one server: each workspace is an
isolated instance of the ship (own roster, presence, zones, A/V pairing),
and teams in different workspaces never see or hear each other.

Update `notes/006-multiple-workspaces/progress.md` with progress and
decisions as you go, in the style of `notes/005-clerk-auth/progress.md`.

## Decisions already made (do not relitigate)

1. **Access is link-based with auto-membership.** Any signed-in account
   that has a workspace URL can join it. A membership row is recorded on
   first join so a workspace can list its crew. No invites, no roles, no
   admin. Slugs are guessable — acceptable for the trusted-colleagues
   posture this app already has.
2. **Workspaces are created in-app.** The signed-in join screen shows the
   user's workspaces (from membership) plus a create form (name → slug).
3. **Profiles stay global per account.** The `users` table (display name +
   character) is untouched; you look the same in every workspace.
4. **One shared map definition.** Every workspace is an instance of the
   existing `map.json`. Per-workspace maps are out of scope.

## Current single-workspace assumptions (what must change)

- `server/src/index.ts:78` — one global `RoomState`; every join lands in
  it, `broadcastFrom`/`roster()` span all sessions.
- `shared/src/protocol.ts` — `join`/`resume` carry no workspace; there are
  no list/create messages.
- `server/src/db.ts` — only a `users` table; no workspace or membership
  entities.
- `client/src/App.tsx` — no routing; one join screen boards "the" ship.
- `CONTEXT.md` — "There is exactly one Map … the single world everyone
  shares."

## Design overview

- **Server** keeps a registry `Map<workspaceId, RoomState>` (new
  `server/src/rooms.ts`). Rooms are created lazily on first join and
  reaped when they hold no sessions **and** no parked players — a room
  must survive the grace window so drops can resume. Each socket binds to
  its room at join/resume time; every broadcast, roster read, pairing
  diff, and park/resume flows through that room. `RoomState` itself needs
  almost no changes (it is already instance-scoped; hue counter, parked
  map, and resume tokens are naturally per-room) — add an `isEmpty()`
  accessor for reaping.
- **Protocol** — `join` gains a workspace slug; `resume` gains the slug so
  the server searches the right room's parked map (the client stores the
  slug next to the resume token in sessionStorage). New pre-join messages:
  `listWorkspaces {token}` → `workspaceList`, `createWorkspace {token,
  name}` → `workspaceCreated` or `createRejected`. `joinRejected` gains
  reason `workspaceNotFound`. `welcome` gains `workspace: {slug, name}` so
  the HUD can label where you are.
- **DB** — two new tables. `workspaces(id text pk, slug text unique not
  null, name text not null, created_by text not null, created_at)`;
  `workspace_members(workspace_id text references workspaces(id) on
  delete cascade, user_id text, joined_at, primary key(workspace_id,
  user_id))`. Creating a workspace inserts the creator's membership;
  joining upserts membership (fire-and-forget like other profile writes —
  the join itself awaits only the workspace lookup).
- **Client** — path routing without a router library: `/` is the
  workspace picker (your memberships + create form), `/w/:slug` is the
  existing board card scoped to that workspace. Picker list/create runs
  over a short-lived authenticated socket (a small helper, not the
  `Connection` class); each message carries a fresh `getToken()` since
  Clerk tokens expire in ~60s. Note this is not a revival of 005's
  deleted `config` probe — that one was unauthenticated; these messages
  are token-verified like `join`.
- **Slug rules** — server-derived from the name: lowercase, non-alphanumeric
  runs collapse to single hyphens, trimmed, max 32 chars, must be
  non-empty. On unique-violation, reject with `createRejected {reason:
  "slugTaken"}` and let the creator pick another name. Validate the slug
  shape in the protocol schema (`/^[a-z0-9]+(-[a-z0-9]+)*$/`).

## Steps

Each step ends with typecheck + full test suite green (`npm test` from the
repo root; 138 tests pass today — the count only goes up).

### 1. Domain terms

Update `CONTEXT.md`: add **Workspace** (a named, isolated instance of the
Map with its own roster and presence; identified by a slug; anyone signed
in with its URL may join) and **Membership** (the record that an Account
has joined a Workspace; created automatically on first join). Revise
**Map** ("exactly one Map definition; every Workspace is an instance of
it") and any other terms that say everyone shares one world (Open Space,
Wave scope — a Wave reaches anyone *in your Workspace*).

→ verify: CONTEXT.md reads consistently; no term still implies one shared
world.

### 2. DB: workspaces + membership

`server/src/db.ts`: extend `ensureSchema` with the two tables above; add
`createWorkspace(name, createdBy)` (derives slug, inserts workspace +
creator membership, translates unique-violation into a typed slugTaken
result), `workspaceBySlug(slug)`, `workspacesFor(userId)` (via
membership, newest first), `ensureMembership(workspaceId, userId)`
(idempotent upsert). Slug derivation is a pure exported function so it is
unit-testable without a db.

→ verify: new db tests pass (follow the existing test setup pattern —
check how `state.test.ts`/`auth.test.ts` isolate dependencies; if there is
no live-db test harness, test the pure parts and exercise the SQL in step
7's acceptance run).

### 3. Protocol: workspace messages

`shared/src/protocol.ts` + `protocol.test.ts`:

- `join` gains `workspace: slug` (schema-validated slug shape).
- `resume` gains `workspace: slug`.
- new client messages: `listWorkspaces {token}`, `createWorkspace {token,
  name: trim 1–40}`.
- new server messages: `workspaceList {workspaces: [{slug, name}]}`,
  `workspaceCreated {slug, name}`, `createRejected {reason: "slugTaken" |
  "unauthorized"}`.
- `joinRejected` reason enum gains `workspaceNotFound`.
- `welcome` gains `workspace: {slug, name}`.

This step freezes the wire contract; steps 4 and 5 both build against it.

→ verify: protocol tests cover the new shapes (valid + rejected cases).

### 4. Server: room registry

- New `server/src/rooms.ts`: registry wrapping `Map<workspaceId,
  RoomState<T>>` — `roomFor(id)` lazy-creates, `sweep(now)` runs each
  room's `sweepParked` then deletes rooms where `isEmpty()`. Pure class,
  unit-tested like `RoomState`.
- `server/src/state.ts`: add `isEmpty(): boolean` (no sessions, no
  parked). No other changes.
- `server/src/index.ts`: replace the global `state` with the registry.
  Per-connection, track the bound room next to `selfId`. `join`: verify
  token → look up workspace by slug (`workspaceNotFound` rejection when
  missing) → load/create user profile → bind room → `ensureMembership`
  fire-and-forget → welcome (now carrying the workspace) + broadcasts
  scoped to the room. `resume`: find the room by the message's slug; the
  stale-session takeover (`sessionOfToken`) scans only that room. Handle
  `listWorkspaces`/`createWorkspace` pre-join on any socket: verify the
  token per message, reply, leave the socket open (the client closes it).
  `broadcastFrom`, `sendPairingDiff`, `parkAndAnnounce` take the room as a
  parameter. The global `sweepParked` interval becomes the registry sweep.

→ verify: new tests prove isolation — two rooms, a broadcastable event in
one is never seen in the other; resume lands in the right room; a room
with only parked players survives the sweep until grace expiry, then the
room is reaped; join to an unknown slug is rejected.

### 5. Client: routing, picker, scoped join

- `client/src/App.tsx`: read `location.pathname` at mount. `/w/:slug` →
  the existing JoinScreen board card, labeled with the slug (the real name
  arrives with the welcome); `/` → new picker screen (signed-in: your
  workspaces as links to `/w/:slug`, plus the create form; create success
  navigates to the new workspace's board card via `history.pushState`).
- New small client helper for the picker's list/create round-trips (own
  socket, token per message). Not the `Connection` class.
- `join` and `resume` messages carry the slug. `StoredResume` in
  sessionStorage gains the slug; key the entry per workspace or store the
  slug in the value — either way a refresh on `/w/a` must not resume into
  workspace b.
- HUD (`client/src/ui/Hud.tsx`): show the workspace name from the welcome
  somewhere unobtrusive (the existing top-bar pattern).
- EXIT returns to `/w/:slug`'s board card (unchanged behavior otherwise).

→ verify: typecheck; vite dev serves `/w/anything` (SPA fallback is vite's
default — confirm); manual: two browser tabs in two workspaces do not see
each other's avatars or tiles.

### 6. Deploy + docs

- `deploy/Caddyfile` already has SPA fallback (`try_files {path}
  /index.html`), so `/w/:slug` deep-links work in production with no
  deploy changes; `/ws` proxying is untouched. No new env vars.
- README: workspace creation/joining section; note the two new tables
  (schema is still ensured on startup — no migration tool needed at three
  tables).

→ verify: README accurate; no deploy file needed changes beyond docs.

### 7. Acceptance

Live run with the `use-clerk-auth` skill (mints real sessions — see the
skill and `notes/005-clerk-auth/progress.md` setup log):

1. User A creates workspace "alpha" via the picker; lands aboard.
2. User B opens `/w/alpha` by URL (not a member yet); boards; membership
   row appears; A and B see each other, zone A/V pairs.
3. User B creates workspace "beta" and boards it: A (in alpha) and B (in
   beta) see empty rosters relative to each other; waves cannot cross.
4. Refresh B inside beta: resume lands back in beta, not alpha.
5. Both exit; after the grace window the server logs show both rooms
   reaped (or verify via a registry test if logs are insufficient).
6. Duplicate-name create rejects with slugTaken.

Record the run and all decisions in progress.md; clean up throwaway users
and rows afterwards.

## Handoff notes

- Steps are sequential for one agent. If splitting across agents: land
  steps 1–3 first (step 3 freezes the wire contract), then step 4 (server)
  and step 5 (client) can run in parallel; steps 6–7 need both.
- Follow the codebase's conventions: zod-validated discriminated unions,
  no-echo broadcasts, fire-and-forget profile writes, typed rejection
  reasons, concise comments tagged with the note number (`notes/006`).
- Out of scope: invites/roles, per-workspace maps, per-workspace profiles,
  workspace rename/delete, member lists in the UI, horizontal scaling
  beyond one process. Mention — do not build.

## Open questions (resolve during implementation, note in progress.md)

- Whether the picker keeps one socket open for its lifetime or opens one
  per request — whichever reads simpler; both are acceptable.
- Where exactly the workspace name sits in the HUD — match the existing
  visual language.

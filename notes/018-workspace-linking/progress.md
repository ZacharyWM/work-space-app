# Progress

## Done

Space Link (workspace linking) is implemented and verified end to end: two
Workspaces link by request + accept, everyone aboard traverses the Space Link
portal on the Map to Visit the other side, and the creator manages Links —
requesting, accepting, denying, removing, blocking — from the same overlay.
A Visit is pure session state (ADR 0004): the URL keeps naming home, a
refresh or fresh login re-boards home, and a removed Link (or a ban, or the
visited Workspace's deletion) sends the Visitor straight back to their home
spawn. CONTEXT.md's five terms (Link, Link Request, Space Link, Block,
Visitor) and ADR 0004 were written during the plan's grilling session.

### Shared (`shared/src/`)

- `map.ts`: `spaceLink: point` on mapDataSchema — mandatory singleton with
  spawn-point semantics (Q4). Optional on input only: a map that predates the
  portal gets it at the spawn, the one point guaranteed walkable, so every
  pre-existing custom Map works without migration. The default `map.json`
  gained an authored portal at (300, 700), below the med bay near the airlock.
- `geometry.ts`: `mapEditDenial` requires the space link on a Floor Plate,
  exactly like the spawn.
- `protocol.ts`:
  - `visitingFrom: string | null` on playerSchema — the home Workspace's name
    while the person is a Visitor (the crew-panel/Map badge, Q6).
  - welcome carries `home: workspaceInfo` next to `workspace`; they differ
    exactly while visiting.
  - resume gained optional `visited` — a drop mid-Visit resumes in place
    (Q10); the slug field keeps naming home.
  - client → server: `spaceLink` (fetch the overlay state), `linkRequest
    {name}`, `linkCancel/linkAccept/linkDeny/linkRemove/linkUnblock {slug}`,
    `linkBlock {name}`, `visit {slug}`.
  - server → client: `spaceLinkState {home, creator, links, inbound,
    outbound, blocks}` (management lists empty for non-creators),
    `linkRejected` (notFound | notCreator | self | alreadyLinked | blocked |
    youBlocked | requestPending | linkLimit), `visitRejected` (notFound |
    notLinked | removed | full | flying | notNearLink).
  - kicked reasons grew `visitEnded`; decorRejected and itemRejected grew
    `visitor`.

### Server (`server/`)

- `db.go`: three tables — `workspace_links` (one undirected edge per pair,
  stored lower-id-first with a CHECK, both FKs cascading),
  `workspace_link_requests` (directional, pending-only like invites), and
  `workspace_blocks` (directional). Ops: `createLinkRequest` (name resolved
  via deriveSlug; refuses self, alreadyLinked, blocks both ways with distinct
  reasons, and points an outbound at a pending inbound — accepting stays the
  one act that creates a Link, Q9), `acceptLinkRequest` (pending row is the
  authorization; Blocks and the 10-Link cap on BOTH sides re-checked inside
  the guarded insert; every pending request between the pair resolves),
  `denyLinkRequest`, `cancelLinkRequest`, `removeLink` (either side, one edge
  dies both ways, Q1), `blockWorkspace` (one action: block row + both pending
  requests deleted + any Link removed, Q8), `unblockWorkspace` (restores
  nothing), `linkExists`, `blocksBetween`, `linkStateOf`, `workspaceByID`.
- `state.go`: sessions and parked players carry `homeID/homeSlug/homeName`;
  joinInput carries them plus `status` and `visitingFrom` (a traversal keeps
  presence). `visitorCount` (live sessions whose home isn't the room),
  `visitorSessionsOf`, `dropParkedOfHome`, `parkedOwnerOf` (peek a token's
  user+home so a Visit resume can re-check its lifelines before the takeover).
  `maxVisitorsPerWorkspace = 10` (Q11).
- `main.go`:
  - `handleVisit`: on foot, within `spaceLinkJoinRadius` (90) of the current
    room's portal; home's Link gates every hop (no transitivity, Q5); bans
    gate Visits like boarding (Q7); the Visitor cap is checked live at
    traversal only and never blocks members from home (Q11). The move
    re-boards join-style — evict from the old room (announce, race/blast
    departure), join the target at its own portal, fresh welcome + resume
    token, old time-tracking row closed and a new one opened. Returning home
    re-checks the home membership; if it died, the session dies (kicked
    "removed").
  - `handleSpaceLink` + management handlers (`linkRequest/Cancel/Accept/
    Deny/Remove/Block/Unblock`): enforced at-home + creator-only (Q3/Q5);
    every successful action answers with a fresh `spaceLinkState`.
  - kick plumbing (Q7): `kickVisitorsBetween` on unlink/block (both
    directions, parked Visits dropped); a banned Visitor in the room and
    everyone's Visitors on workspace deletion get `visitEnded` (their clients
    re-board home); a member removed from — or whose home was deleted under —
    a Workspace while out Visiting is found across all rooms and kicked to
    the picker with the existing reasons.
  - `handleResume`: a `visited` resume re-checks the visited workspace, home
    membership, the Link, and the ban before the takeover; any dead lifeline
    reads resumeExpired and the client's fresh join lands home.
  - Visitor footprint (Q6): claimPod and every decor handler refuse Visitors
    with the `visitor` reason. Leaderboards needed no change (keyed by
    Account).

### Client (`client/src/`)

- `render/spacelink.ts` (new): the portal — pulsing pad ring,
  counter-rotating dashed rings, violet vortex glow with orbiting sparks,
  beam, and label; `SPACE_LINK_RADIUS = 64` for the E hint.
- `render/draw.ts`: portal drawn with the holotables; avatars carry a
  `◈ HOME NAME` violet badge above the name pill while visiting.
- `render/stage.ts`: E at the portal (after pads and tables) fires
  `onSpaceLink`; "E — SPACE LINK" tip.
- `ui/SpaceLinkPanel.tsx` (new): the overlay — linked list with VISIT (HERE
  for the current room) and, for the managing creator at home, UNLINK/BLOCK
  (two-click confirms), inbound ACCEPT/DENY/BLOCK, outbound CANCEL, blocked
  UNBLOCK, and a request-by-name form. While visiting: a YOU ARE VISITING
  banner with RETURN HOME, management hidden.
- `net/connection.ts`: `home`, `visiting` getter, spaceLinkState/
  linkRejected/visitRejected handlers.
- `App.tsx`: a mid-session welcome (a traversal) tears down the old room's
  peer pairs, closes every per-room overlay, and remounts the stage (keyed
  by a welcome epoch); the stored resume records home + the visited slug so
  a drop mid-Visit resumes in place; a `visitEnded` kick auto-re-joins home
  with the last effective toggles ("YOUR VISIT ENDED — RETURNED HOME");
  visitor gating hides DECOR and pod controls; the crew panel offers the
  creator a two-click BAN on visitor rows (rides the existing removeMember
  round-trip).
- `ui/Hud.tsx` / `ui/CrewPanel.tsx`: "· VISITING" legend marker; crew rows
  read "VISITOR · {HOME} · {place}".
- `ui/MapEditor.tsx`: SPACE LINK tool (move-only, like SPAWN); the portal
  draws in the editor and counts into the view bounds.

## Verified

- `go test ./...`, `vitest` (328 shared tests), `tsc --noEmit` both
  workspaces, and `vite build` all green. New unit tests: decode/encode of
  every new message and the badge's null-vs-string, spaceLink parse default +
  edit denial (Go and TS), visitor counting/park/resume home carriage, and
  status/badge carriage through join.
- Protocol-level acceptance (`spacelink-e2e.mjs`, two real clerk users
  against the live server + postgres): 31 checks — request/accept lifecycle,
  self/pending/blocked refusals, the radius gate, visit welcome (workspace +
  home + badge + far-portal landing), visitor footprint refusals, overlay
  showing home's links while visiting, management refused away from home,
  return-home, unlink kicking the visitor with visitEnded, block deleting the
  pending request and refusing both sides asymmetrically, unblock restoring
  nothing.
- Browser smoke (vite + clerk ticket sign-in): walked to the portal, E
  opened the overlay, VISIT landed in the linked workspace ("· VISITING"
  legend, badge over the avatar, DECOR/EDIT MAP hidden), RETURN HOME landed
  back, and the editor's SPACE LINK tool moved the portal in a draft.

## Not done / future

- No notification surface outside the overlay (per the plan: the overlay is
  the sole surface; the picker stays person-level).
- Block-by-typed-name has no dedicated form; blocking is offered on linked
  and inbound-request rows (the linkBlock message accepts a name, so a form
  is a UI-only addition if ever wanted).

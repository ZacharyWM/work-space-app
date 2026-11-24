# Multiple Workspaces — Progress

## Status

Done and verified end to end; not committed or deployed (manual test pending
by request). Typecheck clean, all 167 tests pass (was 138 — protocol, slug
derivation, and room-registry tests added). Live acceptance run covered all
seven plan scenarios: scripted ws clients (two throwaway clerk users, server
on :3100 with GRACE_MS=3000) proved create/board/membership/pairing,
cross-room invisibility of rosters/pos/waves, workspace-scoped resume, room
reaping after grace, unknown-slug rejection, and slugTaken on a duplicate
name; a browser pass over the real dev servers proved the picker UI
(list/create/link nav/back button), the slug-labeled board card, the HUD
workspace name, refresh-resume into the same workspace, vite's SPA fallback
for `/w/anything`, and the workspace-not-found notice. Test users and all
zzacc-* rows deleted afterwards.

## Decisions

1. **`createRejected` gained a third reason, `invalidName`.** A 1–40 char
   workspace name can still contain zero alphanumerics ("!!!", "日本語"),
   which derives an empty slug. Rejecting that as `slugTaken` would lie to
   the creator, so the enum is `slugTaken | invalidName | unauthorized`.
   `deriveSlug` returns `""` for the case and `db.createWorkspace` translates
   it before touching postgres.

2. **Resume went async.** Finding the room by slug is a db read
   (`workspaceBySlug`), so resume adopted join's guard shape: the `joining`
   flag plus a post-await `readyState` check. A db failure mid-resume closes
   the socket *without* a typed rejection — the client's retry loop treats an
   unexpected close as retryable, which is right for a transient failure.

3. **A cross-room resume rejects as `resumeExpired`, not
   `workspaceNotFound`.** The workspace exists; the token just isn't in that
   room's parked map. The client already treats `resumeExpired` as token
   death and falls back to a fresh join on the same board card — the correct
   recovery either way.

4. **Both picker requests reuse `createRejected {unauthorized}` for a bad
   token.** Inventing a separate unauthorized reply for `listWorkspaces`
   would widen the protocol for a case the picker can only surface as "try
   again"; the client helper treats any `createRejected` as failure.

5. **The picker opens one socket per request** (open → send → single reply →
   close), the simpler of the two options the plan left open. Each request
   mints a fresh clerk token since session tokens die in ~60s.

6. **Workspace + creator membership insert atomically** via one
   data-modifying CTE, so a crash between the two writes can't orphan a
   workspace its creator can't see. Unique-violation (23505) on the slug maps
   to `slugTaken`; the creator picks another name — no auto-suffixing.

7. **The registry lazy-creates on resume probes too.** `roomFor` is the only
   accessor; a resume against a reaped room builds an empty room, fails the
   token lookup (`resumeExpired`), and the next sweep reaps the empty shell.
   Cheaper than a second peek API.

8. **Reaping is logged.** The sweep interval prints
   `reaped N empty room(s); M remain` so the acceptance check (and prod ops)
   can see rooms die. Observed live: both rooms reaped after the grace
   window.

9. **`StoredResume` keeps one entry with the slug in the value.** A refresh
   on `/w/a` resumes only when the stored slug matches the route; a mismatch
   reads as "no token" and falls back to the board card. Boarding workspace b
   in the same tab overwrites a's token — one aboard session per tab is
   already the model.

10. **HUD placement:** the workspace name replaces the static "DECK 1" tag in
    the top-left legend (`BLIP-A · <NAME>`); the board card's mono label
    shows the slug (`BLIP-A · <SLUG>`) until the welcome brings the real
    name. The picker card reuses the join card's chrome (shared
    `screenOverlayStyle`/`cardStyle` consts).

11. **Isolation is unit-tested at the registry level, not through index.ts.**
    There is still no ws-server integration harness (join needs real clerk
    verification), so rooms.test.ts proves roster/broadcast-target/resume
    isolation and sweep semantics on `RoomRegistry`, and the live acceptance
    run covered the socket-level behaviors (unknown slug rejection, pre-join
    picker messages, scoped broadcasts).

## Acceptance log

- Scripted run (`node acceptance.mjs`, scratchpad): 18/18 checks green —
  1a-e create alpha + creator membership + board; 2a-e B boards by URL,
  membership row appears, zone A/V pairs; 3a-d beta isolation (rosters, pos,
  waves both directions); 4a-b beta token refused in alpha, resume lands in
  beta with the same player id; 5a unknown slug → `workspaceNotFound`; 6a
  duplicate name → `slugTaken`. Server log then showed
  `reaped 2 empty room(s); 0 remain`.
- Browser run (preview tools, clerk ticket sign-in): picker list + create +
  navigation, board card label, HUD name, refresh-resume, deep-link SPA
  fallback, workspace-not-found notice — all good.
- Cleanup: both clerk users deleted, `workspaces`/`workspace_members` rows
  removed (cascade verified — 0 rows in each).

## Out of scope (mentioned, not built)

Invites/roles, per-workspace maps, per-workspace profiles, workspace
rename/delete, member lists in the UI, horizontal scaling beyond one process.

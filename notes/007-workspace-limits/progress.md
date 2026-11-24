# Workspace limits, delete, back-nav — Progress

Follow-up to notes/006, requested after its acceptance run: a way back from
the board card to the picker, a 5-workspace creation cap per account, and
one active session per account.

## Status

Done and verified; not committed. Typecheck clean, 184 tests pass (was 167 —
protocol shapes, RoomState eviction, and registry all/remove tests added).
Scripted acceptance (21/21 checks, two throwaway clerk users, server on
:3100 with GRACE_MS=3000) covered the cap, the creator-only delete matrix,
and every kick path; a browser pass over the real dev servers proved the
back link, the two-step delete UI, and the kicked notice (resume token
cleared, no reconnect loop). All ZZAcc7* users and rows deleted afterwards.

## Decisions

1. **New join wins.** Boarding anywhere evicts the account's session (live
   or parked) in every room — including the same workspace, so one rule and
   one code path. The alternative (reject the new join) lets a crashed tab
   lock the account out for the grace window. Chosen by the user when asked.

2. **Eviction is not parking.** `RoomState.evict` removes the session
   without moving it to the parked map, so the resume token dies with it —
   parking instead would let the old tab auto-resume and kick the new
   session right back (ping-pong). The old tab gets a new `kicked
   {boardedElsewhere | workspaceDeleted}` message before the close so its
   client clears the stored token and shows a notice instead of retrying.

3. **The cap lives inside the create statement.** The workspaces insert is
   conditional on `count(*) WHERE created_by < 5`, so the check and the
   insert are one statement; zero rows inserted reads as a new
   `createRejected {limitReached}`. Two racing creates could still land at
   6 — acceptable, the cap is a guardrail, not an invariant.

4. **Delete ships with the cap** (user's call — a lifetime cap with no
   delete would strand accounts). Creator-only: `DELETE … WHERE created_by`
   in one statement; a miss is disambiguated by a follow-up existence check
   into `deleteRejected {notFound | notCreator}`. Memberships cascade.
   Deleting an occupied workspace kicks everyone aboard (`kicked
   {workspaceDeleted}`) and drops the room from the registry — parked
   tokens die with it; no departure broadcasts since the whole room is
   going. The kicked client shows "this workspace was deleted" on the board
   card; the back link is the way out.

5. **The picker list gained a `mine` flag** (`workspaceListEntrySchema`
   extends `workspaceInfoSchema`) rather than widening `workspaceInfo`
   itself, which the welcome also uses. DELETE renders only on `mine` rows;
   the confirm is a two-click arm (`DELETE` → `SURE?`) inline in the row,
   no dialog.

6. **Back-nav is one link.** `← ALL WORKSPACES` on the board card (EXIT
   already lands there from aboard), same-app `pushState` navigation. No
   HUD button.

## Acceptance log

- Scripted (`acceptance.mjs`, scratchpad): 5 creates ok + 6th limitReached;
  list carries mine correctly for creator and joiner; cross-workspace and
  same-workspace joins kick the old session (typed reason, socket closed,
  token dead); a parked token dies on a join elsewhere; delete matrix
  (notCreator / notFound / unauthorized); delete frees a cap slot; deleting
  an occupied workspace kicks the occupant and the slug 404s afterwards.
- Browser (preview on :5174 against the dev server's hot-reloaded :3000):
  create → board card shows the back link → back → row shows DELETE →
  arm/confirm removes the row; scripted second join while aboard put the
  tab back on the join card with "THIS ACCOUNT BOARDED ANOTHER SESSION —
  THIS ONE ENDED" and an empty sessionStorage. No console errors.
- Cleanup: clerk users ZZAcc7A/B/C deleted, app profile rows deleted,
  zero zzacc7 workspace/membership rows remain.

## Out of scope (unchanged from notes/006)

Invites/roles, per-workspace maps, rename, member lists in the UI.

# Member cap + member management — Progress

Follow-up to notes/007: a 20-member cap per workspace, and a creator-only
member management panel in the picker (remove members, see and lift bans).
Member lists in the UI were out of scope since notes/006; this closes that.

## Status

Done and verified; not committed. Typecheck clean, 201 tests pass (was 184 —
protocol shapes for the three member ops, their replies, and the new
joinRejected/kicked reasons). Scripted acceptance (26/26 checks, two
throwaway clerk users, server on :3100 with GRACE_MS=3000) covered the cap,
the creator-only matrix, the kick-on-remove path, ban/unban, and token death;
a browser pass on the preview servers proved the picker panel end to end
(open, 2/20 counter, OWNER tag, REMOVE arm/confirm → row moves to REMOVED,
UNBAN clears it). All ZZAcc8* users and rows deleted afterwards; zero rows
left in workspace_bans.

## Decisions

1. **The 20 limit counts members, not occupants** (user's call when asked).
   `MAX_MEMBERS_PER_WORKSPACE = 20` in db.ts; the count guard rides the
   membership insert inside the new `admitMember`, same guardrail-not-
   invariant stance as the create cap (racing first joins could land at 21).
   Existing members always board — the cap gates only new memberships, so a
   full workspace never locks its own crew out.

2. **Membership gates the join now.** notes/006's fire-and-forget
   `ensureMembership` became an awaited `admitMember` returning
   `ok | removed | full`; the join rejects with the new typed
   `joinRejected {removed | workspaceFull}` reasons before a session exists.

3. **Removal = ban** (user's call — link-based access means a bare membership
   delete is toothless; the removed user would auto-rejoin by clicking the
   link). New `workspace_bans` table (cascades with the workspace); the ban
   row insert and membership delete ride one statement. Removing a live
   member kicks them with the new `kicked {removed}` reason via the same
   evict/announce/dropParked plumbing notes/007 built for boardedElsewhere —
   their resume token dies with the eviction (verified: resume →
   resumeExpired).

4. **Unban does not restore membership.** The user rejoins via the workspace
   link like anyone else and takes a free slot subject to the cap. The panel
   therefore shows two lists (user asked for the banned list explicitly):
   MEMBERS with per-row REMOVE, REMOVED with per-row UNBAN.

5. **Creator-only, creator-immovable.** All three ops (`listMembers`,
   `removeMember`, `unbanMember`) resolve the workspace through one
   `ownedWorkspace` helper (notFound / notCreator, mirroring delete's
   disambiguation); a creator targeting themselves gets the fourth
   `memberRejected` reason, `isCreator`. There are still no roles — creator
   is the only privilege.

6. **The list is a modal over the picker** (user's call; first cut was an
   inline row expansion), opened from a MEMBERS button next to DELETE on
   owned rows — same one-shot socket pattern (token per request), same
   two-click arm (REMOVE → SURE?) as workspace delete. Backdrop click or
   CLOSE dismisses; one modal at a time; a request-id ref keeps a slow list
   reply from rendering under a different workspace's modal.

7. **Member rows come from a LEFT JOIN with a 'Crew Member' fallback** — the
   creator's membership predates their users row (created on first board),
   and the fallback is exactly what the acceptance run showed for the
   never-boarded owner. `memberEntrySchema` carries `{id, name, creator}`;
   banned rows reuse it with creator false.

## Acceptance log

- Scripted (`acceptance.mjs`, scratchpad): create + seed 19 fake members to
  the cap; 21st account → workspaceFull + close; existing member boards at
  the cap; freed slot admits; list shows 20 with creator flag and fallback
  names; matrix (notCreator for list and remove, notFound, unauthorized,
  isCreator); remove while aboard → memberRemoved + kicked{removed} + socket
  close + playerLeft to the room; banned rejoin → joinRejected removed; old
  resume token → resumeExpired; banned list carries the display name; unban →
  empty banned list → rejoin welcome. 26/26.
- Browser (preview on :5174 against dev :3000): picker row shows MEMBERS +
  DELETE on owned rows only; the modal opens with the workspace name,
  MEMBERS · 2/20, OWNER tag; REMOVE arm → SURE? → row moves to REMOVED with
  UNBAN; UNBAN clears the section; counter stays 1/20 (membership not
  restored — by design); backdrop click and CLOSE both dismiss. No console
  errors. Fixed in passing: the name span now has nowrap — the second row
  button squeezed long names into a two-line mid-word wrap.
- Cleanup: clerk users ZZAcc8A–D deleted, app rows deleted, 0 residual rows
  (workspace_bans fully empty).

## Out of scope (unchanged)

Invites/roles beyond creator, per-workspace maps, rename, transferring
ownership, concurrent-occupancy limits.

# workspace invites — progress

## 2026-07-15 — implementation

Full feature implemented per the grilled plan. All layers:

- **db (server/db.go)**: `workspace_invites` (PK workspace_id + lowercased
  email) and `workspace_join_requests` (PK workspace_id + user_id) tables,
  cascade on workspace delete. `admitMember` is now a pure gate
  (removed | ok | notMember — no insert). New `createMembership` carries the
  old guarded insert (ban check, cap-on-insert, idempotent) and deletes both
  pending artifacts on success (Q12/Q13). New: `createInvite`, `cancelInvite`,
  `acceptInvite` (the pending row is the authorization — no row = notFound),
  `declineInvite`, `createJoinRequest`, `cancelJoinRequest`,
  `approveJoinRequest`, `denyJoinRequest`, `pendingFor`, `emailOf`;
  `membersOf` grew invites + requests.
- **protocol (shared/src/protocol.ts + server/protocol.go)**: nine client
  messages (invite, cancelInvite, listPending, acceptInvite, declineInvite,
  requestJoin, cancelRequest, approveRequest, denyRequest), matching replies
  with one shared rejection enum per family
  (unauthorized | notFound | notCreator | removed | alreadyMember | full),
  `memberList` grew invites + requests, `joinRejected` grew `notMember`.
  Invite emails are trimmed + lowercased by the schema on both sides, with
  one loose shape rule (`something@something`, no whitespace) — a typo is
  just a cancellable dead invite.
- **client (App.tsx, net/workspaces.ts)**: picker gained INVITES
  (accept/decline), YOUR JOIN REQUESTS (cancel), and a REQUEST TO JOIN
  by-name form; the creator's member modal gained JOIN REQUESTS
  (approve/deny), PENDING INVITES (cancel), and INVITE BY EMAIL; the join
  screen handles `notMember` with an in-place request-to-join (send +
  cancel). Picker copy updated — boarding is invite/approval-gated now.

Decisions made during implementation:

- `requestJoin` carries a **name**, not a slug; the server resolves it
  through `deriveSlug` (Q7). Slugs are fixed points of the derivation, so the
  join screen sends the URL slug through the same field.
- Email resolution for invite matching (`resolveEmail` in main.go) is
  **synchronous** on listPending/accept/decline/requestJoin — unlike the join
  path's async backfill — and creates the users row if missing, so a
  requester has an identity in the creator's panel before ever boarding.
- The **temporary default-workspace hack** in handleListWorkspaces was kept
  working by switching it from admitMember to createMembership. It now
  contradicts the documented invite-gated Membership model — flagged for an
  explicit decision on removal.
- Accepting requires the pending invite row to still exist (cancel wins the
  race); accepting when already a member resolves cleanly (Q13). Deletes
  (decline/cancel/deny) are idempotent.

Verification (all green):

- `go test ./...`, vitest (241 tests), `tsc --noEmit` both workspaces.
- New protocol tests: email normalization + shape rejection, requestJoin
  bounds, memberList/pendingList empty-array encoding (Go + TS).
- **Live e2e** (scripted ws client, two real clerk accounts, dev postgres):
  32 checks covering the notMember join gate, request → panel → approve →
  board, invite → picker → accept → board, ban interactions (invite refused
  `removed`, request refused `removed`, unban), alreadyMember refusals on
  both paths, uppercase-email lowercasing, invite-is-the-authorization
  (accept after cancel = notFound), idempotent cancels/declines/denies, and
  pending-artifact cleanup on membership creation.
- **Live UI pass** (browser, real clerk sign-ins): picker invite
  accept → workspace listed; request-by-name → pending row + cancel; join
  screen notMember → request sent in place; creator panel approve moved the
  requester to MEMBERS 2/20; invite form lowercased and listed the pending
  invite. Test users/workspaces/rows cleaned up.

## 2026-07-15 — grilling session (pre-implementation)

Grilled the plan against the code and CONTEXT.md; all questions answered in
plan.md's "Questions and Answers" section. No implementation yet.

Decisions made:

- Canonical term is **creator**, not owner; no new roles (Q1).
- Invites are keyed by **lowercased email**, matched against the account's
  clerk primary email at picker load; recorded as ADR 0003 (Q2, Q14).
- Surfaces: invitee/requester side lives in the **picker**; creator side
  (send/cancel invite, approve/deny request) lives in the existing
  creator-only **member panel** (Q3, Q4, Q5).
- `admitMember` becomes a pure gate (no auto-insert); non-members get a new
  typed `notMember` rejection and the join screen offers request-to-join.
  Existing members keep their persisted rows — no backfill needed (Q6).
- Join requests target the workspace **name**, resolved via the existing
  `deriveSlug` normalization (Q7).
- **Pending-only model**: one row per (workspace, email) / (workspace, user),
  every resolution deletes the row; no status history, no expiry; workspace
  deletion cascades (Q8).
- Verbs: invitee **accepts/declines** an invite, creator **approves/denies**
  a request, the author **cancels** their own artifact (Q9).
- Member cap (20) enforced only at membership creation (invite accept,
  request approval); invite sending is uncapped (Q10).
- Bans: banned accounts cannot request (`removed`); inviting a known-banned
  email is refused at send time and re-checked at accept; an invite is not
  an unban (Q11).
- Membership creation deletes both pending artifacts for that pair (Q12);
  stale accepts/approvals resolve idempotently (Q13).
- Docs updated: CONTEXT.md Workspace + Membership rewritten, Invite and Join
  Request added; ADR 0003 created (Q15).

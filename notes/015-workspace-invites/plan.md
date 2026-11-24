# workspace invite feature plan

## Overview

Users must be invited to a workspace to be able to join it.
Users that are already in a workspace before this change should remain members.
Going forward, users will not be able to auto-join a workspace just because they know the name of the workspace.

When a user is invited, after they log in, they should be able to see all the invites for them, and accept or deny them. Only the workspace owner can send invites. The invites can also be cancelled.

If a user knows the name of a particular workspace, they can request to join that workspace, unless they have already been banned from that workspace. A user can also cancel any of their own workspace join requests.

Out of scope: emailing or any type of notification outside of the app.

Update all progress and decisions made in @notes/015-workspace-invites/progress.md

## Questions and Answers

Answered by grilling the plan against the code and CONTEXT.md (2026-07-15).

**Q1. The plan says "workspace owner" — the glossary and code say "creator" (`created_by`, `notCreator`, `isCreator`). Which is canonical?**
Creator. "Owner" introduces a second word for the same concept with no new meaning. Everywhere the plan says owner, read creator. No roles are being added — creator remains the only privileged party, same as delete, map edit, and member management today.

**Q2. How does the creator address an invite, given the invitee may never have used the app and there are no notifications?**
By email address, stored lowercased. It is the only identifier a creator can actually know: user ids are internal, display names are not unique. The invite is keyed to the email (not a user id), and a signed-in account sees invites whose email matches its clerk primary email when it loads the picker. Consequence: an account with no email cannot be invited (it can still request to join). See ADR 0003.

**Q3. What does the invitee accept/decline against — where do invites surface?**
The picker at `/`. It is the only signed-in surface outside a workspace, and the plan scopes notifications out, so "after they log in they see their invites" means: the picker lists pending invites for the account's email, each with accept and decline. Accepting creates the membership (subject to ban and the 20-member cap) and the workspace appears in the picker list; it does not teleport them aboard — they board it like any listed workspace.

**Q4. Where does the creator send, cancel, and adjudicate?**
The existing creator-only member panel (notes/008 modal). It already gates on `ownedWorkspace` and shows members + banned; it grows three things: an invite-by-email input, a pending-invites list with cancel, and a pending-requests list with approve/deny. Non-creator members see none of this — the panel stays creator-only.

**Q5. The plan says users can request and cancel requests, but never says who decides them. Who does?**
The creator, from the member panel: approve creates the membership (ban + cap checked at that moment), deny deletes the request. Nothing else makes sense — the whole feature exists so only the creator admits people.

**Q6. What exactly changes for a non-member visiting `/w/:slug`?**
`admitMember` (db.go:423) stops inserting membership and becomes a pure gate: banned → `removed` (as today), member row exists → ok, otherwise a new typed rejection `notMember`. The join screen handles `notMember` by offering "request to join" in place, using the picker's one-shot socket pattern. Existing members are untouched: every account that ever boarded already has a persisted `workspace_members` row, so "current members remain members" is free — no backfill, no migration.

**Q7. A join request targets "the name of a workspace" — but names aren't the identifier, slugs are. What does the user type?**
The name, normalized through the same `deriveSlug` used at creation, then looked up by slug. Names are effectively unique modulo that derivation (creation rejects slug collisions), so this matches user intent without inventing a second lookup path. A request against a name that derives to nothing gets the existing `notFound` treatment; yes, this confirms a workspace's existence to anyone who guesses its name — the current join flow already leaks exactly that (`workspaceNotFound` vs other rejections), so nothing new is revealed.

**Q8. What is the lifecycle model — do invites/requests carry status (pending/accepted/denied) history?**
No status column, no history. One pending row per (workspace, email) for invites and per (workspace, user) for requests, primary-keyed so duplicates are impossible; every resolution — accept, decline, approve, deny, cancel — deletes the row. No expiry. Workspace deletion cascades both tables, same as members/bans/pods. Re-inviting after a decline and re-requesting after a deny are allowed; with no notifications, repeat spam costs the sender effort and the target nothing.

**Q9. The plan says the invitee can "deny" an invite — is that the same verb as denying a request?**
Sharpened: the invitee **declines** an invite; the creator **denies** a request; the artifact's author **cancels** their own (creator cancels an invite, requester cancels a request). Four outcomes, no overloaded verbs. CONTEXT.md now carries this vocabulary.

**Q10. When is the 20-member cap enforced — at invite send or at accept?**
At membership creation only: invite accept and request approval reuse the guarded insert that `admitMember` uses today, so a race can still land 21 (the existing guardrail-not-invariant stance, db.go:421). Sending invites is uncapped — capping pending invites adds a rule with no user-visible payoff, and an accept against a full workspace bounces with the existing `full` reason.

**Q11. Can a banned account be invited, or request to join?**
Request: refused with `removed`, same word the join gate uses today — the ban row is the single source of truth. Invite: sending to an email that maps to a banned account is refused at send time (only knowable when a users row exists), and acceptance re-checks the ban regardless, so the enforcement point stays single. An invite is not an unban — lifting a ban remains the explicit member-panel action.

**Q12. Both an invite and a join request exist for the same account and workspace — someone resolves one. What happens to the other?**
Membership creation deletes both pending rows for that (workspace, account/email) pair. Otherwise a stale request sits in the creator's panel for someone already aboard, and approving it would be a confusing no-op.

**Q13. Invitee is already a member, or the workspace vanishes before accept?**
Send-time: inviting an email that maps to an existing member is refused `alreadyMember` (when knowable); requesting a workspace you're in is refused the same way. Accept-time: the membership insert is idempotent (`ON CONFLICT DO NOTHING` semantics), so a stale accept still resolves cleanly and deletes the invite. A deleted workspace cascades its invites/requests away; an accept racing the delete gets `notFound`.

**Q14. The invitee changes their clerk email after the invite is sent — then what?**
The invite is matched against the account's current primary email only; invites to a stale address become unreachable and sit pending until the creator cancels and re-invites. Accepted cost: chasing email history or multiple addresses buys almost nothing at this scale and complicates the matching rule (the dev clerk app already has identifier quirks — see the phone_number note).

**Q15. What breaks in the glossary?**
Two entries were wrong the moment this plan was accepted: Workspace ("access is link-based, with no invites or roles") and Membership ("created automatically on first join... grants nothing beyond what the link already does"). Both are rewritten in CONTEXT.md, and Invite / Join Request are new terms there.

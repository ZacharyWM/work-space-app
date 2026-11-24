# Invites are keyed by email address, not user id

Workspace invites (notes/015) must reach people who may never have signed in,
and the app sends no external notifications — so the creator has to address
the invite with something they can actually know. User ids are internal and
display names are not unique; the email address is the only human-knowable
identifier. An invite row is therefore keyed by (workspace, lowercased email)
with no foreign key to users, and a signed-in account discovers its invites
by matching its clerk primary email when the picker loads.

## Considered Options

- **Key by user id**: rejected — restricts invites to accounts that already
  exist in the users table (i.e. have boarded some workspace before), and
  gives the creator no way to discover the id in the first place.

## Consequences

- An account with no email cannot be invited (it can still send a Join
  Request).
- Only the current primary email is matched: change the clerk email and
  invites to the old address sit pending until the creator cancels and
  re-invites. Deliberate — matching email history or secondary addresses
  complicates the rule for negligible payoff at this scale.
- Whether an invited email is "already a member" or "banned" is only
  enforceable at send time when a users row maps that email; acceptance
  re-checks bans and the cap regardless, so membership creation stays the
  single enforcement point.

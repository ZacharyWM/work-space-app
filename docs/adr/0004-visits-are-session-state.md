# Visits are session state, not memberships

Space Link (notes/018) lets a member of one workspace board a linked
workspace as a Visitor. A Visit creates no row in workspace_members and
nothing else persistent: the session keeps one home workspace (the one
boarded via URL/picker) and, while visiting, a current room that differs
from it. The URL always names home, so a refresh or fresh login re-boards
home — the "you always return to your own workspace" rule falls out for
free rather than needing cleanup logic.

## Considered Options

- **Ephemeral membership rows**: rejected — a temporary row in
  workspace_members would count against the member cap, surface in the
  member panel, trigger the pending-artifact cleanup that rides membership
  creation, and need reliable deletion on every exit path (disconnect,
  kick, crash). Modeling the visit outside the membership table keeps
  "Membership" meaning exactly one thing: a persistent, invited-or-approved
  belonging.

## Consequences

- Boarding has a second admission path: admitMember for members, a
  link-traversal check (link exists, not banned, visitor cap) for Visitors.
  Membership creation remains the single enforcement point only for
  *member* admission.
- A Visit's lifetime derives from two things and dies with either: the Link
  that admitted it, and the Visitor's home Membership. Removal flows must
  therefore find a user's live session in *other* workspaces' rooms, not
  just the one doing the removing.
- Traversal is never transitive: the portal always offers the home
  workspace's links, so every reachable workspace consented to a link with
  the visitor's own workspace. Showing the *visited* workspace's links
  would let strangers arrive through a link their workspace never held.

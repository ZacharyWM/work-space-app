# Space Link (workspace linking) feature plan

## Overview

Two Workspaces can be **linked**. A Link does not create Membership: members
of each side stay members of their own Workspace only, but while the Link
exists they may **Visit** the other side. Linking works like inviting a
person does today — if a creator knows another Workspace's name they send a
Link Request, which the other side's creator can accept or deny.

In app the feature is known as **Space Link**: a portal element on every
Map. Standing at it and pressing E opens an overlay where anyone aboard can
visit Workspaces linked to their home Workspace, and where the creator
additionally manages Links — requesting, accepting, denying, removing, and
blocking Workspaces.

A person always returns to their own Workspace: a Visit is session state
only, so logging out, exiting, or refreshing lands them back home. If the
Link that admitted a Visitor is removed, the Visitor is kicked back home.

Out of scope: notifications outside the app, transitive traversal, any
Visitor persistence beyond Leaderboard scores.

## Questions and Answers

Answered by grilling the plan against the code and CONTEXT.md (2026-08-31).
CONTEXT.md gained five terms (Link, Link Request, Space Link, Block,
Visitor); ADR 0004 records the session-state decision.

**Q1. Is a link symmetric or directional?**
Symmetric. One undirected edge per pair of Workspaces, established by
request + accept, removable by either side; removal cuts traversal in both
directions at once. Directional links would double the state and the
management UI, and the kick rule ("the link from their workspace is
removed") already reads as one edge dying.

**Q2. What does "Space Link" name?**
Three concepts were hiding in one name; they are now split, following the
Display Name / "callsign" precedent. **Link**: the edge between two
Workspaces — what gets requested, accepted, removed, blocked. **Space
Link**: the portal element on the Map, the surface for traversing and
managing Links, and the feature's in-app name. **Visitor**: a person aboard
a Workspace they hold no Membership in, admitted via a Link — the new
boarding state, and the term every later rule hangs off.

**Q3. Who manages Links — the plan said "anyone in a workspace"?**
The creator only, reversing the plan's original wording. Every existing
admission decision is creator-only (Invites, Join Request adjudication,
bans, the Map Editor), and accepting a Link admits a whole roster of up to
20 Visitors — a bigger admission decision than any Invite. Everyone aboard
traverses; only the creator requests, accepts, denies, removes, and blocks.
Loosening later is easy; tightening later is not.

**Q4. What is the portal, physically?**
A mandatory singleton with spawn-point semantics: every Map has exactly one
Space Link, the Map Editor may move it (it must sit on a Floor Plate,
validated like the spawn) but never delete it. A placeable-and-deletable
element (Game Table semantics) was rejected: a Map without a portal strands
the whole feature, and every pre-existing custom Map would be such a Map.
Existing Maps get a portal at a default position; the default ship map gets
one at an authored position in map.json.

**Q5. What does the portal offer — and can Visits chain?**
The portal always shows the Links of the person's **home** Workspace (the
one boarded this session), never the Links of the Workspace they stand in.
At home: pick a linked Workspace to Visit; the creator also sees
management. While visiting: the same list plus "return home" — so hopping
B→C is possible only when _home_ is linked to C, meaning every reachable
Workspace consented to a link with the visitor's own Workspace. No
transitive traversal, ever (see ADR 0004). Interaction is stand-at-it,
press E (Game Table precedent) — not trigger-on-touch, which would fire the
overlay on every accidental walk-through.

**Q6. What can a Visitor do aboard?**
Full live participation, zero persistent footprint. Yes: Zones and A/V,
Chat in all scopes, Screen Share, Meeting Mode, Status, Waves, Emotes,
Locate, Game Table lobbies — and their race times / kill counts land on the
visited Workspace's Leaderboard (it is keyed by Account, so this needs no
special case). No: Pod claims and Decor placing/moving/clearing — both
persist under the visited Workspace and belong to its crew. Map Editor and
member panel are creator-only already. Visitors show in the crew panel and
on the Map badged with their home Workspace's name, and never count toward
the 20-member cap (that cap is checked only at Membership creation, which a
Visit never performs).

**Q7. How does a visited Workspace defend itself, and where do kicked Visitors land?**
Bans gate Visits exactly as they gate boarding: `workspace_bans` has no
dependency on Membership, so the visited creator can ban an individual
Visitor — kicking them and blocking future Visits even while the Link
stands. A Link is not an unban, the sibling of "an Invite is not an unban".
A kicked Visitor (Link removed, banned, visited Workspace deleted) is
returned to their home spawn point. Two cases land at the picker instead:
home was deleted while they were out, or their home Membership was removed
— the right to Visit derived from that Membership, so the Visit dies with
it. Consequence: removal flows must find an account's live session in
_other_ workspaces' rooms, not just the room doing the removing (today's
kick machinery only searches its own room).

**Q8. What exactly does a Block do?**
A Block is the workspace-to-workspace sibling of a ban: directional
(A blocks B), creator-held, creator-lifted. While held, no Link may exist
between the pair in either direction — B's requests are refused as quietly
as a banned Account's, and A must unblock before requesting B. Placing a
Block deletes any pending request from the blocked side and removes an
existing Link (kicking Visitors both ways) — one action, no "blocked but
still linked" state. Unblocking restores nothing.

**Q9. Link Request lifecycle, addressing, and cap?**
Modeled on the Join Request. Addressed by typed Workspace name, resolved
through the same slug derivation as creation. Pending only: accept creates
the Link (subject to Blocks and the cap), deny deletes, the requester's
creator may cancel; every resolution removes the row, nothing expires,
nothing is emailed — the Space Link overlay is the sole surface (the picker
stays a person-level surface). No self-links; a request to an
already-linked Workspace is refused; an outbound request while an inbound
one is pending is refused and points at the inbound one — accepting stays
the one act that creates a Link. Cap: **10 Links per Workspace**, checked
at accept time only, the same guardrail-not-invariant stance as the member
cap.

**Q10. What is a Visit made of, session-wise?**
Pure session state — no persisted rows, no "last visited" memory (ADR
0004). The session carries a home Workspace (boarded via URL/picker) and,
while visiting, a current room that differs from it. The URL always names
home, so "identified by a slug; only members may board" stays true and a
refresh or fresh login re-boards home — the plan's return-home rule falls
out for free. The disconnect grace window resumes a Visit in place (same
session); only a fresh boarding resets to home. The one-session rule is
unchanged: boarding anywhere from another tab evicts the whole session,
Visit included.

**Q11. Visitors unbound room population — what about the A/V mesh?**
The 20-member cap is what made the P2P mesh viable (ADR 0001); 10 Links ×
20 members is a theoretical 200 concurrent Visitors. Guardrail: **at most
10 concurrent Visitors per Workspace**, checked live at traversal only —
the portal refuses "full". Members are never blocked from boarding their
own Workspace by Visitors; worst case aboard is 30, in line with what the
mesh already tolerates.

**Q12. What is recorded where?**
CONTEXT.md: Link, Link Request, Space Link, Block, Visitor added; no
existing entries needed rewriting (the "only members may board" sentence in
Workspace now has its one documented exception living in the Visitor
entry). ADR 0004 (visits are session state, not memberships) records the
rejected ephemeral-membership alternative, the two-lifeline kick rule, and
the no-transitivity consequence. The portal-as-singleton and both caps are
glossary facts following existing patterns — no ADR.

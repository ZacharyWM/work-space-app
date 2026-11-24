# Context

Glossary of domain terms for the virtual office. Terms are canonical: code,
docs, and conversation should use these words with these meanings.

## Terms

### Zone

A named, axis-aligned rectangular region of the Map (e.g. Bridge, Med Bay,
Cargo Hold). Standing inside a Zone connects your audio/video with everyone
else in your Workspace standing in that same Zone, and no one else. A person
is in at most one Zone at a time. Zone membership is determined by the server
from position.

### Open Space

Anywhere on the Map that is not inside any Zone. Being in Open Space is the
private state: no audio/video connections exist. There is no other privacy
mechanism.

### Map

The flat, one-level world layout. Defined as data (floor plates, Zones,
decor, spawn point), not code. Every Workspace starts on the shared default
Map (the ship in map.json); a Workspace's creator may replace it with a
custom layout via the Map Editor, and that layout persists in postgres.

### Map Editor

A full-screen overlay, available only to a Workspace's creator, for editing
that Workspace's Map: move/resize/add/delete Floor Plates and Zones, rename
Zones, flag Pods, move the spawn point. Saving replaces the Map for everyone
aboard immediately — the server re-derives every person's Zone membership
(and A/V pairing), frees Pod claims whose Zone is gone or demoted, and a
person whose floor vanished is returned to the spawn point. Both the editor and the server validate the same rules:
Zones stay disjoint, the spawn sits on a Floor Plate, and element counts and
coordinates stay bounded.

### Workspace

A named, isolated instance of the Map with its own roster and presence:
people in different Workspaces never see or hear each other. Identified by a
slug (in the URL); only members may board — Membership comes from creating
the Workspace, accepting an Invite, or an approved Join Request. Workspaces
are created in-app from the picker; an Account may have at most 5 it
created, and only the creator may delete one (anyone aboard is kicked, and
deletion frees a creation slot). The creator is the only privileged party;
there are no other roles.

### Membership

The record that an Account belongs to a Workspace. Created when the Account
creates the Workspace, accepts an Invite, or has a Join Request approved —
never automatically. It gates boarding and lets a Workspace list its crew;
the member cap (20) is checked when a Membership is created, nowhere else.

### Invite

A standing offer from a Workspace's creator to one email address, sent from
the member panel. Any signed-in Account whose primary email matches sees it
in the picker and may **accept** (creating the Membership, subject to bans
and the member cap) or **decline**; the creator may **cancel** it. Pending
only: every resolution removes it, nothing expires, and nothing is emailed —
the picker is the sole surface. An Invite is not an unban.

### Join Request

A signed-in Account's petition to join a Workspace it can name (the typed
name resolves through the same slug derivation as creation). The creator
**approves** (creating the Membership, subject to bans and the member cap)
or **denies** it from the member panel; the requester may **cancel** their
own. A banned Account cannot request. Pending only, like an Invite.

### Link

A symmetric edge between two Workspaces, established by a request from one
side and an acceptance by the other, and removable by either side. Managing
Links — requesting, accepting, removing, blocking — is the creator's alone,
like Invites and bans; traversing one is open to everyone aboard. While a
Link exists, members of each Workspace may Visit the other. A Link never
creates Membership. A Workspace holds at most 10 Links, checked when a Link
is created (accept time), nowhere else.

### Link Request

A creator's petition to link their Workspace to one they can name (the typed
name resolves through the same slug derivation as creation). The target's
creator **accepts** (creating the Link, subject to Blocks and the Link cap)
or **denies**; the requester's creator may **cancel**. Pending only, like an
Invite: every resolution removes it, nothing expires, nothing is emailed —
the Space Link overlay is the sole surface. No self-requests; a request to
an already-linked Workspace is refused; an outbound request is refused while
an inbound one from the same Workspace is pending (accepting stays the one
act that creates a Link).

### Space Link

The portal element on the Map (the in-app name for the feature). Every Map
has exactly one, like the spawn point: the Map Editor may move it (it must
sit on a Floor Plate) but never delete it. Standing at it and pressing E
(like a Game Table) opens the surface for traversing and managing Links. It
always offers the Links of the person's home Workspace — the one they
boarded this session, never the one they stand in — so a Visitor may return
home or hop only to Workspaces linked to home; there is no transitive
traversal. Management — requesting, accepting, removing, blocking — shows
only to the creator, and only at home.

### Block

A Workspace's standing refusal of another Workspace, held and lifted only by
the blocker's creator — the workspace-to-workspace sibling of a ban. While A
blocks B no Link may exist between them in either direction: B's link
requests are refused (as quietly as a banned Account's), A must unblock
before requesting B, and placing the Block deletes any pending request from
B and removes an existing Link (kicking Visitors both ways). Unblocking
restores nothing.

### Visitor

A person aboard a Workspace they hold no Membership in, boarded via a Link
from a Workspace they do belong to (their home Workspace this session).
Visiting is the one exception to "only members may board". A Visitor has
full live participation — Zones, A/V, Chat, Screen Share, Status, Waves,
Emotes, Game Table lobbies (their scores land on the visited Leaderboard) —
but may not claim Pods or place, move, or clear Decor Items: nothing they do
persists except scores. They show in the crew panel and on the Map badged
with their home Workspace's name, never count toward the member cap, and are
kicked when the Link that admitted them is removed. A Workspace hosts at
most 10 concurrent Visitors — checked at traversal only (the portal refuses
"full"), a guardrail bounding the A/V mesh, not an invariant; members are
never blocked from boarding their own Workspace by Visitors. Bans gate Visits exactly
as they gate boarding: the visited Workspace's creator may ban a Visitor
(kicking them, and blocking future Visits even while the Link stands — a
Link is not an unban). A kicked Visitor is returned to their home
Workspace's spawn point; if home itself is gone — deleted, or their home
Membership was removed — they land at the picker instead, since the right
to Visit derived from that Membership. A Visit is pure session state:
nothing is persisted, the URL keeps naming home (a refresh or fresh login
re-boards home), and only the disconnect grace window's resume returns a
Visitor to the visited room.

### Display Name

The name shown for a person everywhere they appear. Lives on their Account's
profile: defaulted from the Clerk account on first join, editable aboard in
the crew locker, persisted in postgres. Not unique. Theme copy may dress it
up (the spaceship theme calls it "callsign"), but the domain term is Display
Name.

### Account

A Clerk user. Signing in is the only way aboard (the shared room password is
gone). An Account owns a profile — Display Name plus saved character — keyed
by the Clerk user id. The profile is global: you look the same in every
Workspace. An Account holds one active session at a time, everywhere:
boarding any Workspace — from another tab, device, or the same Workspace
twice — ends its previous session, which is told why and cannot resume.

### Speaking

A presence state: a person is Speaking when their microphone is unmuted and
their local audio level crosses a threshold. Detected client-side, broadcast
to others as a boolean, and shown as visual feedback (avatar ring, tile
highlight). Only meaningful inside a Zone.

### Screen Share

A person's display capture, streamed to everyone in their Zone alongside their
camera. At most one person per Zone presents at a time (the UI locks the
button; the protocol tolerates races). Any change of the sharer's Zone stops
the share — a capture never follows a person into a new room.

### Meeting Mode

A client-only view toggle available inside a Zone: the Map view is replaced by
a grid of the Zone occupants' cameras, and an active Screen Share takes the
main stage. It carries no server state and does not affect who is connected to
whom — that is still Zone membership. Movement input is suppressed while it is
open. It opens automatically when a Screen Share starts in the Zone. Opening
it is also the one explicit act that keeps the local devices held while alone
in a Zone (see Device Privacy).

### Device Privacy

The microphone and camera are physically held (OS in-use indicators lit) only
when the toggle for that device is on AND transmitting is possible: someone
else is in the person's Zone, or they explicitly opened Meeting Mode.
Otherwise — device toggled off, alone in a Zone, in Open Space, or in flight —
the device is released entirely. The toggles keep the person's intent: when
company arrives, devices re-acquire automatically per the toggles.

### Status

A presence state a person sets for themselves: Available, Busy, or Away.
Purely informational — it changes nothing about Zones or A/V. It shows as a
colored dot (green/yellow/red) wherever the person appears: their canvas name
pill, the toolbar, and the crew panel. Everyone joins Available; a resume
keeps the pre-drop Status.

### Wave

A targeted one-shot ping from one person to another, sent from the crew
panel; anyone in your Workspace can be waved at, regardless of Zone or
distance.
Only the target receives it: a chime, a toast naming the waver, and a
locator ring around the waver's avatar. A Wave is an event, not state —
nothing is stored, so late joiners and resumes see nothing.

### Pod

A Zone flagged as claimable in the Map data (the ten ops pods). An Account may
claim one unclaimed Pod per Workspace by standing inside it; the claim
persists in postgres, so the owner's Display Name shows on the Pod even while
they are offline. Only the claimant may release it (a removed member's claim
is freed with the ban).

### Chat Message

A text message sent from the chat panel with one of three scopes: Ship
(everyone in the Workspace), Zone (the sender's current Zone occupants;
requires being in a Zone), or Announcement. The server stamps id, sender,
and time; the sender renders from the echo. The last 100 Ship-and-
Announcement-scoped messages are kept in memory per Workspace and arrive
with the welcome; Zone-scoped messages are live-only and never leave the
Zone. Nothing is persisted — chat dies with the room.

### Announcement

A Chat Message scope (the megaphone): delivered and retained like Ship
scope, but every client also shows a prominent banner and plays a chime,
sender included. Anyone may announce.

### Emote

A one-shot emoji reaction from a six-glyph palette, flashed above the
sender's avatar for a few seconds and relayed to the whole Workspace. An
event like a Wave — nothing stored, late joiners see nothing. Triggered by
number keys 1-6 or the toolbar picker.

### Locate

A client-local guide: pointing at a crewmate from the crew panel draws a
dashed line from your avatar to theirs with a pulsing ring at their feet
for six seconds. The target is never notified — unlike a Wave, locating is
a private act.

### Game Table

A point element of the Map (the spaceship theme calls it "holotable"),
placeable in the Map Editor, that must sit on a Floor Plate. Each Game Table
hosts one game, chosen when it is placed: Shuttle Race or Shuttle Blasters.
Standing at one and pressing E joins that game's lobby: members ready up, and
once every member is ready any member may start. A person holds at most one
lobby seat at a time (joining one game's lobby gives up a seat in the other).
A Map holds at most 4 Game Tables; a lobby holds at most 6. One Workspace
runs at most one race and one blasters match at a time, regardless of how
many Game Tables its Map has.

### Shuttle Race

The first Game Table game: every lobby member is teleported into a shuttle on
a start grid, and after a 3-second countdown races once around a loop of 8
gates generated around the Map's hull, passing them in order. Gate passes are
detected client-side; the server enforces their order and assigns finish
places and times. Racers hear each other (and no one else) on race comms.
Quitting, disconnecting, or a 5-minute cap DNFs a racer; when nobody is left
on the course everyone sees the standings and the lobby resets. The race
itself is an event, like a Wave, but each finisher's time feeds the
Leaderboard (a DNF records nothing).

### Shuttle Blasters

The second Game Table game: every lobby member (at least two) is teleported
into a shuttle on a spawn ring inside a circular arena generated around the
Map's hull, and after a 3-second countdown fights with lasers — one hit
destroys a shuttle, the destroyed are returned to where they joined from, and
the last shuttle flying wins. Hits are detected by the shooter's client; the
server checks both shuttles are alive and settles each elimination and the
standings. Fighters hear each other (and no one else) on match comms.
Quitting or disconnecting counts as an elimination; a 5-minute cap ends a
stalled match with the survivors tied on top. The match itself is an event,
like a Wave, but each player's kill count feeds the Leaderboard (an
elimination by forfeit or disconnect credits nobody).

### Leaderboard

A per-Workspace best-score list, one per Game Table game, persisted in
postgres: Shuttle Race keeps each Account's fastest finish time, Shuttle
Blasters each Account's highest kill count in a single match. An Account
appears at most once per list; the top 10 show in that game's lobby panel,
updated for everyone aboard whenever a race or match ends. Scores never
expire; the lists die with the Workspace.

### NPC

A decorative inhabitant of the Map — a robot dog or a humanoid robot —
placed in the Map Editor as a point element (at most 12, each anchored on a
Floor Plate). An NPC wanders the Floor Plates near its anchor on its own;
the wander is simulated per client (not synced), and NPCs say nothing, do
nothing, and carry no Zone, A/V, or game meaning.

### Decor Item

A prop anyone aboard may place on the Map — a desk, chair, plant, rug, lamp,
crate, arcade cabinet and so on, from a fixed library. Placed from the DECOR
tray in build mode: arm a kind and each click stamps one on a 20px grid; with
nothing armed, dragging a prop moves it and clicking one offers to resize or
clear it. Every prop carries a size, half to two-and-a-half times its authored
art — the tray's slider sets the size new props are stamped at, the picked
prop's slider resizes one already down.
Props draw back-to-front by the deck point they stand on, so a prop set on a
table's surface is covered by the table. Every prop also carries a stacking
nudge — the picked prop's BACK / FRONT buttons, bounded at 80px either way —
that biases only that order, never where the prop stands: nudge the monitor
forward and it sits over the table, while a crewmate walking past still covers
both.
A prop must stand on a Floor Plate, and may sit in any Zone except a Pod
somebody else has claimed — that Pod's props are the claimant's alone to move,
resize or clear. Everything else is communal: anyone may move, resize or clear
anyone's prop.
Decor Items persist in postgres per Workspace (300 max) and are separate from
the Map's own decor, which only the Map Editor changes; an edit that removes
the deck under a prop clears the prop. They are decorative only — no collision,
no interaction, no A/V or game meaning.

### Floor Plate

A walkable region of the Map. Avatars can only stand on Floor Plates;
everything outside them (the starfield) is unwalkable. Floor Plates constrain
movement; they carry no A/V meaning (that is what Zones are for).

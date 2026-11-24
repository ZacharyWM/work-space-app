# User statuses + wave — decisions and progress

## Decisions

1. **Status: `status` on the Player, a `status` message pair.** Mirrors
   `speaking`/`screenShare`: client sends `status {status}`, server stores it on
   the player (late joiners read it from the welcome roster) and broadcasts
   `status {id, status}`. Values are a closed enum: `available | busy | away`.
   Everyone joins `available`; a resume keeps the pre-drop status (like the
   character, unlike speaking/screenOn — a status is a deliberate setting, not
   a transient device state).

2. **Status is manual only.** No idle-detection auto-away — the plan asks for
   three visible statuses, and inferring "away" from input silence adds a
   client heuristic that can contradict what the user chose. Can be layered on
   later without protocol changes.

3. **Status visuals: colored dot everywhere a person appears.** Green =
   available, yellow = busy, red = away (per product direction; note this is
   the inverse of the Slack/Teams convention, where red means busy). The dot
   renders in the avatar's canvas name pill (visible to all), next to your own
   name in the toolbar, and in the crew panel roster. Colors come from
   theme.json (`ui.dot-on`, new `ui.dot-busy`, `ui.dot-off`) so the canvas and
   DOM read the same palette.

4. **Crew panel is the home for both features.** One new toolbar button (CREW)
   opens a right-side panel: your status selector on top, then every other
   person aboard — status dot, name, where they are (zone name / in flight /
   open space), and a WAVE button per row. A panel beats canvas-clicking for
   targeting because you can wave at anyone logged in, including people
   off-screen or in flight, and it doubles as the who's-aboard status list the
   plan asks for. It's a side panel, not a modal, so the map stays visible.

5. **Wave: targeted relay, no fan-out.** Client sends `wave {to}`; the server
   relays `wave {from}` to the target's socket only (same pattern as `signal`).
   Nothing is stored on the Player — a wave is an event, not state, so late
   joiners and resumes have nothing to inherit. Self-waves are dropped
   server-side.

6. **Wave delivery on the target: chime + toast + locator ring.** Three cues:
   a short two-tone chime synthesized with the Web Audio API (no asset files;
   the AudioContext unlocks on the join click, and `resume()` is called per
   chime in case the browser suspended it), a toast naming the waver
   ("KIRA WAVED AT YOU"), and an expanding sonar-style double ring around the
   waver's avatar on the canvas for a few seconds so the target can spot where
   the wave came from. The ring only renders for on-foot avatars; a waver who
   is mid-flight is still named by the toast.

7. **Sender feedback + spam control are client-side.** The row's WAVE button
   flips to "SENT" and disables for a short cooldown after each wave. No
   server-side rate limiting — same trust level as every other relayed message
   in this app (pos, speaking, signal).

## Progress

- [x] Design recorded (this file)
- [x] Protocol: `status` on player, `status` + `wave` messages both directions + tests
- [x] Server: store/broadcast status, relay wave + tests
- [x] Theme: `ui.dot-away` amber
- [x] Client: connection roster handling + onWave handler
- [x] Client: wave chime module
- [x] Client: canvas status dot in name pill + wave locator ring
- [x] Client: CrewPanel (status selector + roster + wave buttons)
- [x] Client: Hud CREW button + own status dot; App wiring (status state, wave toast)
- [x] Typecheck + tests green (138 tests, 10 files)
- [x] Verified in browser against live headless peers (see below)
- [x] CONTEXT.md: Status + Wave glossary entries

## Verification

Browser session (Nova) + headless WS clients (Rook, Vega, Kite, Echo, Pip)
speaking the real protocol against the dev server:

- Statuses flow both ways: Rook's `status busy` showed as a red dot in Nova's
  crew panel row; Nova's BUSY pick reached Rook's socket
  (`status: Nova -> busy`) and lit the toolbar dot + her canvas pill red.
  Welcome rosters carried statuses to late joiners.
- Waves flow both ways: Nova's WAVE button delivered `wave from` to Rook's
  socket only; incoming waves raised the "PIP WAVED AT YOU" toast and the
  expanding accent ring around the waver's avatar (screenshot-confirmed).
  The row button reads SENT during its cooldown. Waving works from open
  space across zones — no zone requirement.
- Crew panel locations track the roster: OPEN SPACE / zone name (MED BAY,
  OPS POD F) per player; CREW · N count follows joins and leaves.
- Refresh-resume kept the BUSY status (Hud received status "busy" after the
  reconnect); fresh joins start AVAILABLE.
- Chime not audible in the automated run (no speakers to observe); the code
  path runs without console errors — worth one human listen.

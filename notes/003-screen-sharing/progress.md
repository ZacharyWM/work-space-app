# Screen sharing + meeting mode — decisions and progress

## Decisions

1. **Transport: third pre-negotiated m-line, no renegotiation.** The peer manager
   already avoids renegotiation by keeping every video m-line send-capable and
   swapping tracks with `replaceTrack` (cam toggle). Screen sharing reuses that
   exact pattern: every connection is negotiated with three m-lines — audio,
   camera video, screen video — in that fixed order. Starting/stopping a share is
   a bare `replaceTrack` on the second video transceiver. The receiver tells the
   two video tracks apart by m-line order (first video transceiver = camera,
   second = screen), which the WebRTC association rules make stable on both sides.

2. **Presence: `screenOn` on the Player, a `screenShare` message pair.** Mirrors
   `speaking`: client sends `screenShare {on}`, server stores it on the player
   (late joiners read it from the welcome roster) and broadcasts
   `screenShare {id, on}`. A resume clears it — a display capture never survives
   a reconnect.

3. **Share is zone-scoped and client-stopped.** The SHARE button only works
   inside a zone. Any change of the sharer's zone (walking out, walking into a
   different zone, boarding a shuttle) stops the capture client-side — carrying
   a live screen into a room of new people without an explicit act would be a
   privacy surprise. Enforcement stays client-side: pairing already tears down
   the media paths on zone exit, so a stale flag can't leak pixels.

4. **One presenter at a time (softly).** The SHARE button is disabled while
   someone else in the zone is sharing ("presenting" model, like real meeting
   tools). The protocol tolerates overlap from races; displays resolve it by
   picking the first sharer in roster (join) order so every client agrees.

5. **Meeting mode is a client-only overlay.** No server state — it's a view
   toggle (`MEETING` in the toolbar, available inside a zone). It covers the
   canvas with a grid of camera tiles for everyone in the zone; when a screen
   share is active the screen takes the main stage and cameras collapse into a
   right-hand strip. The bottom toolbar stays visible (mic/cam/share/exit all
   still work). WASD input is suppressed while in meeting mode so you can't
   blindly wander out of the zone; leaving the zone by any other means (nobody
   else can move you, but a resume/dock can) exits meeting mode automatically.

6. **Auto-enter on share start.** When anyone in your zone (you included)
   starts sharing, meeting mode opens — the point of presenting is that people
   see it, and requiring every viewer to notice a badge and click is friction.
   "SHIP VIEW" (or the MEETING toggle) pops back out at any time; the share
   keeps running.

7. **Screen capture is video-only** (`getDisplayMedia({video: true})`). System
   audio capture is flaky across platforms and browsers; skipped. The browser's
   own "stop sharing" bar ends the share via `track.onended`, same as the
   toolbar button.

8. **Tiles row shows a SHARING badge** on the sharer's tile when you're in the
   ship view, so a share that started while you were out of meeting mode is
   still discoverable.

9. **OS-permission failures are guarded and surfaced.** Found via a real macOS
   run: when the browser lacks the OS Screen Recording permission, Chrome's
   picker re-prompts macOS repeatedly on its own (it keeps polling screen
   thumbnails), and the permission only takes effect after relaunching the
   browser. Two app-side hardenings came out of it: `LocalScreen.start()` holds
   a pending flag so extra SHARE clicks can't stack concurrent
   `getDisplayMedia` calls (each one re-prompts the OS), and an OS-level
   refusal (Chrome's `NotAllowedError` with "denied by system", distinct from
   a picker cancel) raises a dismissable HUD notice naming the Privacy &
   Security switch to flip — otherwise SHARE just looks silently broken.

## Progress

- [x] Design recorded (this file)
- [x] Protocol: `screenOn` on player, `screenShare` client/server messages + tests
- [x] Server: store + broadcast, clear on resume + tests
- [x] Client: peer manager screen m-line + remote screen streams
- [x] Client: `LocalScreen` capture module
- [x] Client: App wiring (share lifecycle, zone-exit stop, auto meeting)
- [x] Client: Hud SHARE + MEETING buttons
- [x] Client: MeetingView overlay
- [x] Client: stage key suppression in meeting mode
- [x] Typecheck + tests green (128 tests, 10 files)
- [x] Verified in browser (see below)
- [x] CONTEXT.md: Screen Share + Meeting Mode glossary entries

## Verification notes

Driven in the dev preview with one real client (Nova) plus a scripted raw-WS
second player (Zed):

- SHARE/MEETING disabled in open space with explanatory titles; both enable on
  zone entry (server-echoed zone flip).
- MEETING opens the overlay (header, camera grid, SHIP VIEW), toolbar stays
  usable, and WASD is suppressed while it's up (keydown not consumed).
- Zed joining the zone appears in the grid ("2 PRESENT").
- Zed's `screenShare on` auto-opens the meeting view from ship view, shows the
  presenter stage ("ZED · SHARING", "CONNECTING SCREEN…" until a track arrives)
  with the camera strip on the right, and locks SHARE ("Someone else is
  presenting"). `screenShare off` returns the grid and re-enables SHARE.
- Zero console warnings/errors throughout.
- An in-page RTCPeerConnection self-test replicated createEntry/applySignal
  (addTrack cam + recvonly audio + screen transceiver last; answerer with its
  own cam addTrack'd, recvonly→sendrecv fixup, later screen replaceTrack):
  both sides negotiated m-lines `video,audio,video`, the camera was the first
  video transceiver and the screen the second on both ends, ontrack routed
  cam vs screen correctly both ways, and the answerer's late replaceTrack
  landed on the screen m-line.

Decision 9 hardening, verified with stubbed `getDisplayMedia` in the preview:
three rapid SHARE clicks produce exactly one `getDisplayMedia` call; a
"Permission denied by system" rejection shows the blocked notice (and click
dismisses it); a plain picker cancel ("Permission denied") shows nothing.

Not exercised end-to-end (needs two real browsers + a physical display
picker): actual getDisplayMedia pixels flowing peer to peer. The transport
path it rides is exactly the verified negotiation above plus the same
replaceTrack mechanics the existing cam toggle uses in production.

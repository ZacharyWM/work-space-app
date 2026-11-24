# A/V Smoke Checklist

Repeatable manual run of the A/V checks from implementation steps 3.1–3.6.
This is the M3 gate: run it with 2–3 clients, **at least one on a different
machine/network** — same-host WebRTC always connects and hides NAT issues,
and headless fake audio can't prove audible playback.

Rerun after any change to `client/src/media/`, the pairing logic
(`server/src/pairing.ts`), or the signal relay. Also the base for the 5.5
production smoke.

## Setup

1. On the host machine: `npm run dev`. The server listens on 3000; note the
   vite port it prints.
2. Vite binds localhost only. For a second machine, expose it:
   `npm run client:dev -- --host` (server needs no flag — `ws` binds all
   interfaces). The client dials `ws://<page hostname>:3000`, so loading the
   page from the host's LAN IP reaches the right server automatically.
3. getUserMedia requires a secure context. `http://<LAN-IP>` is not one, so
   the remote machine boards with no devices unless you launch its Chrome
   with `--unsafely-treat-insecure-origin-as-secure=http://<LAN-IP>:<vite-port>`
   (or front the dev servers with an https tunnel). Localhost clients are
   unaffected.
4. Open devtools consoles everywhere — peer `connectionState` transitions
   are logged there and several checks read them.
5. Clients: A and B on different machines/networks (mic + cam granted),
   C anywhere (third browser or profile; separate profiles/browsers so
   permissions don't bleed).

## Checks

Every client boards with mic and cam on unless a check says otherwise.
A check passes only if every listed observation holds.

### 1. Denied device still boards (3.1)

- On C, deny the camera permission (or join from a machine without one),
  then board.
- Pass: C lands aboard; its HUD shows CAM OFF; A and B see C's tile (once
  co-zoned) as initials + CAM OFF, never a black video.

### 2. Shared-zone connect (3.4)

- A and B (the cross-network pair) walk into the same zone.
- Pass: consoles on both log the pair reaching `connected`; each hears the
  other talk and sees the other's live video tile within a couple seconds.
  Audio must be audible, not just bytes in stats.

### 3. Teardown on exit (3.4)

- B walks out of the zone into open space.
- Pass: both consoles log the connection closing; audio stops on both
  sides; B's tile row clears entirely and A's row drops to just "You".

### 4. Re-enter reconnects (3.4)

- B walks back into A's zone.
- Pass: a fresh connection reaches `connected`; audio and video flow again
  both ways.

### 5. No connections in Open Space (3.4/3.5)

- A and B stand near each other in open space (no zone).
- Pass: no peer connection is created (nothing new in the consoles), no
  tile row renders, no audio flows; the OPEN SPACE — PRIVATE label shows.

### 6. Instant mute (3.1/3.5)

- Co-zone A and B. B toggles mic off, talks, then toggles back on.
- Pass: A hears B cut off immediately on mute; MUTED badge appears on B's
  tile for A (and B's self tile) within ~half a second; unmute restores
  audio and clears the badge.

### 7. Cam-off tile (3.5)

- B toggles cam off, then on.
- Pass: B's tile flips to initials + CAM OFF everywhere (including B's own
  self tile) and back to live video on re-enable; audio is uninterrupted
  throughout.

### 8. Speaking ring (3.6)

- B talks in a shared zone, then stops; then talks while muted.
- Pass: B's avatar ring pulses and B's tile border/dot light in accent on
  A's screen within ~200ms of speech onset; they clear shortly after B
  stops; while muted nothing lights anywhere; steady background noise
  (fan, hum) does not flicker the ring.

### 9. 3-person mesh (3.5)

- A, B, and C all enter the same zone.
- Pass: each client shows 3 tiles — self first ("You"), then the others in
  join order; everyone hears both others; each mute/cam toggle is reflected
  on the right tile on all three screens; one client walking out drops the
  other two to 2 tiles while its own row behavior matches check 3.

## Recording a run

Note the date, the client mix (machines/networks/browsers), and any check
that failed with what was observed. A gate run passes only when all nine
checks pass in one session.

# Clerk Auth — Progress

## Status

Done and verified end to end. Clerk auth replaces the room password,
postgres stores user profiles (display name + character). Typecheck and all
138 tests pass. Live acceptance run (dev servers, throwaway clerk user,
sign-in-token ticket flow): signed-out shows clerk's sign-in card; signed-in
boards with a token; first join creates the db row named from the clerk
account; rename + shirt edit persist; exit + fresh join loads both back from
the db. Test user and its row deleted afterwards.

## Decisions

1. **Client SDK is `@clerk/clerk-react`, server verification is
   `@clerk/backend`.** The setup prompt is Next.js-flavored; this app is a
   Vite React SPA talking to a bare `ws` server, so there is no middleware,
   no `auth()`, no proxy matcher. The join screen renders Clerk's `<SignIn />`
   when signed out and the board card (with a `UserButton` account chip) when
   signed in.

2. **The WS `join` message carries a Clerk session token instead of a
   password.** The server verifies it with `verifyToken` (secret key from
   `CLERK_SECRET_KEY`); the token's `sub` is the Clerk user id. Session
   tokens expire in ~60s, so the client mints a fresh one per join attempt
   via `getToken()`. Rejections use one typed reason, `unauthorized`
   (replacing `wrongPassword`).

3. **The pre-auth `config` probe message is gone.** It existed only to tell
   the join screen whether a password field was needed. `passwordAccepted`,
   `ROOM_PASSWORD`, and the probe socket are all deleted.

4. **Resume keeps its capability-token semantics.** A resume within the
   grace window proves ownership with the server-minted resume token and does
   not re-verify Clerk (the session already carries the user id). Deliberate
   EXIT still forfeits the token.

5. **Postgres via `pg`, one `users` table, schema ensured on startup.**
   `id text primary key` (clerk user id), `display_name text`, `character
   jsonb`, timestamps. One table did not justify a migration tool. Dev
   default `DATABASE_URL` is `postgres://localhost:5432/deep-space`; the local
   `deep-space` db was created with `createdb`, and `server/.env` pins
   `DATABASE_URL=postgresql://<local user>@localhost:5432/deep-space`.

6. **Display name and character live on the profile, not the device.** The
   join screen's callsign field is gone — the client cannot know its db
   profile before authenticating over the ws, so the profile arrives with the
   welcome roster. First join defaults the name from the Clerk account
   (first name → username → email local part → "Crew Member") and the
   character to the palette default. The crew locker gained a CALLSIGN field;
   a new `rename` client message (trimmed, 1–32 chars) updates the roster,
   broadcasts a `rename` server message, and persists. `character` edits now
   persist server-side too; the localStorage copy (`client/src/character.ts`)
   is deleted.

7. **Profile writes are fire-and-forget.** The in-memory roster stays the
   session's truth; a failed db write is logged and the room keeps moving.
   Reads (join) are awaited — a join without a profile would board the wrong
   identity.

8. **One account may board from several tabs.** Each connection is still its
   own player (own id, position, A/V); they share one profile row. Last
   write wins on concurrent character/name edits — acceptable for a tool
   whose users are trusted colleagues.

9. **Server sockets stay pure ws.** No HTTP surface was added; everything
   rides the existing message protocol.

10. **Join handling went async.** Token verification + db reads happen in an
    async block guarded by a `joining` flag (no double-join during the await)
    and a post-await `readyState` check (no session created for a socket that
    died mid-verification, which would have leaked past the heartbeat).

11. **Renames need an explicit hud rerender.** Found during the live run:
    the server never echoes your own rename (the no-echo broadcast pattern),
    and the locker mutates the roster entry in place, so the toolbar name
    went stale. `CrewLocker` now takes an `onRename` callback and the hud
    bumps a version state.

## Env + deploy

- Dev: `server/.env` (`CLERK_SECRET_KEY`, optional `DATABASE_URL`) loaded via
  tsx `--env-file-if-exists`; `client/.env.local`
  (`VITE_CLERK_PUBLISHABLE_KEY`) read by vite. Both gitignored.
- Prod: add `CLERK_SECRET_KEY` + `DATABASE_URL` to `/etc/workspace.env`,
  drop `ROOM_PASSWORD`; install postgres on the droplet (README one-time
  setup updated). The client build bakes the publishable key in at
  `deploy.sh` build time from `client/.env.local` on the dev machine.
- Open question for prod: the app id in the setup prompt is a dev instance;
  production should use the Clerk production instance's keys when this
  deploys for real.

## Setup log

- clerk CLI installed globally via npm.
- `clerk auth login` timed out four times (the browser oauth popup never
  reached a human); keys were placed manually instead —
  `client/.env.local` (`VITE_CLERK_PUBLISHABLE_KEY`) and `server/.env`
  (`CLERK_SECRET_KEY`). `clerk init` was skipped; nothing it scaffolds was
  still needed.
- local postgres 17 (homebrew) already running; db renamed to `deep-space`
  (the original empty `workspace` db was dropped).
- the clerk instance (named "Deep
  Space") requires a phone number on user creation — set in the clerk
  dashboard sign-up settings; loosen it there if phone-less sign-ups are
  wanted.

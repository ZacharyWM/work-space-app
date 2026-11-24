# 016 — Product Launch Plan

Turn the virtual office into a paid product: Clerk Billing subscriptions at
$3/mo, a marketing home page at `/`, the app moved to `/app`, workspace
routes unchanged at `/w/{slug}`.

## Verified current state

Facts checked against the code, not assumed:

- **Routing is hand-rolled in the SPA.** No router library. `App.tsx` derives
  the route from `location.pathname`: `/` renders the picker (or Clerk
  `<SignIn />` when signed out), `/w/:slug` renders the join/board flow
  (`client/src/App.tsx:157-165`, `slugFromPath`). Navigation is
  `history.pushState` (`App.tsx:858,870`).
- **The backend is WebSocket-only.** The Go server's single HTTP handler
  upgrades every request to a WS (`server/main.go:154`). Even picker
  round-trips (list/create workspace) are one-shot sockets
  (`client/src/net/workspaces.ts`). There are **zero plain HTTP endpoints**.
- **Auth is a Clerk session token verified per-message.** The server verifies
  the JWT against Clerk's JWKS and extracts only `sub`
  (`server/auth.go:37-62`, `verifyClerkToken`). Claims beyond the subject are
  currently discarded.
- **Existing limits already look like a paid tier:** 5 created workspaces per
  Account, 20 members per workspace (CONTEXT.md: Workspace, Membership).
- **Prod:** Caddy on the DO droplet serves `client/dist` with SPA fallback
  and proxies `/ws` to the Go server (`deploy/Caddyfile`); domain is
  the production domain (an older domain redirects). The Clerk instance in use is a
  **development** instance.

## Verified Clerk Billing facts (docs, July 2026)

- Clerk Billing (B2C flavor) charges **0.7% of billing volume on top of
  Stripe's 2.9% + $0.30**. Requires a real Stripe account; dev uses a
  separate Stripe sandbox account. USD only, **no tax/VAT support, no
  refund flow** through Clerk.
- Plans/Features are defined in the Clerk dashboard. Client-side: the
  `<PricingTable />` component and `has({ plan: "slug" })` checks.
- Session token **v2** carries billing claims: `pla` (active plan, format
  `u:planslug` for user-scope) and `fea` (enabled features). Our Go server
  already verifies the session token, so it can gate **networklessly** by
  reading `pla` from the verified claims — no Clerk API call per message.

## The big design fork (answer before anything else)

Clerk B2C billing attaches the subscription to an **Account**, not a
Workspace. The `pla` claim in a message tells the server the plan of the
Account **sending that message** — only. So:

- Gating what an Account can *do itself* (create workspaces, raise its own
  caps) is trivial and networkless.
- Gating a workspace by its **creator's** subscription (e.g. members can't
  board a lapsed creator's workspace) requires the server to know a
  *different* Account's plan. That means Clerk **billing webhooks** into
  postgres — and the Go server has no HTTP endpoints today, so a webhook
  endpoint (with svix signature verification) plus a Caddy route would be
  new infrastructure.

Pick the model first; it determines about half the work below.

## Questions to answer (each with a recommendation)

### Q1. Who is the paying customer?

Options: (a) every Account pays $3/mo to use the app at all; (b) the
workspace **creator** pays, invited members ride free; (c) freemium — free
tier with tight limits, paid lifts them.

**Recommendation: (b)+(c) combined — creator pays, members free, with a
free tier.** A 20-person team where every member must individually
subscribe ($60/mo coordinated across 20 people) will not convert. The buyer
is the person who organizes the space. A free tier lets people try it and
lets invited members exist without a card.

Pushback on (a): it also breaks the invite flow — an invitee hitting a
paywall before they can accept an invite kills the growth loop.

### Q2. What exactly does free get, and what does $3/mo unlock?

The current caps (5 workspaces, 20 members) become the *paid* tier. Free
needs new, tighter caps.

**Recommendation:** Free = 1 created workspace, 5 members. Paid ($3/mo) =
current limits (5 workspaces, 20 members). This maps cleanly onto the two
existing enforcement points: workspace-count check at `createWorkspace` and
member-cap check at Membership creation — both already server-side, both
reachable from the acting user's own `pla` claim (creation) or the
creator's stored plan (member cap, see Q3).

### Q3. What happens when a subscription lapses?

The creator cancels or payment fails. Their 5 workspaces with 20 members
each — deleted? locked? read-only?

**Recommendation: nothing is deleted; over-cap workspaces become
"suspended" — members can't board until the creator resubscribes or the
workspace fits free limits.** Deleting user data on a failed card is how you
get hate mail. But note: enforcing this at *boarding time* requires knowing
the creator's plan server-side → webhooks → postgres (the design fork
above). If you want to defer webhooks for v1, the honest alternative is:
lapse only blocks *new* workspace creation and *new* member additions, and
existing workspaces keep working. That is a weaker paywall but ships with
zero new infrastructure. Decide which.

### Q4. Are existing users grandfathered?

You have real workspaces in prod today.

**Recommendation: yes, quietly.** At launch, mark existing Accounts (or
just their existing workspaces) as exempt from the new free-tier caps.
Cheap goodwill; they are your first testimonials. Implementation: a
`created_before` cutoff in the limit checks, nothing fancy.

### Q5. Marketing page: inside the SPA or a separate static page?

The SPA is client-rendered — crawlers and link previews get an empty
`#root`. Marketing pages live or die on SEO and social cards.

**Recommendation: a separate static `index.html` (plain HTML/CSS, no
React) served by Caddy at `/`, with the SPA moved to `/app` and `/w/*`.**
Caddy routes: exact `/` → marketing file; `/app*` and `/w/*` →
SPA fallback. This keeps the marketing page fast, crawlable, and decoupled
from app deploys. The Vite dev-server story needs a small tweak (serve the
static page at `/` in dev too, or just develop it as a separate file).

### Q6. Should `/` redirect signed-in users into the app?

**Recommendation: no auto-redirect.** Marketing page shows "Open app" (and
"Sign in") buttons; `/app` is the app entry. Auto-redirects fight with
logged-in users who want to see pricing, and a static page can't check
Clerk sessions without pulling in ClerkJS anyway. Old bookmarks to `/`
now land on marketing — acceptable; bookmarks to `/w/slug` still work.

### Q7. Is $3/mo actually the right price point?

Per-transaction fees are fixed: Stripe $0.30 + 2.9% + Clerk 0.7% ≈ **$0.41
of every $3 charge (13.6%)**. Annual billing amortizes the fixed fee:
$30/yr loses ~$1.38 (4.6%).

**Recommendation: keep $3/mo as the anchor but add a $30/yr option and
nudge toward it in the pricing table.** Also consider whether $3 is too
cheap to signal quality for a team tool — $5/mo per creator would still be
far below Gather ($7/user/mo) and roughly doubles margin. Decide: $3 or $5.

### Q8. What is the product's name and brand?

The marketing page needs a name, and the production domain is currently just a
domain. CONTEXT.md calls it "the virtual office"; the theme is a spaceship.

**Recommendation: brand it as "Blippy" (you own the domain, it's
memorable) and keep the spaceship theming as the identity.** If you hate
that, decide the name *before* writing the marketing page, Clerk production
instance branding, and plan names — renaming later touches all three.

### Q9. Clerk production instance — when and with what?

Prod currently runs a Clerk **development** instance: capped at 100 users,
"development mode" badge on auth UI, dev keys. A production instance needs
DNS records on the production domain (CNAMEs for the frontend API / accounts
subdomain), fresh publishable/secret keys in the droplet env, and real
OAuth credentials (dev instances use Clerk's shared ones).

**Recommendation: do this first, before billing work.** Billing on a dev
instance only ever talks to a Stripe sandbox; you cannot take real money
until the production instance exists. It is also the piece with external
DNS/OAuth lead time.

### Q10. Terms of service and privacy policy?

Taking payments without ToS/privacy pages is asking for chargeback and
compliance trouble; Stripe also expects them. Clerk provides no tax
handling — at your scale, US sales tax on a $3 SaaS is likely below
thresholds, but it is your problem, not Clerk's.

**Recommendation:** write minimal ToS + privacy pages, link them from the
marketing page footer and the Clerk sign-up flow. Don't overthink v1.

## Implementation phases

Each phase is independently shippable, in this order.

### Phase 1 — Clerk production instance (unblocks everything)
1. Create production instance in Clerk dashboard; add DNS records; set
   production keys in droplet env and `client/.env` build. → verify: prod
   sign-in works with no dev badge; dev instance still works locally.
2. Configure OAuth providers with real credentials.

### Phase 2 — Route split + marketing page
1. Static marketing page (name, screenshots/demo GIF, pricing, ToS/privacy
   links, "Open app"). New file(s), e.g. `client/marketing/`.
2. Move SPA entry: `slugFromPath` untouched; picker moves from `/` to
   `/app` (`App.tsx` route derivation + the two `pushState` calls +
   `toPicker`). Clerk `<SignIn />` config unchanged (component-based, no
   route pages).
3. Caddy: `/` → marketing, `/app*` + `/w/*` → SPA `index.html`, `/ws` →
   server, unchanged. Update `deploy.sh` to ship the marketing file.
   → verify: `/` serves marketing with real `<title>`/OG tags via curl;
   `/app` boards a workspace end-to-end in prod.

### Phase 3 — Billing plumbing
1. Dashboard: enable Billing, connect Stripe, define plans (`free`,
   `pro` at $3/mo + $30/yr per Q7) with features matching Q2 limits.
2. Client: pricing/upgrade surface using `<PricingTable />` (in the picker
   and on the marketing page as static copy), `has({ plan })` for UI state.
3. Server: extract `pla` from the already-verified session claims
   (`server/auth.go` — return claims, not just `sub`); enforce Q2 limits at
   `createWorkspace` and membership creation. → verify: Go tests for
   free/pro caps; sandbox-Stripe upgrade flips the cap live (token refresh
   is ~60s, so propagation is fast).
4. Grandfathering per Q4 (cutoff in the limit checks + test).

### Phase 4 — Lapse enforcement (only if Q3 chooses "suspend")
1. First HTTP endpoint on the Go server: `POST /webhooks/clerk` with svix
   signature verification; persist each Account's plan in postgres.
2. Boarding check consults the creator's stored plan. Caddy route for the
   webhook path. → verify: replayed webhook fixture flips a workspace to
   suspended; boarding is refused with a typed reason the client shows.

### Phase 5 — Launch polish
ToS/privacy pages, support email, Stripe receipt branding, announcement.

## Risks and roadblocks

1. **Fixed fees eat 13.6% of a $3 monthly charge.** Push annual. (Q7)
2. **Prod is on a Clerk dev instance** — 100-user cap and no real payments
   until Phase 1 happens. DNS/OAuth setup has lead time and a brief auth
   cutover risk for existing users (sessions won't carry over; everyone
   signs in again).
3. **`pla` claim requires session token v2.** Older instances may issue v1
   tokens; verify the token version on the new production instance before
   building server gating around `pla`.
4. **Creator-based gating needs webhooks**, and the server has never
   spoken plain HTTP. Contained but genuinely new surface (svix
   verification, replay protection, Caddy route, postgres table). Don't
   let it sneak into v1 silently — it's why Q3 matters.
5. **Mid-session lapse is unenforceable cheaply.** Gating happens at
   join/creation; an already-boarded session outlives a cancellation until
   the next join. Accept this; don't build live eviction.
6. **No tax/VAT and USD-only from Clerk Billing.** International customers
   pay in USD; tax compliance is yours. Fine at launch scale, revisit if
   revenue grows.
7. **Single droplet.** Every paying customer's A/V is P2P (docs/adr/0001)
   so media doesn't hit the server, but TURN relay bandwidth does for
   NAT-unlucky users — a cost that scales with paid usage. Monitor before
   it surprises you.
8. **SPA SEO** is solved only if Q5 chooses the static page; a
   React-rendered marketing route will look blank to crawlers.

## Glossary impact (CONTEXT.md)

New terms to add once Q1–Q3 are answered: **Plan** (free/pro, attached to
an Account), and possibly **Suspended** (workspace state, only if Q3
chooses it). "Account" stays as-is — the subscription hangs off it.
Candidate ADR after Q3: "account-scoped billing with webhook-synced plan
state" — hard to reverse, surprising later, real trade-off. Skip the ADR
if Q3 lands on the no-webhook version.

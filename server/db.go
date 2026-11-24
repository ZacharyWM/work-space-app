// user profiles, workspaces, memberships, bans, pod claims, and owner-edited
// maps in postgres (port of server/src/db.ts). Same schema and statements as
// the TS server — an existing database keeps working untouched
package main

import (
	"context"
	"encoding/json"
	"errors"
	"regexp"
	"slices"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	gonanoid "github.com/matoous/go-nanoid/v2"
)

// what the join flow needs from the users row
type userProfile struct {
	displayName string
	character   Character
}

// one workspace as the join/list flows need it; id keys the room registry,
// slug rides the URL, createdBy marks the owner — the only account allowed to
// edit the map
type workspaceRecord struct {
	id        string
	slug      string
	name      string
	createdBy string
}

// a picker list row: the record plus whether the listing user created it —
// only creators may delete
type workspaceListing struct {
	workspaceRecord
	mine bool
}

// hard cap on workspaces one account may have created (and not deleted);
// enforced inside the create statement so concurrent creates can't blow past
// it by much, and freed by deleteWorkspace
const maxWorkspacesPerUser = 5

// hard cap on members per workspace: gates only *new* memberships inside
// admitMember's insert — existing members always board. Removing a member
// frees a slot; a guardrail, not an invariant
const maxMembersPerWorkspace = 20

// hard cap on Links per workspace (space link feature, Q9): gates only the
// insert at accept time — the same guardrail-not-invariant stance as the
// member cap. Removing a Link frees a slot
const maxLinksPerWorkspace = 10

// non-alphanumeric runs collapse to single hyphens
var slugScrub = regexp.MustCompile(`[^a-z0-9]+`)

// slug derived from a workspace name: lowercase, non-alphanumeric runs
// collapse to single hyphens, trimmed of hyphens, max 32 chars. Pure so it is
// unit-testable without a db; "" means the name has no usable characters and
// the create must be rejected
func deriveSlug(name string) string {
	s := slugScrub.ReplaceAllString(strings.ToLower(name), "-")
	s = strings.Trim(s, "-")
	if len(s) > 32 {
		s = s[:32]
	}
	return strings.TrimRight(s, "-")
}

// createWorkspace outcome: the row, or a typed reason the creator can act on
// (reason: slugTaken | invalidName | limitReached)
type createWorkspaceResult struct {
	ok        bool
	workspace workspaceRecord
	reason    string
}

// deleteWorkspace outcome: the deleted row's id (so the registry can evict its
// room), or a typed reason (notFound | notCreator)
type deleteWorkspaceResult struct {
	ok     bool
	id     string
	reason string
}

// one member-panel row as the queries shape it — matches memberEntrySchema
// (MemberEntry on the wire)

// membersOf outcome: the panel lists — members, banned, pending invites (their
// target emails), pending join requests — or why the caller may not see them
type membersResult struct {
	ok       bool
	members  []MemberEntry
	banned   []MemberEntry
	invites  []string
	requests []MemberEntry
	reason   string // notFound | notCreator
}

// banMember/unbanMember outcome: the workspace id (so the caller can kick the
// removed user's live session), or a typed reason — isCreator fires only on a
// bid to remove the creator's own row. freedPod is the pod zone a ban released
// with the membership, so the room can be told live ("" = none)
type memberActionResult struct {
	ok          bool
	workspaceID string
	freedPod    string
	reason      string // notFound | notCreator | isCreator
}

type db struct {
	pool *pgxpool.Pool
}

func newDb(ctx context.Context, databaseURL string) (*db, error) {
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		return nil, err
	}
	return &db{pool: pool}, nil
}

// create the schema when missing — a handful of tables, so a migration tool
// would be overkill; runs before the server accepts clients
func (d *db) ensureSchema(ctx context.Context) error {
	statements := []string{
		`CREATE TABLE IF NOT EXISTS users (
			id           text        PRIMARY KEY,
			display_name text        NOT NULL,
			email        text,
			character    jsonb       NOT NULL,
			created_at   timestamptz NOT NULL DEFAULT now(),
			updated_at   timestamptz NOT NULL DEFAULT now()
		)`,
		// account email for the member panel; NULL = never fetched from clerk
		// (backfilled on the next join), '' = fetched, the account has none.
		// ALTER covers databases created before the column existed
		`ALTER TABLE users ADD COLUMN IF NOT EXISTS email text`,
		// workspaces; membership is invite/request-gated (notes/015)
		`CREATE TABLE IF NOT EXISTS workspaces (
			id         text        PRIMARY KEY,
			slug       text        UNIQUE NOT NULL,
			name       text        NOT NULL,
			created_by text        NOT NULL,
			created_at timestamptz NOT NULL DEFAULT now(),
			map        jsonb
		)`,
		// owner-edited layout; NULL = the default ship. ALTER covers databases
		// created before the column existed
		`ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS map jsonb`,
		`CREATE TABLE IF NOT EXISTS workspace_members (
			workspace_id text        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
			user_id      text        NOT NULL,
			joined_at    timestamptz NOT NULL DEFAULT now(),
			PRIMARY KEY (workspace_id, user_id)
		)`,
		// removed (banned) users; a row here blocks boarding, join requests,
		// and re-admission via invite accept / request approval
		`CREATE TABLE IF NOT EXISTS workspace_bans (
			workspace_id text        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
			user_id      text        NOT NULL,
			banned_at    timestamptz NOT NULL DEFAULT now(),
			PRIMARY KEY (workspace_id, user_id)
		)`,
		// pending invites, keyed by lowercased email — the only identifier a
		// creator can know for someone who never signed in (ADR 0003). No
		// status column: every resolution deletes the row (notes/015)
		`CREATE TABLE IF NOT EXISTS workspace_invites (
			workspace_id text        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
			email        text        NOT NULL,
			invited_at   timestamptz NOT NULL DEFAULT now(),
			PRIMARY KEY (workspace_id, email)
		)`,
		// pending join requests, keyed by the requesting account; pending-only
		// like invites (notes/015)
		`CREATE TABLE IF NOT EXISTS workspace_join_requests (
			workspace_id text        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
			user_id      text        NOT NULL,
			requested_at timestamptz NOT NULL DEFAULT now(),
			PRIMARY KEY (workspace_id, user_id)
		)`,
		// Links (space link feature): one undirected edge per workspace pair,
		// stored with the lower id first so symmetry lives in the key. Both
		// FKs cascade — a deleted workspace takes its Links with it
		`CREATE TABLE IF NOT EXISTS workspace_links (
			a_id      text        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
			b_id      text        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
			linked_at timestamptz NOT NULL DEFAULT now(),
			PRIMARY KEY (a_id, b_id),
			CHECK (a_id < b_id)
		)`,
		// pending Link Requests, directional (from petitions to); pending-only
		// like invites — every resolution deletes the row (space link feature)
		`CREATE TABLE IF NOT EXISTS workspace_link_requests (
			from_id      text        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
			to_id        text        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
			requested_at timestamptz NOT NULL DEFAULT now(),
			PRIMARY KEY (from_id, to_id)
		)`,
		// Blocks, directional (blocker refuses blocked): while one stands no
		// Link may exist between the pair in either direction (space link
		// feature, Q8)
		`CREATE TABLE IF NOT EXISTS workspace_blocks (
			blocker_id text        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
			blocked_id text        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
			blocked_at timestamptz NOT NULL DEFAULT now(),
			PRIMARY KEY (blocker_id, blocked_id)
		)`,
		// pod claims: one owner per pod, one pod per owner, per workspace —
		// both invariants live in the constraints so racing claims resolve in
		// postgres
		`CREATE TABLE IF NOT EXISTS pod_claims (
			workspace_id text        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
			zone_id      text        NOT NULL,
			user_id      text        NOT NULL,
			claimed_at   timestamptz NOT NULL DEFAULT now(),
			PRIMARY KEY (workspace_id, zone_id),
			UNIQUE (workspace_id, user_id)
		)`,
		// time tracking: one row per stay in a workspace, from join/resume to
		// socket close; ended_at NULL = still aboard (or the server died — the
		// boot sweep closes those). No FK: history survives workspace deletion
		`CREATE TABLE IF NOT EXISTS user_workspace_sessions (
			id           text        PRIMARY KEY,
			user_id      text        NOT NULL,
			workspace_id text        NOT NULL,
			started_at   timestamptz NOT NULL DEFAULT now(),
			ended_at     timestamptz
		)`,
		// the obvious rollup is per (workspace, user)
		`CREATE INDEX IF NOT EXISTS user_workspace_sessions_pair_idx
			ON user_workspace_sessions (workspace_id, user_id)`,
		// placed decor props (notes/017): anyone aboard may add one, so the row
		// records who placed it; the deck point is where the prop stands. No
		// per-owner constraint — the pod rule is positional, checked in the handler
		`CREATE TABLE IF NOT EXISTS workspace_items (
			id           text        PRIMARY KEY,
			workspace_id text        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
			kind         text        NOT NULL,
			x            double precision NOT NULL,
			y            double precision NOT NULL,
			scale        double precision NOT NULL DEFAULT 1,
			depth        double precision NOT NULL DEFAULT 0,
			placed_by    text        NOT NULL,
			placed_at    timestamptz NOT NULL DEFAULT now()
		)`,
		// props placed before the size slider existed keep the authored size
		`ALTER TABLE workspace_items ADD COLUMN IF NOT EXISTS
			scale double precision NOT NULL DEFAULT 1`,
		// props placed before the stacking buttons existed sort purely by where
		// they stand, which is what a zero nudge means
		`ALTER TABLE workspace_items ADD COLUMN IF NOT EXISTS
			depth double precision NOT NULL DEFAULT 0`,
		// props placed before the color picker existed keep their authored
		// color, which is what a null means
		`ALTER TABLE workspace_items ADD COLUMN IF NOT EXISTS color text`,
		// "rugBlue" used to be its own kind, differing from "rug" only in its
		// weave color. Now that a prop carries a color, it is that color on the
		// one rug — this rewrites the old rows to the surviving kind so they
		// keep rendering blue instead of being skipped as an unknown kind.
		// Idempotent: after the first run no rugBlue rows are left to match
		`UPDATE workspace_items SET kind = 'rug', color = '#3d6b8e' WHERE kind = 'rugBlue'`,
		// every read is "all props in this workspace"
		`CREATE INDEX IF NOT EXISTS workspace_items_workspace_idx
			ON workspace_items (workspace_id)`,
		// per-workspace leaderboards: one row per (game, account) holding that
		// account's best score — race keeps the lowest time (ms), blast the
		// highest kill count. The board dies with the workspace
		`CREATE TABLE IF NOT EXISTS game_scores (
			workspace_id text        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
			game         text        NOT NULL,
			user_id      text        NOT NULL,
			score        double precision NOT NULL,
			achieved_at  timestamptz NOT NULL DEFAULT now(),
			PRIMARY KEY (workspace_id, game, user_id)
		)`,
	}
	for _, stmt := range statements {
		if _, err := d.pool.Exec(ctx, stmt); err != nil {
			return err
		}
	}
	return nil
}

// jsonb from the db validated on the way out — a palette change or hand-edited
// row falls back to the default instead of crashing the sprite
func toProfile(displayName string, rawCharacter []byte) userProfile {
	var c Character
	if err := json.Unmarshal(rawCharacter, &c); err != nil || validateCharacter(c) != nil {
		c = defaultCharacter
	}
	return userProfile{displayName: displayName, character: c}
}

// profile by clerk user id; nil when this user has never joined
func (d *db) loadUser(ctx context.Context, id string) (*userProfile, error) {
	var displayName string
	var rawCharacter []byte
	err := d.pool.QueryRow(ctx,
		"SELECT display_name, character FROM users WHERE id = $1", id,
	).Scan(&displayName, &rawCharacter)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	p := toProfile(displayName, rawCharacter)
	return &p, nil
}

// first join: insert the row with defaults. The no-op DO UPDATE makes
// RETURNING yield the existing row if a concurrent first join won the race,
// so both joins read the same profile. A nil email means the clerk fetch
// failed — the NULL keeps it eligible for backfill on a later join
func (d *db) createUser(ctx context.Context, id, displayName string, email *string) (userProfile, error) {
	defaultJSON, _ := json.Marshal(defaultCharacter)
	var gotName string
	var rawCharacter []byte
	err := d.pool.QueryRow(ctx,
		`INSERT INTO users (id, display_name, email, character)
		 VALUES ($1, $2, $3, $4)
		 ON CONFLICT (id) DO UPDATE SET id = users.id
		 RETURNING display_name, character`,
		id, displayName, email, defaultJSON,
	).Scan(&gotName, &rawCharacter)
	if err != nil {
		return userProfile{}, err
	}
	return toProfile(gotName, rawCharacter), nil
}

// whether this user's email was never fetched from clerk (rows predating the
// email column, or a failed fetch at first join); false once any value landed
func (d *db) emailUnfetched(ctx context.Context, id string) (bool, error) {
	var unfetched bool
	err := d.pool.QueryRow(ctx,
		"SELECT email IS NULL FROM users WHERE id = $1", id).Scan(&unfetched)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	return unfetched, err
}

// the account's stored email for invite matching (notes/015): exists reports
// whether the users row is present at all; email is nil until a clerk fetch
// landed a value (” = fetched, the account has none)
func (d *db) emailOf(ctx context.Context, id string) (email *string, exists bool, err error) {
	err = d.pool.QueryRow(ctx,
		"SELECT email FROM users WHERE id = $1", id).Scan(&email)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, false, nil
	}
	return email, true, err
}

// persist a backfilled account email (” = the account has none)
func (d *db) saveEmail(ctx context.Context, id, email string) error {
	_, err := d.pool.Exec(ctx,
		"UPDATE users SET email = $2, updated_at = now() WHERE id = $1",
		id, email)
	return err
}

// persist a rename
func (d *db) saveDisplayName(ctx context.Context, id, displayName string) error {
	_, err := d.pool.Exec(ctx,
		"UPDATE users SET display_name = $2, updated_at = now() WHERE id = $1",
		id, displayName)
	return err
}

// persist a crew-locker edit
func (d *db) saveCharacter(ctx context.Context, id string, character Character) error {
	raw, err := json.Marshal(character)
	if err != nil {
		return err
	}
	_, err = d.pool.Exec(ctx,
		"UPDATE users SET character = $2, updated_at = now() WHERE id = $1",
		id, raw)
	return err
}

// true when err is a postgres unique violation (23505)
func uniqueViolation(err error) (*pgconn.PgError, bool) {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == "23505" {
		return pgErr, true
	}
	return nil, false
}

// create a workspace + the creator's membership atomically (one CTE insert);
// a unique-violation on the slug becomes a typed slugTaken result. The insert
// itself checks the per-creator cap, so hitting it inserts nothing and reads
// as limitReached
func (d *db) createWorkspace(ctx context.Context, name, createdBy string) (createWorkspaceResult, error) {
	slug := deriveSlug(name)
	if slug == "" {
		return createWorkspaceResult{reason: "invalidName"}, nil
	}
	id := gonanoid.Must()
	tag, err := d.pool.Exec(ctx,
		`WITH w AS (
		   INSERT INTO workspaces (id, slug, name, created_by)
		   SELECT $1, $2, $3, $4
		   WHERE (SELECT count(*) FROM workspaces WHERE created_by = $4) < $5
		   RETURNING id
		 )
		 INSERT INTO workspace_members (workspace_id, user_id)
		 SELECT id, $4 FROM w`,
		id, slug, name, createdBy, maxWorkspacesPerUser)
	if err != nil {
		// only the slug is unique here
		if _, ok := uniqueViolation(err); ok {
			return createWorkspaceResult{reason: "slugTaken"}, nil
		}
		return createWorkspaceResult{}, err
	}
	if tag.RowsAffected() == 0 {
		return createWorkspaceResult{reason: "limitReached"}, nil
	}
	return createWorkspaceResult{
		ok:        true,
		workspace: workspaceRecord{id: id, slug: slug, name: name, createdBy: createdBy},
	}, nil
}

// delete a workspace this user created; memberships go with it via ON DELETE
// CASCADE. The caller evicts anyone still aboard
func (d *db) deleteWorkspace(ctx context.Context, slug, userID string) (deleteWorkspaceResult, error) {
	var id string
	err := d.pool.QueryRow(ctx,
		"DELETE FROM workspaces WHERE slug = $1 AND created_by = $2 RETURNING id",
		slug, userID).Scan(&id)
	if err == nil {
		return deleteWorkspaceResult{ok: true, id: id}, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return deleteWorkspaceResult{}, err
	}
	// nothing deleted: tell a missing slug apart from someone else's workspace
	var one int
	err = d.pool.QueryRow(ctx, "SELECT 1 FROM workspaces WHERE slug = $1", slug).Scan(&one)
	if errors.Is(err, pgx.ErrNoRows) {
		return deleteWorkspaceResult{reason: "notFound"}, nil
	}
	if err != nil {
		return deleteWorkspaceResult{}, err
	}
	return deleteWorkspaceResult{reason: "notCreator"}, nil
}

// workspace by its URL slug; nil when it doesn't exist (join gate)
func (d *db) workspaceBySlug(ctx context.Context, slug string) (*workspaceRecord, error) {
	var w workspaceRecord
	err := d.pool.QueryRow(ctx,
		"SELECT id, slug, name, created_by FROM workspaces WHERE slug = $1", slug,
	).Scan(&w.id, &w.slug, &w.name, &w.createdBy)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &w, nil
}

// this workspace's owner-edited map, validated on the way out; nil means no
// edit was ever saved (or the row is invalid) — use the default ship
func (d *db) mapOf(ctx context.Context, workspaceID string) (*MapData, error) {
	var raw []byte
	err := d.pool.QueryRow(ctx,
		"SELECT map FROM workspaces WHERE id = $1", workspaceID).Scan(&raw)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if raw == nil {
		return nil, nil
	}
	m, perr := parseMapData(raw)
	if perr != nil {
		return nil, nil
	}
	return m, nil
}

// persist an owner-edited map
func (d *db) saveMap(ctx context.Context, workspaceID string, m *MapData) error {
	raw, err := json.Marshal(m)
	if err != nil {
		return err
	}
	_, err = d.pool.Exec(ctx, "UPDATE workspaces SET map = $2 WHERE id = $1", workspaceID, raw)
	return err
}

// drop one pod claim by zone — a map edit that removes a pod zone (or demotes
// it to a plain zone) frees its claim
func (d *db) deletePodClaim(ctx context.Context, workspaceID, zoneID string) error {
	_, err := d.pool.Exec(ctx,
		"DELETE FROM pod_claims WHERE workspace_id = $1 AND zone_id = $2",
		workspaceID, zoneID)
	return err
}

// the workspaces this user has joined, newest membership first (the picker
// list); mine marks the ones they created — deletable in the picker
func (d *db) workspacesFor(ctx context.Context, userID string) ([]workspaceListing, error) {
	rows, err := d.pool.Query(ctx,
		`SELECT w.id, w.slug, w.name, w.created_by, (w.created_by = $1) AS mine
		 FROM workspace_members m
		 JOIN workspaces w ON w.id = m.workspace_id
		 WHERE m.user_id = $1
		 ORDER BY m.joined_at DESC`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []workspaceListing
	for rows.Next() {
		var l workspaceListing
		if err := rows.Scan(&l.id, &l.slug, &l.name, &l.createdBy, &l.mine); err != nil {
			return nil, err
		}
		out = append(out, l)
	}
	return out, rows.Err()
}

// gate a join on membership — a pure check, no insert (notes/015): a banned
// user is refused ("removed"), a member passes ("ok"), anyone else is refused
// ("notMember") — membership only comes from creating the workspace, accepting
// an invite, or an approved join request
func (d *db) admitMember(ctx context.Context, workspaceID, userID string) (string, error) {
	var one int
	err := d.pool.QueryRow(ctx,
		"SELECT 1 FROM workspace_bans WHERE workspace_id = $1 AND user_id = $2",
		workspaceID, userID).Scan(&one)
	if err == nil {
		return "removed", nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return "", err
	}
	err = d.pool.QueryRow(ctx,
		"SELECT 1 FROM workspace_members WHERE workspace_id = $1 AND user_id = $2",
		workspaceID, userID).Scan(&one)
	if err == nil {
		return "ok", nil
	}
	if errors.Is(err, pgx.ErrNoRows) {
		return "notMember", nil
	}
	return "", err
}

// create a membership (invite accept / request approval, notes/015): a banned
// account is refused ("removed"), a new row only lands while the workspace has
// a free slot (else "full"). The count guard rides the insert, so two racing
// admissions can land at 21 — a guardrail, not an invariant. Idempotent: an
// existing member resolves "ok" (a stale accept still lands cleanly). On ok
// both pending artifacts for the pair are deleted — the join request by user
// id, the invite by the account's current email — so nothing stale lingers in
// the creator's panel (Q12)
func (d *db) createMembership(ctx context.Context, workspaceID, userID string) (string, error) {
	var one int
	err := d.pool.QueryRow(ctx,
		"SELECT 1 FROM workspace_bans WHERE workspace_id = $1 AND user_id = $2",
		workspaceID, userID).Scan(&one)
	if err == nil {
		return "removed", nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return "", err
	}
	tag, err := d.pool.Exec(ctx,
		`INSERT INTO workspace_members (workspace_id, user_id)
		 SELECT $1, $2
		 WHERE (SELECT count(*) FROM workspace_members WHERE workspace_id = $1) < $3
		 ON CONFLICT (workspace_id, user_id) DO NOTHING`,
		workspaceID, userID, maxMembersPerWorkspace)
	if err != nil {
		return "", err
	}
	if tag.RowsAffected() == 0 {
		// nothing inserted: tell an existing member (idempotent ok) apart from
		// a stranger bouncing off a full workspace
		err = d.pool.QueryRow(ctx,
			"SELECT 1 FROM workspace_members WHERE workspace_id = $1 AND user_id = $2",
			workspaceID, userID).Scan(&one)
		if errors.Is(err, pgx.ErrNoRows) {
			return "full", nil
		}
		if err != nil {
			return "", err
		}
	}
	// the membership exists: both pending artifacts resolve with it. A NULL or
	// empty users.email matches no invite ('' is never stored)
	if _, err := d.pool.Exec(ctx,
		"DELETE FROM workspace_join_requests WHERE workspace_id = $1 AND user_id = $2",
		workspaceID, userID); err != nil {
		return "", err
	}
	_, err = d.pool.Exec(ctx,
		`DELETE FROM workspace_invites
		 WHERE workspace_id = $1 AND email = (SELECT lower(email) FROM users WHERE id = $2)`,
		workspaceID, userID)
	if err != nil {
		return "", err
	}
	return "ok", nil
}

// the workspace behind a creator-only member operation: its id when the
// caller created it, else the typed refusal the panel shows
func (d *db) ownedWorkspace(ctx context.Context, slug, userID string) (string, string, error) {
	var id, createdBy string
	err := d.pool.QueryRow(ctx,
		"SELECT id, created_by FROM workspaces WHERE slug = $1", slug).Scan(&id, &createdBy)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", "notFound", nil
	}
	if err != nil {
		return "", "", err
	}
	if createdBy != userID {
		return "", "notCreator", nil
	}
	return id, "", nil
}

// both member-panel lists for a workspace the caller created. LEFT JOIN +
// COALESCE: the creator's membership can predate their users row (created on
// first board), and a banned user's profile may never exist
func (d *db) membersOf(ctx context.Context, slug, userID string) (membersResult, error) {
	wid, reason, err := d.ownedWorkspace(ctx, slug, userID)
	if err != nil {
		return membersResult{}, err
	}
	if reason != "" {
		return membersResult{reason: reason}, nil
	}
	scanEntries := func(query string, args ...any) ([]MemberEntry, error) {
		rows, err := d.pool.Query(ctx, query, args...)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		entries := []MemberEntry{}
		for rows.Next() {
			var e MemberEntry
			if err := rows.Scan(&e.ID, &e.Name, &e.Email, &e.Creator); err != nil {
				return nil, err
			}
			entries = append(entries, e)
		}
		return entries, rows.Err()
	}
	members, err := scanEntries(
		`SELECT m.user_id AS id, COALESCE(u.display_name, 'Crew Member') AS name,
		        COALESCE(u.email, '') AS email, (m.user_id = $2) AS creator
		 FROM workspace_members m LEFT JOIN users u ON u.id = m.user_id
		 WHERE m.workspace_id = $1
		 ORDER BY m.joined_at`, wid, userID)
	if err != nil {
		return membersResult{}, err
	}
	banned, err := scanEntries(
		`SELECT b.user_id AS id, COALESCE(u.display_name, 'Crew Member') AS name,
		        COALESCE(u.email, '') AS email, false AS creator
		 FROM workspace_bans b LEFT JOIN users u ON u.id = b.user_id
		 WHERE b.workspace_id = $1
		 ORDER BY b.banned_at`, wid)
	if err != nil {
		return membersResult{}, err
	}
	// pending invites: just the target emails, oldest first (notes/015)
	rows, err := d.pool.Query(ctx,
		"SELECT email FROM workspace_invites WHERE workspace_id = $1 ORDER BY invited_at", wid)
	if err != nil {
		return membersResult{}, err
	}
	defer rows.Close()
	invites := []string{}
	for rows.Next() {
		var email string
		if err := rows.Scan(&email); err != nil {
			return membersResult{}, err
		}
		invites = append(invites, email)
	}
	if err := rows.Err(); err != nil {
		return membersResult{}, err
	}
	// pending join requests: requestJoin ensures the users row, but LEFT JOIN
	// anyway — the panel degrades to a generic name rather than dropping a row
	requests, err := scanEntries(
		`SELECT r.user_id AS id, COALESCE(u.display_name, 'Crew Member') AS name,
		        COALESCE(u.email, '') AS email, false AS creator
		 FROM workspace_join_requests r LEFT JOIN users u ON u.id = r.user_id
		 WHERE r.workspace_id = $1
		 ORDER BY r.requested_at`, wid)
	if err != nil {
		return membersResult{}, err
	}
	return membersResult{ok: true, members: members, banned: banned, invites: invites, requests: requests}, nil
}

// remove (ban) a member from a workspace the caller created: the ban row and
// the membership delete ride one statement, so a crash between them can't
// leave a banned user still holding membership. Idempotent on a stale list —
// re-banning or banning a non-member just lands the ban row
func (d *db) banMember(ctx context.Context, slug, userID, targetID string) (memberActionResult, error) {
	wid, reason, err := d.ownedWorkspace(ctx, slug, userID)
	if err != nil {
		return memberActionResult{}, err
	}
	if reason != "" {
		return memberActionResult{reason: reason}, nil
	}
	// the caller is the creator (ownedWorkspace proved it), so a self-target
	// is the one row that must never leave
	if targetID == userID {
		return memberActionResult{reason: "isCreator"}, nil
	}
	// the banned user's pod claim goes with the membership — a name that can
	// never rejoin must not squat on a pod forever
	var freedPod string
	err = d.pool.QueryRow(ctx,
		`WITH b AS (
		   INSERT INTO workspace_bans (workspace_id, user_id)
		   VALUES ($1, $2)
		   ON CONFLICT (workspace_id, user_id) DO NOTHING
		 ), m AS (
		   DELETE FROM workspace_members WHERE workspace_id = $1 AND user_id = $2
		 )
		 DELETE FROM pod_claims WHERE workspace_id = $1 AND user_id = $2
		 RETURNING zone_id`,
		wid, targetID).Scan(&freedPod)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return memberActionResult{}, err
	}
	return memberActionResult{ok: true, workspaceID: wid, freedPod: freedPod}, nil
}

// lift a ban; membership is NOT restored — the user rejoins via the link and
// takes a free member slot like anyone else. Idempotent
func (d *db) unbanMember(ctx context.Context, slug, userID, targetID string) (memberActionResult, error) {
	wid, reason, err := d.ownedWorkspace(ctx, slug, userID)
	if err != nil {
		return memberActionResult{}, err
	}
	if reason != "" {
		return memberActionResult{reason: reason}, nil
	}
	_, err = d.pool.Exec(ctx,
		"DELETE FROM workspace_bans WHERE workspace_id = $1 AND user_id = $2",
		wid, targetID)
	if err != nil {
		return memberActionResult{}, err
	}
	return memberActionResult{ok: true, workspaceID: wid}, nil
}

// --- invites + join requests (notes/015) ---

// send an invite from a workspace the caller created to one lowercased email.
// Send-time checks fire only when a users row maps the email: a banned account
// is refused "removed" (an invite is not an unban), an existing member
// "alreadyMember". One pending row per (workspace, email) — re-sending is an
// idempotent "ok". Returns ok | notFound | notCreator | removed | alreadyMember
func (d *db) createInvite(ctx context.Context, slug, userID, email string) (string, error) {
	wid, reason, err := d.ownedWorkspace(ctx, slug, userID)
	if err != nil {
		return "", err
	}
	if reason != "" {
		return reason, nil
	}
	var one int
	err = d.pool.QueryRow(ctx,
		`SELECT 1 FROM workspace_bans b JOIN users u ON u.id = b.user_id
		 WHERE b.workspace_id = $1 AND lower(u.email) = $2`, wid, email).Scan(&one)
	if err == nil {
		return "removed", nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return "", err
	}
	err = d.pool.QueryRow(ctx,
		`SELECT 1 FROM workspace_members m JOIN users u ON u.id = m.user_id
		 WHERE m.workspace_id = $1 AND lower(u.email) = $2`, wid, email).Scan(&one)
	if err == nil {
		return "alreadyMember", nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return "", err
	}
	_, err = d.pool.Exec(ctx,
		`INSERT INTO workspace_invites (workspace_id, email) VALUES ($1, $2)
		 ON CONFLICT (workspace_id, email) DO NOTHING`, wid, email)
	if err != nil {
		return "", err
	}
	return "ok", nil
}

// cancel a pending invite in a workspace the caller created; idempotent — a
// row already resolved just deletes nothing. Returns ok | notFound | notCreator
func (d *db) cancelInvite(ctx context.Context, slug, userID, email string) (string, error) {
	wid, reason, err := d.ownedWorkspace(ctx, slug, userID)
	if err != nil {
		return "", err
	}
	if reason != "" {
		return reason, nil
	}
	_, err = d.pool.Exec(ctx,
		"DELETE FROM workspace_invites WHERE workspace_id = $1 AND email = $2", wid, email)
	if err != nil {
		return "", err
	}
	return "ok", nil
}

// accept an invite addressed to this account's email: the pending row is the
// authorization — no row (cancelled, or the email doesn't match) reads as
// notFound, exactly like a vanished workspace. Membership creation re-checks
// the ban and the cap and deletes the pending artifacts (createMembership).
// Returns ok | notFound | removed | full
func (d *db) acceptInvite(ctx context.Context, slug, userID, email string) (string, error) {
	w, err := d.workspaceBySlug(ctx, slug)
	if err != nil {
		return "", err
	}
	if w == nil {
		return "notFound", nil
	}
	var one int
	err = d.pool.QueryRow(ctx,
		"SELECT 1 FROM workspace_invites WHERE workspace_id = $1 AND email = $2",
		w.id, email).Scan(&one)
	if errors.Is(err, pgx.ErrNoRows) {
		return "notFound", nil
	}
	if err != nil {
		return "", err
	}
	return d.createMembership(ctx, w.id, userID)
}

// decline an invite addressed to this account's email: just delete the row.
// Idempotent; a vanished workspace reads notFound (its invites cascaded away).
// Returns ok | notFound
func (d *db) declineInvite(ctx context.Context, slug, email string) (string, error) {
	w, err := d.workspaceBySlug(ctx, slug)
	if err != nil {
		return "", err
	}
	if w == nil {
		return "notFound", nil
	}
	_, err = d.pool.Exec(ctx,
		"DELETE FROM workspace_invites WHERE workspace_id = $1 AND email = $2", w.id, email)
	if err != nil {
		return "", err
	}
	return "ok", nil
}

// petition to join a workspace by NAME, resolved through the same slug
// derivation as creation (Q7) — so a slug resolves to itself. A banned account
// is refused "removed" (Q11), a member "alreadyMember"; re-requesting is an
// idempotent "ok". The matched workspace rides back so the reply can label the
// picker row. Returns ok | notFound | removed | alreadyMember
func (d *db) createJoinRequest(ctx context.Context, name, userID string) (string, *workspaceRecord, error) {
	slug := deriveSlug(name)
	if slug == "" {
		return "notFound", nil, nil
	}
	w, err := d.workspaceBySlug(ctx, slug)
	if err != nil {
		return "", nil, err
	}
	if w == nil {
		return "notFound", nil, nil
	}
	gate, err := d.admitMember(ctx, w.id, userID)
	if err != nil {
		return "", nil, err
	}
	if gate == "removed" {
		return "removed", nil, nil
	}
	if gate == "ok" {
		return "alreadyMember", nil, nil
	}
	_, err = d.pool.Exec(ctx,
		`INSERT INTO workspace_join_requests (workspace_id, user_id) VALUES ($1, $2)
		 ON CONFLICT (workspace_id, user_id) DO NOTHING`, w.id, userID)
	if err != nil {
		return "", nil, err
	}
	return "ok", w, nil
}

// withdraw this account's own pending join request; idempotent like a decline.
// Returns ok | notFound
func (d *db) cancelJoinRequest(ctx context.Context, slug, userID string) (string, error) {
	w, err := d.workspaceBySlug(ctx, slug)
	if err != nil {
		return "", err
	}
	if w == nil {
		return "notFound", nil
	}
	_, err = d.pool.Exec(ctx,
		"DELETE FROM workspace_join_requests WHERE workspace_id = $1 AND user_id = $2", w.id, userID)
	if err != nil {
		return "", err
	}
	return "ok", nil
}

// approve a join request in a workspace the caller created: the pending row
// must still exist (a cancelled request reads notFound, so the panel refreshes
// honestly). Membership creation re-checks the ban and the cap and deletes the
// pending artifacts. Returns ok | notFound | notCreator | removed | full
func (d *db) approveJoinRequest(ctx context.Context, slug, userID, targetID string) (string, error) {
	wid, reason, err := d.ownedWorkspace(ctx, slug, userID)
	if err != nil {
		return "", err
	}
	if reason != "" {
		return reason, nil
	}
	var one int
	err = d.pool.QueryRow(ctx,
		"SELECT 1 FROM workspace_join_requests WHERE workspace_id = $1 AND user_id = $2",
		wid, targetID).Scan(&one)
	if errors.Is(err, pgx.ErrNoRows) {
		return "notFound", nil
	}
	if err != nil {
		return "", err
	}
	return d.createMembership(ctx, wid, targetID)
}

// deny a join request in a workspace the caller created: just delete the row.
// Idempotent. Returns ok | notFound | notCreator
func (d *db) denyJoinRequest(ctx context.Context, slug, userID, targetID string) (string, error) {
	wid, reason, err := d.ownedWorkspace(ctx, slug, userID)
	if err != nil {
		return "", err
	}
	if reason != "" {
		return reason, nil
	}
	_, err = d.pool.Exec(ctx,
		"DELETE FROM workspace_join_requests WHERE workspace_id = $1 AND user_id = $2",
		wid, targetID)
	if err != nil {
		return "", err
	}
	return "ok", nil
}

// the picker's pending lists (notes/015): invites addressed to this account's
// current email — "" (no email) matches nothing, an invite row's email is
// never empty — and this account's own join requests, newest first
func (d *db) pendingFor(ctx context.Context, userID, email string) (invites, requests []WorkspaceInfo, err error) {
	scan := func(query string, arg string) ([]WorkspaceInfo, error) {
		rows, err := d.pool.Query(ctx, query, arg)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		out := []WorkspaceInfo{}
		for rows.Next() {
			var w WorkspaceInfo
			if err := rows.Scan(&w.Slug, &w.Name); err != nil {
				return nil, err
			}
			out = append(out, w)
		}
		return out, rows.Err()
	}
	invites = []WorkspaceInfo{}
	if email != "" {
		invites, err = scan(
			`SELECT w.slug, w.name FROM workspace_invites i
			 JOIN workspaces w ON w.id = i.workspace_id
			 WHERE i.email = $1 ORDER BY i.invited_at DESC`, email)
		if err != nil {
			return nil, nil, err
		}
	}
	requests, err = scan(
		`SELECT w.slug, w.name FROM workspace_join_requests r
		 JOIN workspaces w ON w.id = r.workspace_id
		 WHERE r.user_id = $1 ORDER BY r.requested_at DESC`, userID)
	if err != nil {
		return nil, nil, err
	}
	return invites, requests, nil
}

// --- space link (workspace linking) ---

// the canonical order a Link's pair is stored in (a_id < b_id) — symmetry
// lives in the key, so one row covers both directions
func orderedPair(a, b string) (string, string) {
	if a < b {
		return a, b
	}
	return b, a
}

// workspace by id — the link flows hold the session's home id, not a slug;
// nil when it was deleted under the session
func (d *db) workspaceByID(ctx context.Context, id string) (*workspaceRecord, error) {
	var w workspaceRecord
	err := d.pool.QueryRow(ctx,
		"SELECT id, slug, name, created_by FROM workspaces WHERE id = $1", id,
	).Scan(&w.id, &w.slug, &w.name, &w.createdBy)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &w, nil
}

// true when a Link stands between the pair (the visit gate)
func (d *db) linkExists(ctx context.Context, a, b string) (bool, error) {
	lo, hi := orderedPair(a, b)
	var one int
	err := d.pool.QueryRow(ctx,
		"SELECT 1 FROM workspace_links WHERE a_id = $1 AND b_id = $2", lo, hi).Scan(&one)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	return err == nil, err
}

// whether either side of a pair blocks the other, told apart so the refusal
// can say "unblock first" to the blocker and "blocked" to the blocked (Q8)
func (d *db) blocksBetween(ctx context.Context, a, b string) (aBlocksB, bBlocksA bool, err error) {
	rows, err := d.pool.Query(ctx,
		`SELECT blocker_id FROM workspace_blocks
		 WHERE (blocker_id = $1 AND blocked_id = $2) OR (blocker_id = $2 AND blocked_id = $1)`,
		a, b)
	if err != nil {
		return false, false, err
	}
	defer rows.Close()
	for rows.Next() {
		var blocker string
		if err := rows.Scan(&blocker); err != nil {
			return false, false, err
		}
		if blocker == a {
			aBlocksB = true
		} else {
			bBlocksA = true
		}
	}
	return aBlocksB, bBlocksA, rows.Err()
}

// slug+name rows for the overlay's lists; never nil — the wire always
// carries JSON arrays
func (d *db) scanWorkspaceInfos(ctx context.Context, query string, args ...any) ([]WorkspaceInfo, error) {
	rows, err := d.pool.Query(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []WorkspaceInfo{}
	for rows.Next() {
		var w WorkspaceInfo
		if err := rows.Scan(&w.Slug, &w.Name); err != nil {
			return nil, err
		}
		out = append(out, w)
	}
	return out, rows.Err()
}

// everything the Space Link overlay shows for one workspace: its Links, and —
// creator only — the pending requests both ways and the Blocks it holds
type linkState struct {
	links    []WorkspaceInfo
	inbound  []WorkspaceInfo
	outbound []WorkspaceInfo
	blocks   []WorkspaceInfo
}

func (d *db) linkStateOf(ctx context.Context, wid string, creator bool) (linkState, error) {
	st := linkState{
		inbound:  []WorkspaceInfo{},
		outbound: []WorkspaceInfo{},
		blocks:   []WorkspaceInfo{},
	}
	var err error
	st.links, err = d.scanWorkspaceInfos(ctx,
		`SELECT w.slug, w.name FROM workspace_links l
		 JOIN workspaces w ON w.id = CASE WHEN l.a_id = $1 THEN l.b_id ELSE l.a_id END
		 WHERE l.a_id = $1 OR l.b_id = $1
		 ORDER BY l.linked_at`, wid)
	if err != nil {
		return linkState{}, err
	}
	// management lists are the creator's alone — everyone else just traverses
	if !creator {
		return st, nil
	}
	st.inbound, err = d.scanWorkspaceInfos(ctx,
		`SELECT w.slug, w.name FROM workspace_link_requests r
		 JOIN workspaces w ON w.id = r.from_id
		 WHERE r.to_id = $1 ORDER BY r.requested_at`, wid)
	if err != nil {
		return linkState{}, err
	}
	st.outbound, err = d.scanWorkspaceInfos(ctx,
		`SELECT w.slug, w.name FROM workspace_link_requests r
		 JOIN workspaces w ON w.id = r.to_id
		 WHERE r.from_id = $1 ORDER BY r.requested_at`, wid)
	if err != nil {
		return linkState{}, err
	}
	st.blocks, err = d.scanWorkspaceInfos(ctx,
		`SELECT w.slug, w.name FROM workspace_blocks b
		 JOIN workspaces w ON w.id = b.blocked_id
		 WHERE b.blocker_id = $1 ORDER BY b.blocked_at`, wid)
	if err != nil {
		return linkState{}, err
	}
	return st, nil
}

// petition to link home to a workspace by NAME, resolved through the same
// slug derivation as creation (Q9). Re-requesting is an idempotent "ok"; an
// inbound request from the same pair is pointed at instead — accepting stays
// the one act that creates a Link. Returns
// ok | notFound | self | alreadyLinked | blocked | youBlocked | requestPending
func (d *db) createLinkRequest(ctx context.Context, fromID, name string) (string, error) {
	slug := deriveSlug(name)
	if slug == "" {
		return "notFound", nil
	}
	target, err := d.workspaceBySlug(ctx, slug)
	if err != nil {
		return "", err
	}
	if target == nil {
		return "notFound", nil
	}
	if target.id == fromID {
		return "self", nil
	}
	linked, err := d.linkExists(ctx, fromID, target.id)
	if err != nil {
		return "", err
	}
	if linked {
		return "alreadyLinked", nil
	}
	weBlock, theyBlock, err := d.blocksBetween(ctx, fromID, target.id)
	if err != nil {
		return "", err
	}
	if weBlock {
		return "youBlocked", nil
	}
	if theyBlock {
		return "blocked", nil
	}
	var one int
	err = d.pool.QueryRow(ctx,
		"SELECT 1 FROM workspace_link_requests WHERE from_id = $1 AND to_id = $2",
		target.id, fromID).Scan(&one)
	if err == nil {
		return "requestPending", nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return "", err
	}
	_, err = d.pool.Exec(ctx,
		`INSERT INTO workspace_link_requests (from_id, to_id) VALUES ($1, $2)
		 ON CONFLICT (from_id, to_id) DO NOTHING`, fromID, target.id)
	if err != nil {
		return "", err
	}
	return "ok", nil
}

// withdraw home's own outbound Link Request; idempotent. Returns ok | notFound
func (d *db) cancelLinkRequest(ctx context.Context, fromID, toSlug string) (string, error) {
	target, err := d.workspaceBySlug(ctx, toSlug)
	if err != nil {
		return "", err
	}
	if target == nil {
		return "notFound", nil
	}
	_, err = d.pool.Exec(ctx,
		"DELETE FROM workspace_link_requests WHERE from_id = $1 AND to_id = $2",
		fromID, target.id)
	if err != nil {
		return "", err
	}
	return "ok", nil
}

// accept an inbound Link Request: the pending row is the authorization (a
// cancelled one reads notFound), Blocks and the 10-Link cap on BOTH sides are
// re-checked at this moment, and every pending request between the pair
// resolves with the Link. Returns the requester's workspace id on ok so the
// caller can tell its room, plus
// ok | notFound | blocked | youBlocked | linkLimit
func (d *db) acceptLinkRequest(ctx context.Context, toID, fromSlug string) (string, string, error) {
	from, err := d.workspaceBySlug(ctx, fromSlug)
	if err != nil {
		return "", "", err
	}
	if from == nil {
		return "notFound", "", nil
	}
	var one int
	err = d.pool.QueryRow(ctx,
		"SELECT 1 FROM workspace_link_requests WHERE from_id = $1 AND to_id = $2",
		from.id, toID).Scan(&one)
	if errors.Is(err, pgx.ErrNoRows) {
		return "notFound", "", nil
	}
	if err != nil {
		return "", "", err
	}
	weBlock, theyBlock, err := d.blocksBetween(ctx, toID, from.id)
	if err != nil {
		return "", "", err
	}
	if weBlock {
		return "youBlocked", "", nil
	}
	if theyBlock {
		return "blocked", "", nil
	}
	// the cap guard rides the insert so racing accepts can't blow far past it
	// — a guardrail, not an invariant, like the member cap
	lo, hi := orderedPair(toID, from.id)
	tag, err := d.pool.Exec(ctx,
		`INSERT INTO workspace_links (a_id, b_id)
		 SELECT $1, $2
		 WHERE (SELECT count(*) FROM workspace_links WHERE a_id = $3 OR b_id = $3) < $5
		   AND (SELECT count(*) FROM workspace_links WHERE a_id = $4 OR b_id = $4) < $5
		 ON CONFLICT (a_id, b_id) DO NOTHING`,
		lo, hi, toID, from.id, maxLinksPerWorkspace)
	if err != nil {
		return "", "", err
	}
	if tag.RowsAffected() == 0 {
		// nothing inserted: tell an existing link (idempotent ok) apart from a
		// side sitting at the cap
		linked, err := d.linkExists(ctx, toID, from.id)
		if err != nil {
			return "", "", err
		}
		if !linked {
			return "linkLimit", "", nil
		}
	}
	// the Link exists: every pending request between the pair resolves with it
	_, err = d.pool.Exec(ctx,
		`DELETE FROM workspace_link_requests
		 WHERE (from_id = $1 AND to_id = $2) OR (from_id = $2 AND to_id = $1)`,
		toID, from.id)
	if err != nil {
		return "", "", err
	}
	return "ok", from.id, nil
}

// deny an inbound Link Request: just delete the row; idempotent.
// Returns ok | notFound
func (d *db) denyLinkRequest(ctx context.Context, toID, fromSlug string) (string, error) {
	from, err := d.workspaceBySlug(ctx, fromSlug)
	if err != nil {
		return "", err
	}
	if from == nil {
		return "notFound", nil
	}
	_, err = d.pool.Exec(ctx,
		"DELETE FROM workspace_link_requests WHERE from_id = $1 AND to_id = $2",
		from.id, toID)
	if err != nil {
		return "", err
	}
	return "ok", nil
}

// remove a Link from either side: the one edge dies, cutting traversal in
// both directions (Q1); idempotent. The other side's id rides back so the
// caller can kick Visitors both ways. Returns ok | notFound
func (d *db) removeLink(ctx context.Context, wid, otherSlug string) (string, string, error) {
	other, err := d.workspaceBySlug(ctx, otherSlug)
	if err != nil {
		return "", "", err
	}
	if other == nil {
		return "notFound", "", nil
	}
	lo, hi := orderedPair(wid, other.id)
	_, err = d.pool.Exec(ctx,
		"DELETE FROM workspace_links WHERE a_id = $1 AND b_id = $2", lo, hi)
	if err != nil {
		return "", "", err
	}
	return "ok", other.id, nil
}

// place a Block on a workspace by NAME (Q8): one action — the block row
// lands, every pending request between the pair is deleted, and any standing
// Link is removed (the caller kicks Visitors both ways). Unblocking restores
// nothing. Returns ok | notFound | self
func (d *db) blockWorkspace(ctx context.Context, blockerID, name string) (string, string, error) {
	slug := deriveSlug(name)
	if slug == "" {
		return "notFound", "", nil
	}
	target, err := d.workspaceBySlug(ctx, slug)
	if err != nil {
		return "", "", err
	}
	if target == nil {
		return "notFound", "", nil
	}
	if target.id == blockerID {
		return "self", "", nil
	}
	if _, err := d.pool.Exec(ctx,
		`INSERT INTO workspace_blocks (blocker_id, blocked_id) VALUES ($1, $2)
		 ON CONFLICT (blocker_id, blocked_id) DO NOTHING`, blockerID, target.id); err != nil {
		return "", "", err
	}
	if _, err := d.pool.Exec(ctx,
		`DELETE FROM workspace_link_requests
		 WHERE (from_id = $1 AND to_id = $2) OR (from_id = $2 AND to_id = $1)`,
		blockerID, target.id); err != nil {
		return "", "", err
	}
	lo, hi := orderedPair(blockerID, target.id)
	if _, err := d.pool.Exec(ctx,
		"DELETE FROM workspace_links WHERE a_id = $1 AND b_id = $2", lo, hi); err != nil {
		return "", "", err
	}
	return "ok", target.id, nil
}

// lift a Block this workspace holds; idempotent, restores nothing.
// Returns ok | notFound
func (d *db) unblockWorkspace(ctx context.Context, blockerID, otherSlug string) (string, error) {
	other, err := d.workspaceBySlug(ctx, otherSlug)
	if err != nil {
		return "", err
	}
	if other == nil {
		return "notFound", nil
	}
	_, err = d.pool.Exec(ctx,
		"DELETE FROM workspace_blocks WHERE blocker_id = $1 AND blocked_id = $2",
		blockerID, other.id)
	if err != nil {
		return "", err
	}
	return "ok", nil
}

// claim a pod for this user: the two unique constraints turn racing claims
// into typed results — pkey = the pod is taken, the (workspace, user) unique =
// this user already holds one. Returns ok | podTaken | haveClaim
func (d *db) claimPod(ctx context.Context, workspaceID, zoneID, userID string) (string, error) {
	_, err := d.pool.Exec(ctx,
		"INSERT INTO pod_claims (workspace_id, zone_id, user_id) VALUES ($1, $2, $3)",
		workspaceID, zoneID, userID)
	if err != nil {
		if pgErr, ok := uniqueViolation(err); ok {
			if pgErr.ConstraintName == "pod_claims_pkey" {
				return "podTaken", nil
			}
			return "haveClaim", nil
		}
		return "", err
	}
	return "ok", nil
}

// release this user's pod claim; the freed zone id, or "" when they held none
func (d *db) releasePod(ctx context.Context, workspaceID, userID string) (string, error) {
	var zoneID string
	err := d.pool.QueryRow(ctx,
		"DELETE FROM pod_claims WHERE workspace_id = $1 AND user_id = $2 RETURNING zone_id",
		workspaceID, userID).Scan(&zoneID)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	return zoneID, nil
}

// --- workspace time tracking ---

// open a time-tracking row for one stay; the caller supplies the id so the
// insert may ride a goroutine while the id is already bound to the connection
func (d *db) createWorkspaceSession(ctx context.Context, id, workspaceID, userID string) error {
	_, err := d.pool.Exec(ctx,
		"INSERT INTO user_workspace_sessions (id, user_id, workspace_id) VALUES ($1, $2, $3)",
		id, userID, workspaceID)
	return err
}

// stamp a stay's end; write-once (the NULL guard), so a kick followed by the
// kicked socket's own close cleanup can't move the end time
func (d *db) endWorkspaceSession(ctx context.Context, id string) error {
	_, err := d.pool.Exec(ctx,
		"UPDATE user_workspace_sessions SET ended_at = now() WHERE id = $1 AND ended_at IS NULL", id)
	return err
}

// boot sweep: rows a crash or deploy left open get closed at startup time —
// overcounts by the downtime, but never loses a long stay entirely
func (d *db) closeDanglingSessions(ctx context.Context) (int64, error) {
	tag, err := d.pool.Exec(ctx,
		"UPDATE user_workspace_sessions SET ended_at = now() WHERE ended_at IS NULL")
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}

// every pod claim in a workspace, with the owner's display name for the pod
// label; LEFT JOIN + COALESCE, same stance as membersOf. Never nil — the
// welcome always carries a JSON array
func (d *db) podsOf(ctx context.Context, workspaceID string) ([]PodClaim, error) {
	rows, err := d.pool.Query(ctx,
		`SELECT c.zone_id, c.user_id, COALESCE(u.display_name, 'Crew Member') AS name
		 FROM pod_claims c LEFT JOIN users u ON u.id = c.user_id
		 WHERE c.workspace_id = $1
		 ORDER BY c.claimed_at`, workspaceID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	pods := []PodClaim{}
	for rows.Next() {
		var p PodClaim
		if err := rows.Scan(&p.ZoneID, &p.UserID, &p.Name); err != nil {
			return nil, err
		}
		pods = append(pods, p)
	}
	return pods, rows.Err()
}

// --- placed decor props (notes/017) ---

// every prop standing in a workspace, oldest first so z-order is stable across
// clients. Never nil — the welcome always carries a JSON array
func (d *db) itemsOf(ctx context.Context, workspaceID string) ([]PlacedItem, error) {
	rows, err := d.pool.Query(ctx,
		`SELECT id, kind, x, y, scale, depth, color FROM workspace_items
		 WHERE workspace_id = $1 ORDER BY placed_at, id`, workspaceID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []PlacedItem{}
	for rows.Next() {
		var it PlacedItem
		if err := rows.Scan(&it.ID, &it.Kind, &it.X, &it.Y, &it.Scale, &it.Depth, &it.Color); err != nil {
			return nil, err
		}
		// a kind that left the library is skipped, not crashed on — old rows
		// must not break a whole welcome
		if !slices.Contains(itemKinds, it.Kind) {
			continue
		}
		items = append(items, it)
	}
	return items, rows.Err()
}

// one prop by id, scoped to its workspace; ok=false when it is already gone
func (d *db) itemByID(ctx context.Context, workspaceID, id string) (PlacedItem, bool, error) {
	var it PlacedItem
	err := d.pool.QueryRow(ctx,
		"SELECT id, kind, x, y, scale, depth, color FROM workspace_items WHERE workspace_id = $1 AND id = $2",
		workspaceID, id).Scan(&it.ID, &it.Kind, &it.X, &it.Y, &it.Scale, &it.Depth, &it.Color)
	if errors.Is(err, pgx.ErrNoRows) {
		return PlacedItem{}, false, nil
	}
	if err != nil {
		return PlacedItem{}, false, err
	}
	return it, true, nil
}

// place a prop, with the per-workspace cap guarded inside the insert so two
// racing placements can't both slip past it. ok=false means the deck is full
func (d *db) placeItem(ctx context.Context, workspaceID, kind string, x, y, scale float64, color *string, userID string) (PlacedItem, bool, error) {
	it := PlacedItem{ID: gonanoid.Must(), Kind: kind, X: x, Y: y, Scale: scale, Color: color}
	tag, err := d.pool.Exec(ctx,
		`INSERT INTO workspace_items (id, workspace_id, kind, x, y, scale, color, placed_by)
		 SELECT $1, $2, $3, $4, $5, $6, $7, $8
		 WHERE (SELECT count(*) FROM workspace_items WHERE workspace_id = $2) < $9`,
		it.ID, workspaceID, kind, x, y, scale, color, userID, maxItemsPerWorkspace)
	if err != nil {
		return PlacedItem{}, false, err
	}
	return it, tag.RowsAffected() == 1, nil
}

// drag a prop to a new deck point; ok=false when it vanished mid-drag
func (d *db) moveItem(ctx context.Context, workspaceID, id string, x, y float64) (bool, error) {
	tag, err := d.pool.Exec(ctx,
		"UPDATE workspace_items SET x = $3, y = $4 WHERE workspace_id = $1 AND id = $2",
		workspaceID, id, x, y)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() == 1, nil
}

// resize a prop already on the deck; ok=false when it vanished mid-slider
func (d *db) scaleItem(ctx context.Context, workspaceID, id string, scale float64) (bool, error) {
	tag, err := d.pool.Exec(ctx,
		"UPDATE workspace_items SET scale = $3 WHERE workspace_id = $1 AND id = $2",
		workspaceID, id, scale)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() == 1, nil
}

// recolor a prop already on the deck; nil puts it back to its authored color.
// ok=false when it vanished mid-pick
func (d *db) colorItem(ctx context.Context, workspaceID, id string, color *string) (bool, error) {
	tag, err := d.pool.Exec(ctx,
		"UPDATE workspace_items SET color = $3 WHERE workspace_id = $1 AND id = $2",
		workspaceID, id, color)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() == 1, nil
}

// nudge a prop's draw order; ok=false when it vanished mid-click
func (d *db) raiseItem(ctx context.Context, workspaceID, id string, depth float64) (bool, error) {
	tag, err := d.pool.Exec(ctx,
		"UPDATE workspace_items SET depth = $3 WHERE workspace_id = $1 AND id = $2",
		workspaceID, id, depth)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() == 1, nil
}

// clear a prop away; ok=false when someone else cleared it first
func (d *db) deleteItem(ctx context.Context, workspaceID, id string) (bool, error) {
	tag, err := d.pool.Exec(ctx,
		"DELETE FROM workspace_items WHERE workspace_id = $1 AND id = $2", workspaceID, id)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() == 1, nil
}

// drop the listed props in one statement; used after a map edit strands props
// off the deck
func (d *db) deleteItems(ctx context.Context, workspaceID string, ids []string) error {
	if len(ids) == 0 {
		return nil
	}
	_, err := d.pool.Exec(ctx,
		"DELETE FROM workspace_items WHERE workspace_id = $1 AND id = ANY($2)", workspaceID, ids)
	return err
}

// --- game leaderboards (holotable games) ---

// how many rows each leaderboard shows; every member's best is stored
const leaderboardSize = 10

// record a race finish, keeping the account's fastest time — the guarded
// upsert only replaces a slower (higher) stored score
func (d *db) saveRaceTime(ctx context.Context, workspaceID, userID string, timeMs float64) error {
	_, err := d.pool.Exec(ctx,
		`INSERT INTO game_scores (workspace_id, game, user_id, score)
		 VALUES ($1, 'race', $2, $3)
		 ON CONFLICT (workspace_id, game, user_id) DO UPDATE
		 SET score = EXCLUDED.score, achieved_at = now()
		 WHERE game_scores.score > EXCLUDED.score`,
		workspaceID, userID, timeMs)
	return err
}

// record a match's kill count, keeping the account's highest — the guarded
// upsert only replaces a lower stored score
func (d *db) saveBlastKills(ctx context.Context, workspaceID, userID string, kills int) error {
	_, err := d.pool.Exec(ctx,
		`INSERT INTO game_scores (workspace_id, game, user_id, score)
		 VALUES ($1, 'blast', $2, $3)
		 ON CONFLICT (workspace_id, game, user_id) DO UPDATE
		 SET score = EXCLUDED.score, achieved_at = now()
		 WHERE game_scores.score < EXCLUDED.score`,
		workspaceID, userID, float64(kills))
	return err
}

// both leaderboards for a workspace: race fastest-first, blast highest-first,
// earlier achievement breaking ties; LEFT JOIN + COALESCE, same stance as
// membersOf. Never nil — the welcome always carries JSON arrays
func (d *db) leaderboardsOf(ctx context.Context, workspaceID string) (Leaderboards, error) {
	scan := func(game, direction string) ([]LeaderboardEntry, error) {
		rows, err := d.pool.Query(ctx,
			`SELECT s.user_id, COALESCE(u.display_name, 'Crew Member') AS name, s.score
			 FROM game_scores s LEFT JOIN users u ON u.id = s.user_id
			 WHERE s.workspace_id = $1 AND s.game = $2
			 ORDER BY s.score `+direction+`, s.achieved_at
			 LIMIT $3`, workspaceID, game, leaderboardSize)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		entries := []LeaderboardEntry{}
		for rows.Next() {
			var e LeaderboardEntry
			if err := rows.Scan(&e.UserID, &e.Name, &e.Score); err != nil {
				return nil, err
			}
			entries = append(entries, e)
		}
		return entries, rows.Err()
	}
	race, err := scan("race", "ASC")
	if err != nil {
		return Leaderboards{}, err
	}
	blast, err := scan("blast", "DESC")
	if err != nil {
		return Leaderboards{}, err
	}
	return Leaderboards{Race: race, Blast: blast}, nil
}

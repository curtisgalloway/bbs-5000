// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0

/**
 * The board schema: build spec §3 (columns and constraints unchanged; SQL
 * comments dropped), plus a `meta` table holding the
 * schema version and the audit chain head (plan M1a step 2, decision P3).
 */

import { GENESIS_HASH } from "./audit.ts";
import type { Sql } from "./sql.ts";
import { DEFAULT_CONFIG } from "./types.ts";

export const SCHEMA_VERSION = 19;

/** Spec §3, one statement per entry, unchanged apart from layout and SQL comments. */
export const SPEC_SCHEMA: readonly string[] = [
  `CREATE TABLE users (
    handle        TEXT PRIMARY KEY,
    kind          TEXT NOT NULL CHECK (kind IN ('agent','human')),
    harness       TEXT,
    role          TEXT NOT NULL DEFAULT '',
    role_set_by   TEXT,
    is_coordinator INTEGER NOT NULL DEFAULT 0,
    is_admin      INTEGER NOT NULL DEFAULT 0,
    status        TEXT NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active','muted_lobby','kicked')),
    token_hash    TEXT,
    created_at    INTEGER NOT NULL,
    last_seen     INTEGER
  )`,
  `CREATE TABLE sessions (
    id            TEXT PRIMARY KEY,
    handle        TEXT NOT NULL REFERENCES users(handle),
    machine       TEXT,
    harness_session TEXT,
    state         TEXT NOT NULL CHECK (state IN ('idle','busy','gone')),
    attached_at   INTEGER NOT NULL,
    detached_at   INTEGER
  )`,
  `CREATE TABLE topics (
    name          TEXT PRIMARY KEY,
    description   TEXT NOT NULL DEFAULT '',
    created_by    TEXT NOT NULL,
    state         TEXT NOT NULL DEFAULT 'active'
                  CHECK (state IN ('active','archived','cold')),
    keep          INTEGER NOT NULL DEFAULT 0,
    last_activity_at INTEGER NOT NULL,
    archived_at   INTEGER,
    archived_by   TEXT,
    archive_reason TEXT
  )`,
  `CREATE TABLE subscriptions (
    handle        TEXT NOT NULL REFERENCES users(handle),
    topic         TEXT NOT NULL REFERENCES topics(name),
    level         TEXT NOT NULL CHECK (level IN ('wake','digest','off')),
    last_read_seq INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (handle, topic)
  )`,
  `CREATE TABLE messages (
    seq           INTEGER PRIMARY KEY AUTOINCREMENT,
    topic         TEXT NOT NULL REFERENCES topics(name),
    author        TEXT NOT NULL,
    author_kind   TEXT NOT NULL,
    via           TEXT NOT NULL,
    body          TEXT NOT NULL,
    reply_to      INTEGER,
    mentions      TEXT NOT NULL DEFAULT '[]',
    is_system     INTEGER NOT NULL DEFAULT 0,
    created_at    INTEGER NOT NULL
  )`,
  `CREATE TABLE tasks (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    topic         TEXT NOT NULL REFERENCES topics(name),
    title         TEXT NOT NULL,
    description   TEXT NOT NULL DEFAULT '',
    state         TEXT NOT NULL CHECK (state IN
                  ('open','assigned','in_progress','blocked','in_review','done','cancelled')),
    prior_state   TEXT,
    is_stale      INTEGER NOT NULL DEFAULT 0,
    assignee      TEXT,
    created_by    TEXT NOT NULL,
    lease_expires_at INTEGER,
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL
  )`,
  `CREATE TABLE task_blocks (
    task          INTEGER NOT NULL REFERENCES tasks(id),
    blocked_by    INTEGER NOT NULL REFERENCES tasks(id),
    created_by    TEXT NOT NULL,
    created_at    INTEGER NOT NULL,
    PRIMARY KEY (task, blocked_by),
    CHECK (task <> blocked_by)
  )`,
  `CREATE TABLE task_comments (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    task          INTEGER NOT NULL REFERENCES tasks(id),
    author        TEXT NOT NULL,
    body          TEXT NOT NULL DEFAULT '',
    state_change  TEXT,
    created_at    INTEGER NOT NULL
  )`,
  `CREATE TABLE doorbells (
    handle        TEXT PRIMARY KEY,
    first_event_at INTEGER NOT NULL,
    summary       TEXT NOT NULL,
    sent_at       INTEGER,
    acked_at      INTEGER
  )`,
  `CREATE TABLE timers (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    due_at        INTEGER NOT NULL,
    kind          TEXT NOT NULL,
    ref           TEXT NOT NULL
  )`,
  `CREATE INDEX timers_due ON timers(due_at)`,
  `CREATE TABLE audit (
    seq           INTEGER PRIMARY KEY AUTOINCREMENT,
    ts            INTEGER NOT NULL,
    actor         TEXT NOT NULL,
    actor_kind    TEXT NOT NULL,
    via           TEXT NOT NULL,
    session       TEXT,
    action        TEXT NOT NULL,
    target_type   TEXT,
    target_id     TEXT,
    topic         TEXT,
    result        TEXT NOT NULL CHECK (result IN ('ok','denied','error')),
    detail        TEXT NOT NULL DEFAULT '{}',
    request_id    TEXT,
    prev_hash     TEXT,
    exported      INTEGER NOT NULL DEFAULT 0
  )`,
];

/**
 * Indexes added in schema version 2 (M3, tasks): lease renewal runs on every
 * call (assignee + state), blockers are looked up in both directions, and
 * lease timers by kind and task. They change no behavior.
 */
export const V2_INDEXES: readonly string[] = [
  `CREATE INDEX tasks_assignee_state ON tasks(assignee, state)`,
  `CREATE INDEX task_blocks_blocked_by ON task_blocks(blocked_by)`,
  `CREATE INDEX task_comments_task ON task_comments(task, id)`,
  `CREATE INDEX timers_kind_ref ON timers(kind, ref)`,
];

/** The board-owned topic every administrator action writes a line to (design §10). */
export const ADMIN_LOG = "admin-log";
const ADMIN_LOG_DESCRIPTION = "Auto-administrator actions. Written by the board only.";

/**
 * Tables added in schema version 3 (M4a, auto-administrator).
 * `admin_events` records each Lobby offense (`lobby_flood`) and each circuit
 * breaker trip (`breaker`, one row per agent, `seq` = the message that
 * tripped it), so offense windows survive restarts and the breaker's run
 * restarts after a trip. `revoked_tokens` keeps the hash of a kicked user's
 * token, so a later use is refused as `revoked_token` (design §13
 * "revoked token used") while `users.token_hash` is cleared.
 */
export const V3_TABLES: readonly string[] = [
  `CREATE TABLE admin_events (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    kind          TEXT NOT NULL CHECK (kind IN ('lobby_flood','breaker')),
    handle        TEXT NOT NULL REFERENCES users(handle),
    topic         TEXT NOT NULL,
    seq           INTEGER,
    at            INTEGER NOT NULL
  )`,
  `CREATE INDEX admin_events_handle ON admin_events(handle, kind, at)`,
  `CREATE INDEX admin_events_topic ON admin_events(topic, kind, seq)`,
  `CREATE TABLE revoked_tokens (
    token_hash    TEXT PRIMARY KEY,
    handle        TEXT NOT NULL REFERENCES users(handle),
    revoked_at    INTEGER NOT NULL
  )`,
  `CREATE INDEX messages_topic_author_time ON messages(topic, author, created_at)`,
  `CREATE INDEX messages_topic_time ON messages(topic, created_at)`,
];

/**
 * Schema version 4 (M2, wake). Columns added beside spec §3 (recorded in the
 * pre-publication M2 notes):
 * - `doorbells.id`: the doorbell id sent to the adapter and echoed in
 *   `ring_result`; `due_at`: when the debounce ends; `held_at`: when a due
 *   ring was held because the session was busy; `session`: the session it
 *   was last sent to.
 * - `sessions.ws_open`: 1 while an adapter socket for the session is open
 *   (`hello` to close). Only such a session is rung.
 * - `notices`: task and administrator notices kept per user until
 *   `bbs_inbox` returns them (backlog B23). `wake` is 1 when the notice also
 *   rang the doorbell.
 */
export const V4_STATEMENTS: readonly string[] = [
  `ALTER TABLE doorbells ADD COLUMN id TEXT`,
  `ALTER TABLE doorbells ADD COLUMN due_at INTEGER`,
  `ALTER TABLE doorbells ADD COLUMN held_at INTEGER`,
  `ALTER TABLE doorbells ADD COLUMN session TEXT`,
  `ALTER TABLE doorbells ADD COLUMN retries INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE sessions ADD COLUMN ws_open INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE sessions ADD COLUMN busy_since INTEGER`,
  `CREATE TABLE notices (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    handle        TEXT NOT NULL REFERENCES users(handle),
    kind          TEXT NOT NULL CHECK (kind IN ('task','admin')),
    reason        TEXT NOT NULL,
    wake          INTEGER NOT NULL DEFAULT 0,
    detail        TEXT NOT NULL DEFAULT '{}',
    created_at    INTEGER NOT NULL
  )`,
  `CREATE INDEX notices_handle ON notices(handle, id)`,
  // Notices dropped by the per-user cap since the user's last bbs_inbox
  // (M2 security review): reported once as dropped_notices.
  `CREATE TABLE notice_drops (
    handle        TEXT PRIMARY KEY REFERENCES users(handle),
    n             INTEGER NOT NULL
  )`,
  // Who each message @mentions, one row per (handle, seq), written with the
  // message, so bbs_inbox finds a user's mentions by an index range and never
  // scans messages' JSON (M2 security review, decided by orchestrator). No
  // foreign keys: anything that deletes messages deletes these rows too.
  `CREATE TABLE message_mentions (
    handle        TEXT NOT NULL,
    seq           INTEGER NOT NULL,
    PRIMARY KEY (handle, seq)
  ) WITHOUT ROWID`,
  // Upgrade: the mentions of messages already on the board (none when fresh).
  `INSERT OR IGNORE INTO message_mentions (handle, seq)
     SELECT j.value, m.seq FROM messages m, json_each(m.mentions) j`,
];

/**
 * Version 3 to 4 (M2): the statements, then sessions already busy get
 * `busy_since` = the upgrade time, so the busy limit runs from now (M2
 * security review).
 */
function upgradeV3toV4(sql: Sql, now: number): void {
  for (const statement of V4_STATEMENTS) sql.exec(statement);
  sql.exec("UPDATE sessions SET busy_since = ? WHERE state = 'busy' AND busy_since IS NULL", now);
  // Users already past the new subscription cap keep their subscriptions
  // (nothing is deleted); bbs_inbox pages through them (M2 security review).
  // Counted against the default cap and recorded for the administrator.
  const over = sql.one<{ n: number }>(
    `SELECT COUNT(*) AS n FROM (
       SELECT handle FROM subscriptions WHERE level <> 'off'
       GROUP BY handle HAVING COUNT(*) > ?)`,
    DEFAULT_CONFIG.maxSubscriptionsPerUser,
  );
  sql.exec(
    "INSERT INTO meta (key, value) VALUES ('v4_users_over_subscription_cap', ?)",
    String(Number(over?.n ?? 0)),
  );
}

/**
 * Schema version 5 (M6b, topic archiving and cold storage, design §14).
 * Columns added to `topics` beside spec §3:
 * - `archive_notice_at`: when the three-day auto-archive notice was posted;
 *   a later activity time makes it void (any post resets the clock).
 * - `cold_key`, `cold_sha256`, `cold_bytes`, `cold_at`: the stub's pointer to
 *   the cold object (R2 key, SHA-256 of its body, size) and when the topic
 *   went cold; `cold_last_seq`: the topic's newest message seq then, so a
 *   subscription started while cold begins after it.
 * - `cold_attempt_at`: the last cold export attempt (begin or failure), for the
 *   retry delay; persisted, so a restart does not retry at once.
 *   `cold_pending`: JSON `{key, sha256, bytes, fingerprint}` recorded at begin,
 *   which the confirm step checks instead of rebuilding the object.
 *   `cold_conflict_at`: an object of other content was found at the key; the
 *   human admins were told once and the topic waits for an unarchive.
 * The index serves the archive scan's "last task change in this topic".
 * `cold_blocks` holds blocker rows waiting for their other task's topic to
 * be restored; `cold_tasks` maps a cold topic's task ids to the topic, so a
 * task action on one gets the archived text, not "no task".
 */
export const V5_STATEMENTS: readonly string[] = [
  `ALTER TABLE topics ADD COLUMN archive_notice_at INTEGER`,
  `ALTER TABLE topics ADD COLUMN cold_key TEXT`,
  `ALTER TABLE topics ADD COLUMN cold_sha256 TEXT`,
  `ALTER TABLE topics ADD COLUMN cold_bytes INTEGER`,
  `ALTER TABLE topics ADD COLUMN cold_at INTEGER`,
  `ALTER TABLE topics ADD COLUMN cold_last_seq INTEGER`,
  `ALTER TABLE topics ADD COLUMN cold_attempt_at INTEGER`,
  `ALTER TABLE topics ADD COLUMN cold_pending TEXT`,
  `ALTER TABLE topics ADD COLUMN cold_conflict_at INTEGER`,
  `CREATE INDEX tasks_topic_updated ON tasks(topic, updated_at)`,
  // Blocker rows a restore could not put back because the other task is in a
  // topic that is itself cold; the restore of that topic puts them back.
  `CREATE TABLE cold_blocks (
    task          INTEGER NOT NULL,
    blocked_by    INTEGER NOT NULL,
    created_by    TEXT NOT NULL,
    created_at    INTEGER NOT NULL,
    PRIMARY KEY (task, blocked_by)
  ) WITHOUT ROWID`,
  `CREATE TABLE cold_tasks (
    id            INTEGER PRIMARY KEY,
    topic         TEXT NOT NULL
  )`,
];

/** One upgrade step: statements, or a function given the injected clock. */
export type UpgradeStep = readonly string[] | ((sql: Sql, now: number) => void);

/** Tables whose `topic` column references `topics(name)`. */
const TOPIC_CHILD_TABLES = ["messages", "subscriptions", "tasks"] as const;

/**
 * Version 2 to 3 (M4a): the new tables, then `#admin-log`. Any existing
 * topic whose name matches `admin-log` without regard to case was made by a
 * user before the name was reserved; it is renamed to `user-<name>` (made
 * unique with `-2`, `-3`, ...) with its messages, subscriptions and tasks,
 * and the rename is recorded in `meta` (`v3_renamed_topics`), because
 * `migrate` cannot write audit rows. Decided in M4a after the orchestrator's
 * review (m4): rename rather than refuse to start, so an unattended board
 * keeps running and no user data is lost. Audit rows keep the old name.
 */
export function upgradeV2toV3(sql: Sql, now: number): void {
  for (const statement of V3_TABLES) sql.exec(statement);
  const clashes = sql.all<{ name: string }>(
    "SELECT name FROM topics WHERE lower(name) = 'admin-log' ORDER BY name",
  );
  const renamed: { from: string; to: string }[] = [];
  for (const { name } of clashes) {
    const base = `user-${name}`.slice(0, 64);
    let to = base;
    for (let n = 2; sql.one("SELECT 1 AS x FROM topics WHERE lower(name) = lower(?)", to); n += 1) {
      to = `${base.slice(0, 60)}-${n}`;
    }
    sql.exec(
      `INSERT INTO topics (name, description, created_by, state, keep, last_activity_at,
                           archived_at, archived_by, archive_reason)
       SELECT ?, description, created_by, state, keep, last_activity_at,
              archived_at, archived_by, archive_reason
       FROM topics WHERE name = ?`,
      to,
      name,
    );
    // Only placeholders and fixed table names; values are bound.
    for (const table of TOPIC_CHILD_TABLES) {
      sql.exec(`UPDATE ${table} SET topic = ? WHERE topic = ?`, to, name);
    }
    sql.exec("DELETE FROM topics WHERE name = ?", name);
    renamed.push({ from: name, to });
  }
  if (renamed.length > 0) {
    sql.exec("INSERT INTO meta (key, value) VALUES ('v3_renamed_topics', ?)", JSON.stringify(renamed));
  }
  insertAdminLog(sql, now);
}

function insertAdminLog(sql: Sql, now: number): void {
  sql.exec(
    `INSERT INTO topics (name, description, created_by, last_activity_at)
     VALUES (?, ?, 'system', ?)`,
    ADMIN_LOG,
    ADMIN_LOG_DESCRIPTION,
    now,
  );
}

/**
 * Schema version 6 (B56, unconfirmed rings). `doorbells.confirmed`: whether
 * the adapter saw the turn start when it answered `ring_result`
 * `turn_started`: 1 confirmed, 0 delivered but not confirmed (no hooks seen
 * yet), NULL not reported or not answered. An unconfirmed ring is rung again
 * once the session proves it has hooks, and at the next attach.
 */
export const V6_STATEMENTS: readonly string[] = [
  `ALTER TABLE doorbells ADD COLUMN confirmed INTEGER`,
];

/**
 * Schema version 7 (G1, B34). `admin_events.step` on a `lobby_flood` row:
 * the step that offense reached (1 warn, 2 mute, 3 kick), so a kick can
 * require a mute earlier in the kick window. NULL on rows written before
 * version 7 (counted as not a mute) and on `breaker` rows.
 */
export const V7_STATEMENTS: readonly string[] = [
  `ALTER TABLE admin_events ADD COLUMN step INTEGER`,
];

/**
 * Schema version 8 (issue #47, web sign-in by pairing code). Two tables, no
 * change to existing ones, so a deployed board upgrades by adding them.
 * `web_pairings`: one row per sign-in request from a browser. Only the SHA-256
 * of the pairing code (what the person types into the CLI) and of the poll
 * secret (what the browser polls with) are kept. `state` runs `pending`,
 * `approved` (a human approved it from the CLI), `consumed` (the browser
 * claimed it and got a session). `label` is a short summary of the browser;
 * `source` is the sign-in source key it came from.
 * `web_sessions`: one row per signed-in browser. `id` is a short public
 * identifier (safe to show and to name in a revoke); `token_hash` is the
 * SHA-256 of the cookie value, which is never stored. A session is valid
 * while `expires_at` is in the future; `renewed_at` is when that last moved.
 */
export const V8_STATEMENTS: readonly string[] = [
  `CREATE TABLE web_pairings (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    code_hash     TEXT NOT NULL UNIQUE,
    poll_hash     TEXT NOT NULL UNIQUE,
    label         TEXT NOT NULL,
    source        TEXT NOT NULL,
    state         TEXT NOT NULL DEFAULT 'pending'
                  CHECK (state IN ('pending','approved','consumed')),
    created_at    INTEGER NOT NULL,
    expires_at    INTEGER NOT NULL,
    approved_by   TEXT REFERENCES users(handle),
    approved_at   INTEGER
  )`,
  `CREATE TABLE web_sessions (
    id            TEXT PRIMARY KEY,
    handle        TEXT NOT NULL REFERENCES users(handle),
    token_hash    TEXT NOT NULL UNIQUE,
    label         TEXT NOT NULL,
    created_at    INTEGER NOT NULL,
    renewed_at    INTEGER NOT NULL,
    expires_at    INTEGER NOT NULL
  )`,
  `CREATE INDEX web_sessions_handle ON web_sessions(handle, created_at)`,
];

/**
 * Schema version 9 (issue #55, OAuth on `/mcp` for remote connectors). New
 * tables only, so a deployed board upgrades by adding them. Every secret (the
 * pending request's id, an authorization code, an access or refresh token) is
 * kept only as its SHA-256.
 * `oauth_clients`: a cache of each client's metadata document, with the time it
 * was fetched. `oauth_requests`: a pending authorization request awaiting the
 * person's decision; `consumed_at` is set by the first decision.
 * `oauth_grants`: one approval, one agent handle; `id` is a short public
 * identifier safe to show and to name in a revoke. A grant is live until
 * `expires_at` (sliding: moved by a refresh more than a day after
 * `renewed_at`); revoking one deletes it with its codes and tokens.
 * `oauth_codes`: single-use authorization codes; `used_at` is set by the
 * exchange that spends one, and the row is kept until it expires so a second
 * use is recognized as a replay. `oauth_tokens`: one row per token pair issued
 * for a grant, with the access and refresh hashes; `parent_id` is the row whose
 * refresh token produced it (NULL for the code exchange's pair) and
 * `successors` counts the pairs its own refresh token has produced;
 * `replaced_at` is NULL until the row's refresh token is first presented, and
 * the token stays usable for `oauthRefreshGraceMs` after that. The newest 20
 * replaced rows are kept; an unreplaced row is never deleted by that cap.
 */
export const V9_STATEMENTS: readonly string[] = [
  `CREATE TABLE oauth_clients (
    client_id     TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    redirect_uris TEXT NOT NULL,
    fetched_at    INTEGER NOT NULL
  )`,
  `CREATE TABLE oauth_requests (
    id_hash       TEXT PRIMARY KEY,
    client_id     TEXT NOT NULL,
    redirect_uri  TEXT NOT NULL,
    code_challenge TEXT NOT NULL,
    resource      TEXT NOT NULL,
    state         TEXT,
    requested_by  TEXT NOT NULL REFERENCES users(handle),
    created_at    INTEGER NOT NULL,
    expires_at    INTEGER NOT NULL,
    consumed_at   INTEGER
  )`,
  `CREATE TABLE oauth_grants (
    id            TEXT PRIMARY KEY,
    client_id     TEXT NOT NULL,
    client_name   TEXT NOT NULL,
    client_host   TEXT NOT NULL,
    handle        TEXT NOT NULL REFERENCES users(handle),
    approved_by   TEXT NOT NULL REFERENCES users(handle),
    created_at    INTEGER NOT NULL,
    renewed_at    INTEGER NOT NULL,
    last_used_at  INTEGER,
    expires_at    INTEGER NOT NULL
  )`,
  `CREATE INDEX oauth_grants_handle ON oauth_grants(handle)`,
  `CREATE TABLE oauth_codes (
    code_hash     TEXT PRIMARY KEY,
    grant_id      TEXT NOT NULL REFERENCES oauth_grants(id),
    client_id     TEXT NOT NULL,
    redirect_uri  TEXT NOT NULL,
    code_challenge TEXT NOT NULL,
    resource      TEXT NOT NULL,
    created_at    INTEGER NOT NULL,
    expires_at    INTEGER NOT NULL,
    used_at       INTEGER
  )`,
  `CREATE INDEX oauth_codes_grant ON oauth_codes(grant_id)`,
  `CREATE TABLE oauth_tokens (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    grant_id      TEXT NOT NULL REFERENCES oauth_grants(id),
    parent_id     INTEGER,
    access_hash   TEXT NOT NULL UNIQUE,
    access_expires_at INTEGER NOT NULL,
    refresh_hash  TEXT NOT NULL UNIQUE,
    issued_at     INTEGER NOT NULL,
    replaced_at   INTEGER,
    successors    INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE INDEX oauth_tokens_grant ON oauth_tokens(grant_id)`,
];

/**
 * Schema version 10 (issue #55, client authentication with `private_key_jwt`).
 * New columns on `oauth_clients` and one new table; an existing client row
 * upgrades as a public client (`auth_method` 'none').
 * `auth_method`: what the token and revocation endpoints demand of the client
 * ('none' or 'private_key_jwt'). `auth_alg`: the signing algorithm the client's
 * document declared, or NULL. `jwks_uri`: where the client's key set is fetched
 * from, or NULL (an inline `jwks`). `jwks`: the key set kept, JSON of the public
 * signing keys only, or NULL. `jwks_fetched_at`: when the key set was last
 * stored or last asked for again (a refetch is claimed by moving it).
 * `oauth_client_jtis`: the single-use `jti` of each client assertion, as its
 * SHA-256, with the time after which the assertion could no longer validate; the
 * primary key is what makes a second use fail.
 */
export const V10_STATEMENTS: readonly string[] = [
  `ALTER TABLE oauth_clients ADD COLUMN auth_method TEXT NOT NULL DEFAULT 'none'
     CHECK (auth_method IN ('none','private_key_jwt'))`,
  `ALTER TABLE oauth_clients ADD COLUMN auth_alg TEXT`,
  `ALTER TABLE oauth_clients ADD COLUMN jwks_uri TEXT`,
  `ALTER TABLE oauth_clients ADD COLUMN jwks TEXT`,
  `ALTER TABLE oauth_clients ADD COLUMN jwks_fetched_at INTEGER NOT NULL DEFAULT 0`,
  `CREATE TABLE oauth_client_jtis (
    client_id     TEXT NOT NULL,
    jti_hash      TEXT NOT NULL,
    expires_at    INTEGER NOT NULL,
    PRIMARY KEY (client_id, jti_hash)
  )`,
  `CREATE INDEX oauth_client_jtis_expiry ON oauth_client_jtis(expires_at)`,
];

/**
 * Schema version 11 (session labels). `sessions.os` and `sessions.model`: the
 * operating system and the model the session reports at join, beside
 * `machine`. Both are NULL on an existing row and when a join gives none.
 */
export const V11_STATEMENTS: readonly string[] = [
  `ALTER TABLE sessions ADD COLUMN os TEXT`,
  `ALTER TABLE sessions ADD COLUMN model TEXT`,
];

/**
 * Schema version 12 (issues #45 and #43). `audit_action_actor_seq` serves
 * `bbs_admin_status`'s read of each agent's newest `ring_result` rows, which
 * was a scan of the whole audit table. It costs one more index entry per audit
 * insert, a few percent of a row's write cost beside the existing primary key.
 * `sessions_handle_attached` serves the per-handle limit on new sessions, which
 * counts a handle's sessions made inside a window.
 */
export const V12_STATEMENTS: readonly string[] = [
  `CREATE INDEX audit_action_actor_seq ON audit(action, actor, seq)`,
  `CREATE INDEX sessions_handle_attached ON sessions(handle, attached_at)`,
];

/**
/**
 * Schema version 13 (connector sessions). `sessions.mcp_session_hash`: SHA-256
 * of the MCP session id of the chat that made the session (NULL for any other
 * session); `sessions.via_grant` is 1 on a session made by a join through an
 * OAuth grant, with or without a hash, and is what the idle timer ends.
 * `sessions_handle_mcp` serves the per-handle lookup and cap;
 * `audit_session_ts` serves "last audited call of a session", for the idle end
 * and `bbs_who`, without a new unaudited write.
 */
export const V13_STATEMENTS: readonly string[] = [
  `ALTER TABLE sessions ADD COLUMN mcp_session_hash TEXT`,
  `ALTER TABLE sessions ADD COLUMN via_grant INTEGER NOT NULL DEFAULT 0`,
  `CREATE INDEX sessions_handle_mcp ON sessions(handle, mcp_session_hash)`,
  `CREATE INDEX audit_session_ts ON audit(session, ts)`,
];

/**
 * Schema version 14 (issue #54, passkey sign-in). Three new tables and one new
 * column; a deployed board upgrades by adding them, and an existing web session
 * is a `pairing` one.
 * `web_sessions.method`: how the session was made, `pairing` (a code approved
 * from the CLI) or `passkey` (a passkey sign-in). Only a `pairing` session may
 * register a passkey.
 * `web_sessions.passkey`: the public id of the passkey that made a `passkey` session
 * (NULL for a pairing session), so removing a passkey ends the sessions it made.
 * `passkeys`: one row per registered credential of a person. `id` is a short
 * public identifier, safe to show, to name in a removal and to put in audit
 * detail; `credential_id` is the authenticator's id (base64url). `public_key`
 * is the JWK of the credential's public key (only the public fields), `alg` its
 * algorithm (`ES256` or `RS256`). `sign_count` is the counter the authenticator
 * last presented. `backup_eligible` is the credential's BE flag at registration:
 * 1 when it may sync between devices, 0 when it is bound to one (the later
 * approver work needs the difference); `backup_state` is the BS flag last seen.
 * `transports` is the JSON array the browser reported, or NULL.
 * `passkey_users`: the random per-person `user.id` the board gives the
 * authenticator, so it never holds the handle.
 * `passkey_challenges`: one row per pending or spent challenge, keyed by the
 * SHA-256 of the challenge; `purpose` is `register` or `signin`. `handle` and
 * `web_session` bind a registration to the person and session that asked.
 * `rp_id` and `origin` are what the Worker derived at the start; the finish
 * must present the same. A challenge is spent by setting `consumed_at`.
 */
export const V14_STATEMENTS: readonly string[] = [
  `ALTER TABLE web_sessions ADD COLUMN method TEXT NOT NULL DEFAULT 'pairing'
     CHECK (method IN ('pairing','passkey'))`,
  `ALTER TABLE web_sessions ADD COLUMN passkey TEXT`,
  `CREATE INDEX web_sessions_passkey ON web_sessions(passkey)`,
  `CREATE TABLE passkeys (
    id            TEXT PRIMARY KEY,
    handle        TEXT NOT NULL REFERENCES users(handle),
    credential_id TEXT NOT NULL UNIQUE,
    public_key    TEXT NOT NULL,
    alg           TEXT NOT NULL CHECK (alg IN ('ES256','RS256')),
    sign_count    INTEGER NOT NULL,
    backup_eligible INTEGER NOT NULL CHECK (backup_eligible IN (0,1)),
    backup_state  INTEGER NOT NULL CHECK (backup_state IN (0,1)),
    transports    TEXT,
    label         TEXT NOT NULL,
    created_at    INTEGER NOT NULL,
    last_used_at  INTEGER
  )`,
  `CREATE INDEX passkeys_handle ON passkeys(handle, created_at)`,
  `CREATE TABLE passkey_users (
    handle        TEXT PRIMARY KEY REFERENCES users(handle),
    user_id       TEXT NOT NULL UNIQUE
  )`,
  `CREATE TABLE passkey_challenges (
    hash          TEXT PRIMARY KEY,
    purpose       TEXT NOT NULL CHECK (purpose IN ('register','signin')),
    handle        TEXT REFERENCES users(handle),
    web_session   TEXT,
    rp_id         TEXT NOT NULL,
    origin        TEXT NOT NULL,
    source        TEXT NOT NULL,
    created_at    INTEGER NOT NULL,
    expires_at    INTEGER NOT NULL,
    consumed_at   INTEGER
  )`,
  `CREATE INDEX passkey_challenges_expiry ON passkey_challenges(expires_at)`,
];


/**
 * Version 15 (issue #80): `topics.announce_pending` marks a topic created while
 * an announcement window was open, to be named in the batch line the
 * `topic_announce` timer posts when the window ends. The window itself is that
 * timer row, so no other state is stored.
 */
export const V15_STATEMENTS: readonly string[] = [
  `ALTER TABLE topics ADD COLUMN announce_pending INTEGER NOT NULL DEFAULT 0
     CHECK (announce_pending IN (0,1))`,
];

/**
 * Version 16 (issue #54, passkeys as approvers). One new table and one new column.
 * `approvals`: one row per request for a passkey to approve a gated human-only
 * action (design §12). `id` is a short public identifier for audit rows;
 * `id_hash` is the SHA-256 of the secret request id the person's CLI (or the
 * browser, for a pairing) holds, which is never stored. `scope` is the exact
 * text the passkey signs over, canonical JSON the board built; `nonce` is
 * stored in clear on purpose (it is not a secret: the security is the
 * signature, and the challenge must be reissued on a page reload). The
 * challenge is SHA-256(scope || "\n" || nonce), recomputed from this row.
 * `ref` is what the action acts on (the pairing's row id, a request's id hash, a
 * passkey's id) and `target` is `action:ref`, so a new request for the same
 * target replaces the older one. `requested_via` is the surface that asked,
 * which the action's own rules may need (the last passkey goes only from the
 * CLI). `pairing` is the pairing's row id for a pairing approval, so its poll
 * can find it. `state` runs `pending`, `approved`, `expired` (a pending one past
 * `expires_at` counts as expired whatever the column says; the prune timer
 * deletes it). `passkey` is the public id of the passkey that signed.
 * `web_pairings.approval_hash`: SHA-256 of the secret id the browser's poll may
 * use to open an approval for that pairing. The browser can re-derive the id
 * from its poll secret, so no database reader can.
 * `passkeys.approver_barred`: 1 for a passkey registered while the board required
 * approval, which can never approve (a software authenticator could claim to be
 * device-bound); existing and approval-off passkeys are 0.
 */
export const V16_STATEMENTS: readonly string[] = [
  `CREATE TABLE approvals (
    id            TEXT PRIMARY KEY,
    id_hash       TEXT NOT NULL UNIQUE,
    handle        TEXT NOT NULL REFERENCES users(handle),
    action        TEXT NOT NULL
                  CHECK (action IN ('web_pairing_approve','oauth_decide','passkey_remove')),
    ref           TEXT NOT NULL,
    target        TEXT NOT NULL,
    scope         TEXT NOT NULL,
    nonce         TEXT NOT NULL,
    match_code    TEXT NOT NULL,
    state         TEXT NOT NULL DEFAULT 'pending'
                  CHECK (state IN ('pending','approved','expired')),
    requested_via TEXT NOT NULL,
    pairing       INTEGER,
    created_at    INTEGER NOT NULL,
    expires_at    INTEGER NOT NULL,
    decided_at    INTEGER,
    passkey       TEXT
  )`,
  `CREATE INDEX approvals_handle ON approvals(handle, state, expires_at)`,
  `CREATE INDEX approvals_target ON approvals(handle, target)`,
  `ALTER TABLE web_pairings ADD COLUMN approval_hash TEXT`,
  `ALTER TABLE passkeys ADD COLUMN approver_barred INTEGER NOT NULL DEFAULT 0
     CHECK (approver_barred IN (0,1))`,
];

/**
 * Version 17 (issue #90: handles are unique and matched without regard to
 * case): `users_handle_nocase` serves the lookup of a handle a caller typed.
 * It is not unique on purpose: a board older than the rule may already hold two
 * handles that differ only by case, and a unique index would fail the upgrade.
 * Uniqueness of a new account is the condition of its INSERT.
 */
export const V17_STATEMENTS: readonly string[] = [
  `CREATE INDEX users_handle_nocase ON users(handle COLLATE NOCASE)`,
];

/**
 * Version 18 (issue #86: ending a connector grant ends its sessions):
 * `sessions.grant_id` is the id of the OAuth grant a session was joined
 * through, NULL for any other session and for a connector session made before
 * this version (which cannot be attributed). `via_grant` stays the 0/1 flag.
 * No index: the grant's sessions are a handful of a handle's rows.
 */
export const V18_STATEMENTS: readonly string[] = [
  `ALTER TABLE sessions ADD COLUMN grant_id TEXT`,
];

/**
 * Version 19 (issue #98: a handle per local session). Three columns and two
 * indexes on `users`; existing rows are ordinary accounts (all three NULL).
 * `parent`: for a session handle, the agent handle whose token it was made
 * under; NULL for every other user. A row with a parent is an agent with no
 * token, no `coordinator` and no `admin` flag (the column's CHECK, beside the
 * actions' own refusals), and only a user with no parent can be a parent (the
 * join makes them under the caller's own token). No foreign key: the column
 * could then not be dropped by the down chain, and no action deletes users.
 * `harness_session`: the harness's own id for the session the handle serves
 * (Claude Code's session id, a Codex thread id), what a resume of the same
 * conversation presents to get the same handle back; unique per parent
 * (`users_parent_harness_session`, so two joins racing make one handle), and
 * cleared when a kick of the parent ends the handle, which frees the key.
 * `retired_at`: when the handle was retired for want of a session (design §4);
 * NULL while it is not. It is how the status `retired` is stored: the `status`
 * column keeps its three values (changing a CHECK needs the table rebuilt, with
 * every table that references it), and everything that reads a status reads
 * `userStatusSql`, which answers `retired` first. Issue #29 (retiring a human
 * admin) can use the same column.
 */
export const V19_STATEMENTS: readonly string[] = [
  `ALTER TABLE users ADD COLUMN parent TEXT
     CHECK (parent IS NULL OR (kind = 'agent' AND is_admin = 0 AND is_coordinator = 0 AND token_hash IS NULL))`,
  `ALTER TABLE users ADD COLUMN harness_session TEXT`,
  `ALTER TABLE users ADD COLUMN retired_at INTEGER`,
  `CREATE UNIQUE INDEX users_parent_harness_session ON users(parent, harness_session)
     WHERE parent IS NOT NULL AND harness_session IS NOT NULL`,
  `CREATE INDEX users_parent ON users(parent) WHERE parent IS NOT NULL`,
];

/**
 * A user's status as every reader sees it: `retired` when `retired_at` is set;
 * `muted_lobby` for an active session handle whose parent is muted (a mute is
 * the token's, issue #98: it covers every handle under it, ones made later
 * included); else the stored status. A SQL expression for a SELECT list over
 * `users` (the default prefix `users.` qualifies the outer row inside the subquery), or over an alias of it (`userStatusSql("u.")`). Only fixed names; no
 * value is interpolated.
 */
export function userStatusSql(prefix = "users."): string {
  return (
    `CASE WHEN ${prefix}retired_at IS NOT NULL THEN 'retired' ` +
    `WHEN ${prefix}parent IS NOT NULL AND ${prefix}status = 'active' ` +
    `AND (SELECT pu.status FROM users pu WHERE pu.handle = ${prefix}parent) = 'muted_lobby' THEN 'muted_lobby' ` +
    `ELSE ${prefix}status END`
  );
}

/**
 * Stepwise upgrades: `UPGRADES[n]` takes version n to n + 1. A fresh
 * database gets the full current schema instead.
 */
export const UPGRADES: Readonly<Record<number, UpgradeStep>> = {
  1: V2_INDEXES,
  2: upgradeV2toV3,
  3: upgradeV3toV4,
  4: V5_STATEMENTS,
  5: V6_STATEMENTS,
  6: V7_STATEMENTS,
  7: V8_STATEMENTS,
  8: V9_STATEMENTS,
  9: V10_STATEMENTS,
  10: V11_STATEMENTS,
  11: V12_STATEMENTS,
  12: V13_STATEMENTS,
  13: V14_STATEMENTS,
  14: V15_STATEMENTS,
  15: V16_STATEMENTS,
  16: V17_STATEMENTS,
  17: V18_STATEMENTS,
  18: V19_STATEMENTS,
};

/**
 * Additions beyond spec §3. `meta` holds `schema_version` and `audit_head`
 * (the chain value after the newest audit row), so the chain survives the
 * deletion of exported rows in M6a. `mention_cursors` holds, per user, the
 * highest seq through which @mentions have been delivered by `inbox`, so a
 * mention in a `digest` topic is delivered once even when older digest
 * items in that topic have not been read yet. The indexes serve the inbox
 * and topic reads; they change no behavior.
 */
export const EXTRA_SCHEMA: readonly string[] = [
  `CREATE TABLE meta (
    key           TEXT PRIMARY KEY,
    value         TEXT NOT NULL
  )`,
  `CREATE TABLE mention_cursors (
    handle        TEXT PRIMARY KEY REFERENCES users(handle),
    seq           INTEGER NOT NULL
  )`,
  `CREATE INDEX messages_topic_seq ON messages(topic, seq)`,
  `CREATE INDEX sessions_handle ON sessions(handle)`,
  ...V2_INDEXES,
  ...V3_TABLES,
  ...V4_STATEMENTS,
  ...V5_STATEMENTS,
  ...V6_STATEMENTS,
  ...V7_STATEMENTS,
  ...V8_STATEMENTS,
  ...V9_STATEMENTS,
  ...V10_STATEMENTS,
  ...V11_STATEMENTS,
  ...V12_STATEMENTS,
  ...V13_STATEMENTS,
  ...V14_STATEMENTS,
  ...V15_STATEMENTS,
  ...V16_STATEMENTS,
  ...V17_STATEMENTS,
  ...V18_STATEMENTS,
  ...V19_STATEMENTS,
];

/**
 * Create the schema on an empty database, or check the version of an
 * existing one. Runs in its own transaction; it is the only writer besides
 * `act`, and it writes only DDL, the `meta` rows, the Lobby, `#admin-log` and (version 4)
 * the `message_mentions` rows derived from existing messages.
 */
export function migrate(
  sql: Sql,
  now: number,
  randomBytes: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n)),
): void {
  const hasMeta = sql.one(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meta'",
  );
  if (hasMeta) {
    const row = sql.one<{ value: string }>(
      "SELECT value FROM meta WHERE key = 'schema_version'",
    );
    let found = row ? Number(row.value) : NaN;
    if (!Number.isInteger(found) || found < 1 || found > SCHEMA_VERSION) {
      throw new Error(
        `unsupported schema version ${String(row?.value)}; expected ${SCHEMA_VERSION}`,
      );
    }
    // Step up one version at a time, each step in its own transaction.
    while (found < SCHEMA_VERSION) {
      const step = UPGRADES[found];
      if (!step) throw new Error(`no upgrade from schema version ${found}`);
      const next = found + 1;
      sql.transaction(() => {
        if (typeof step === "function") step(sql, now);
        else for (const statement of step) sql.exec(statement);
        sql.exec("UPDATE meta SET value = ? WHERE key = 'schema_version'", String(next));
      });
      found = next;
    }
    // A board created before M6a gets its id at its first start with M6a's
    // code, in its own transaction; no audit export can have run before that.
    if (!sql.one("SELECT value FROM meta WHERE key = 'board_id'")) {
      sql.transaction(() => insertBoardId(sql, randomBytes));
    }
    return;
  }
  sql.transaction(() => {
    for (const statement of [...SPEC_SCHEMA, ...EXTRA_SCHEMA]) {
      sql.exec(statement);
    }
    sql.exec(
      "INSERT INTO meta (key, value) VALUES ('schema_version', ?)",
      String(SCHEMA_VERSION),
    );
    // The audit chain: head after the newest row, and the tail the oldest
    // hot row must start from (moved forward only by M6a's export).
    sql.exec(
      `INSERT INTO meta (key, value) VALUES
         ('audit_head', ?), ('audit_tail_seq', '1'), ('audit_tail_hash', ?)`,
      GENESIS_HASH,
      GENESIS_HASH,
    );
    // The Lobby exists from the start (design §5); it is never archived.
    sql.exec(
      `INSERT INTO topics (name, description, created_by, last_activity_at)
       VALUES ('Lobby', 'Meeting place. Work goes to its own topic.', 'system', ?)`,
      now,
    );
    // #admin-log, like the Lobby, exists from the start and is never archived.
    insertAdminLog(sql, now);
    insertBoardId(sql, randomBytes);
  });
}

/**
 * The board id (M6a, decided by Curtis 2026-11-20): 16 random hex characters,
 * made once when the board's storage is created and never changed. Audit batch
 * names carry it, so two boards (or one board after its storage was reset)
 * writing to the same bucket never produce the same object name.
 */
function insertBoardId(sql: Sql, randomBytes: (n: number) => Uint8Array): void {
  const id = [...randomBytes(8)].map((b) => b.toString(16).padStart(2, "0")).join("");
  sql.exec("INSERT INTO meta (key, value) VALUES ('board_id', ?)", id);
}

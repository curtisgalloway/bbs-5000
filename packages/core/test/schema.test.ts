// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { NodeSqliteSql } from "../src/node-sqlite.ts";
import { DEFAULT_CONFIG } from "../src/types.ts";
import {
  ADMIN_LOG,
  migrate,
  SCHEMA_VERSION,
  SPEC_SCHEMA,
  V2_INDEXES,
  V3_TABLES,
  V4_STATEMENTS,
  V5_STATEMENTS,
  V6_STATEMENTS,
  V7_STATEMENTS,
  V8_STATEMENTS,
  V9_STATEMENTS,
  V10_STATEMENTS,
  V11_STATEMENTS,
  V12_STATEMENTS,
  V13_STATEMENTS,
  V14_STATEMENTS,
  V15_STATEMENTS,
  V16_STATEMENTS,
  V17_STATEMENTS,
  V18_STATEMENTS,
  V19_STATEMENTS,
} from "../src/schema.ts";

/** Undo schema version 19 (issue #98, session handles) on a fresh database: the users parent, harness_session and retired_at columns and their indexes. */
function downToV18(sql: NodeSqliteSql): void {
  for (const ddl of [...V19_STATEMENTS].reverse()) {
    const t = /CREATE (?:UNIQUE )?(TABLE|INDEX) (\w+)/.exec(ddl);
    if (t) sql.exec(`DROP ${t[1]} ${t[2]}`);
    const c = /ALTER TABLE (\w+) ADD COLUMN (\w+)/.exec(ddl);
    if (c) sql.exec(`ALTER TABLE ${c[1]} DROP COLUMN ${c[2]}`);
  }
  sql.exec("UPDATE meta SET value = '18' WHERE key = 'schema_version'");
}

/** Undo schema version 18 (issue #86, the grant of a connector session) on a fresh database: the sessions grant_id column. */
function downToV17(sql: NodeSqliteSql): void {
  downToV18(sql);
  for (const ddl of [...V18_STATEMENTS].reverse()) {
    const c = /ALTER TABLE (\w+) ADD COLUMN (\w+)/.exec(ddl);
    if (c) sql.exec(`ALTER TABLE ${c[1]} DROP COLUMN ${c[2]}`);
  }
  sql.exec("UPDATE meta SET value = '17' WHERE key = 'schema_version'");
}

/** Undo schema version 17 (issue #90, case-insensitive handles) on a fresh database: the users handle index. */
function downToV16(sql: NodeSqliteSql): void {
  downToV17(sql);
  for (const ddl of [...V17_STATEMENTS].reverse()) {
    const t = /CREATE (TABLE|INDEX) (\w+)/.exec(ddl);
    if (t) sql.exec(`DROP ${t[1]} ${t[2]}`);
  }
  sql.exec("UPDATE meta SET value = '16' WHERE key = 'schema_version'");
}

/** Undo schema version 16 (issue #54, approvers) on a fresh database: the approvals table and the pairing's approval_hash column. */
function downToV15(sql: NodeSqliteSql): void {
  downToV16(sql);
  for (const ddl of [...V16_STATEMENTS].reverse()) {
    const t = /CREATE (TABLE|INDEX) (\w+)/.exec(ddl);
    if (t) sql.exec(`DROP ${t[1]} ${t[2]}`);
    const c = /ALTER TABLE (\w+) ADD COLUMN (\w+)/.exec(ddl);
    if (c) sql.exec(`ALTER TABLE ${c[1]} DROP COLUMN ${c[2]}`);
  }
  sql.exec("UPDATE meta SET value = '15' WHERE key = 'schema_version'");
}

/** Undo schema version 15 (issue #80) on a fresh database: the topics' announce_pending column. */
function downToV14(sql: NodeSqliteSql): void {
  downToV15(sql);
  for (const ddl of [...V15_STATEMENTS].reverse()) {
    const c = /ALTER TABLE (\w+) ADD COLUMN (\w+)/.exec(ddl);
    if (c) sql.exec(`ALTER TABLE ${c[1]} DROP COLUMN ${c[2]}`);
  }
  sql.exec("UPDATE meta SET value = '14' WHERE key = 'schema_version'");
}

/** Undo schema version 14 (issue #54) on a fresh database: the passkey tables and the session method and passkey columns. */
function downToV13(sql: NodeSqliteSql): void {
  downToV14(sql);
  for (const ddl of [...V14_STATEMENTS].reverse()) {
    const t = /CREATE (TABLE|INDEX) (\w+)/.exec(ddl);
    if (t) sql.exec(`DROP ${t[1]} ${t[2]}`);
    const c = /ALTER TABLE (\w+) ADD COLUMN (\w+)/.exec(ddl);
    if (c) sql.exec(`ALTER TABLE ${c[1]} DROP COLUMN ${c[2]}`);
  }
  sql.exec("UPDATE meta SET value = '13' WHERE key = 'schema_version'");
}

/** Undo schema version 13 (connector sessions) on a fresh database: two session columns and two indexes. */
function downToV12(sql: NodeSqliteSql): void {
  downToV13(sql);
  for (const ddl of [...V13_STATEMENTS].reverse()) {
    const t = /CREATE (TABLE|INDEX) (\w+)/.exec(ddl);
    if (t) sql.exec(`DROP ${t[1]} ${t[2]}`);
    const c = /ALTER TABLE (\w+) ADD COLUMN (\w+)/.exec(ddl);
    if (c) sql.exec(`ALTER TABLE ${c[1]} DROP COLUMN ${c[2]}`);
  }
  sql.exec("UPDATE meta SET value = '12' WHERE key = 'schema_version'");
}

/** Undo schema version 12 (issues #45, #43) on a fresh database: the audit and session indexes. */
function downToV11(sql: NodeSqliteSql): void {
  downToV12(sql);
  for (const ddl of [...V12_STATEMENTS].reverse()) {
    const t = /CREATE (TABLE|INDEX) (\w+)/.exec(ddl);
    if (t) sql.exec(`DROP ${t[1]} ${t[2]}`);
  }
  sql.exec("UPDATE meta SET value = '11' WHERE key = 'schema_version'");
}

/** Undo schema version 11 (session labels) on a fresh database: the sessions' os and model columns. */
function downToV10(sql: NodeSqliteSql): void {
  downToV11(sql);
  for (const ddl of [...V11_STATEMENTS].reverse()) {
    const c = /ALTER TABLE (\w+) ADD COLUMN (\w+)/.exec(ddl);
    if (c) sql.exec(`ALTER TABLE ${c[1]} DROP COLUMN ${c[2]}`);
  }
  sql.exec("UPDATE meta SET value = '10' WHERE key = 'schema_version'");
}

/** Undo schema version 10 (issue #55) on a fresh database: the client authentication columns and the assertion table. */
function downToV9(sql: NodeSqliteSql): void {
  downToV10(sql);
  for (const ddl of [...V10_STATEMENTS].reverse()) {
    const t = /CREATE (TABLE|INDEX) (\w+)/.exec(ddl);
    if (t) sql.exec(`DROP ${t[1]} ${t[2]}`);
    const c = /ALTER TABLE (\w+) ADD COLUMN (\w+)/.exec(ddl);
    if (c) sql.exec(`ALTER TABLE ${c[1]} DROP COLUMN ${c[2]}`);
  }
  sql.exec("UPDATE meta SET value = '9' WHERE key = 'schema_version'");
}

/** Undo schema version 9 (issue #55) on a fresh database: the OAuth tables and indexes. */
function downToV8(sql: NodeSqliteSql): void {
  downToV9(sql);
  for (const ddl of [...V9_STATEMENTS].reverse()) {
    const t = /CREATE (TABLE|INDEX) (\w+)/.exec(ddl);
    if (t) sql.exec(`DROP ${t[1]} ${t[2]}`);
  }
  sql.exec("UPDATE meta SET value = '8' WHERE key = 'schema_version'");
}

/** Undo schema version 8 (issue #47) on a fresh database: the web pairing and session tables. */
function downToV7(sql: NodeSqliteSql): void {
  downToV8(sql);
  for (const ddl of [...V8_STATEMENTS].reverse()) {
    const t = /CREATE (TABLE|INDEX) (\w+)/.exec(ddl);
    if (t) sql.exec(`DROP ${t[1]} ${t[2]}`);
  }
  sql.exec("UPDATE meta SET value = '7' WHERE key = 'schema_version'");
}

/** Undo schema version 7 (G1, B34) on a fresh database: the `admin_events.step` column. */
function downToV6(sql: NodeSqliteSql): void {
  downToV7(sql);
  for (const ddl of [...V7_STATEMENTS].reverse()) {
    const c = /ALTER TABLE (\w+) ADD COLUMN (\w+)/.exec(ddl);
    if (c) sql.exec(`ALTER TABLE ${c[1]} DROP COLUMN ${c[2]}`);
  }
  sql.exec("UPDATE meta SET value = '6' WHERE key = 'schema_version'");
}

/** Undo schema version 6 (B56) on a fresh database: the doorbell `confirmed` column. */
function downToV5(sql: NodeSqliteSql): void {
  downToV6(sql);
  for (const ddl of [...V6_STATEMENTS].reverse()) {
    const c = /ALTER TABLE (\w+) ADD COLUMN (\w+)/.exec(ddl);
    if (c) sql.exec(`ALTER TABLE ${c[1]} DROP COLUMN ${c[2]}`);
  }
  sql.exec("UPDATE meta SET value = '5' WHERE key = 'schema_version'");
}

/** Undo schema version 5 (M6b) on a fresh database: the topics columns and the task index. */
function downToV4(sql: NodeSqliteSql): void {
  downToV5(sql);
  for (const ddl of [...V5_STATEMENTS].reverse()) {
    const t = /CREATE (TABLE|INDEX) (\w+)/.exec(ddl);
    if (t) sql.exec(`DROP ${t[1]} ${t[2]}`);
    const c = /ALTER TABLE (\w+) ADD COLUMN (\w+)/.exec(ddl);
    if (c) sql.exec(`ALTER TABLE ${c[1]} DROP COLUMN ${c[2]}`);
  }
  sql.exec("UPDATE meta SET value = '4' WHERE key = 'schema_version'");
}

/** Undo schema version 4 (M2) on a fresh database: the notices table and added columns. */
function downToV3(sql: NodeSqliteSql): void {
  downToV4(sql);
  for (const ddl of [...V4_STATEMENTS].reverse()) {
    const t = /CREATE (TABLE|INDEX) (\w+)/.exec(ddl);
    if (t) sql.exec(`DROP ${t[1]} ${t[2]}`);
    const c = /ALTER TABLE (\w+) ADD COLUMN (\w+)/.exec(ddl);
    if (c) sql.exec(`ALTER TABLE ${c[1]} DROP COLUMN ${c[2]}`);
  }
  sql.exec("UPDATE meta SET value = '3' WHERE key = 'schema_version'");
}

/** Undo schema version 3 (M4a) on a fresh database: its tables, index and #admin-log. */
function downToV2(sql: NodeSqliteSql): void {
  downToV3(sql);
  for (const ddl of [...V3_TABLES].reverse()) {
    const m = /CREATE (TABLE|INDEX) (\w+)/.exec(ddl);
    if (m) sql.exec(`DROP ${m[1]} ${m[2]}`);
  }
  sql.exec("DELETE FROM topics WHERE name = 'admin-log'");
  sql.exec("UPDATE meta SET value = '2' WHERE key = 'schema_version'");
}

/** Columns of every spec §3 table, in order, as the spec lists them. */
const SPEC_COLUMNS: Record<string, string[]> = {
  users: [
    "handle", "kind", "harness", "role", "role_set_by", "is_coordinator", "is_admin",
    "status", "token_hash", "created_at", "last_seen",
  ],
  sessions: [
    "id", "handle", "machine", "harness_session", "state", "attached_at", "detached_at",
  ],
  topics: [
    "name", "description", "created_by", "state", "keep", "last_activity_at",
    "archived_at", "archived_by", "archive_reason",
  ],
  subscriptions: ["handle", "topic", "level", "last_read_seq"],
  messages: [
    "seq", "topic", "author", "author_kind", "via", "body", "reply_to", "mentions",
    "is_system", "created_at",
  ],
  tasks: [
    "id", "topic", "title", "description", "state", "prior_state", "is_stale",
    "assignee", "created_by", "lease_expires_at", "created_at", "updated_at",
  ],
  task_blocks: ["task", "blocked_by", "created_by", "created_at"],
  task_comments: ["id", "task", "author", "body", "state_change", "created_at"],
  doorbells: ["handle", "first_event_at", "summary", "sent_at", "acked_at"],
  timers: ["id", "due_at", "kind", "ref"],
  audit: [
    "seq", "ts", "actor", "actor_kind", "via", "session", "action", "target_type",
    "target_id", "topic", "result", "detail", "request_id", "prev_hash", "exported",
  ],
};

/** Columns schema version 4 (M2) adds to spec tables, recorded in the pre-publication M2 notes. */
const V4_ADDED: Record<string, string[]> = {
  doorbells: ["id", "due_at", "held_at", "session", "retries", "confirmed"],
  // Schema version 19 (issue #98): the session handle columns.
  users: ["parent", "harness_session", "retired_at"],
  // Schema version 11 adds the session labels os and model; version 13 the connector columns.
  sessions: ["ws_open", "busy_since", "os", "model", "mcp_session_hash", "via_grant", "grant_id"],
  // Schema version 5 (M6b): archive notice and cold-storage stub columns.
  topics: [
    "archive_notice_at", "cold_key", "cold_sha256", "cold_bytes", "cold_at", "cold_last_seq",
    "cold_attempt_at", "cold_pending", "cold_conflict_at",
    // Schema version 15 (issue #80): marks a topic for the next new-topic announcement batch.
    "announce_pending",
  ],
};

describe("schema", () => {
  it("creates every spec §3 table with the spec's columns", () => {
    const sql = new NodeSqliteSql();
    migrate(sql, 0);
    for (const [table, columns] of Object.entries(SPEC_COLUMNS)) {
      const info = sql.all<{ name: string }>(`PRAGMA table_info(${table})`);
      // The spec's columns first, in order, then any added in a later
      // schema version (M2 adds columns to doorbells and sessions, V4_ADDED).
      expect(info.map((c) => c.name), table).toEqual([...columns, ...(V4_ADDED[table] ?? [])]);
    }
    expect(SPEC_SCHEMA.filter((s) => s.startsWith("CREATE TABLE"))).toHaveLength(11);
    const idx = sql.one("SELECT name FROM sqlite_master WHERE name = 'timers_due'");
    expect(idx).toBeDefined();
  });

  it("records the schema version and is idempotent", () => {
    const sql = new NodeSqliteSql();
    migrate(sql, 0);
    migrate(sql, 0);
    expect(sql.one("SELECT value FROM meta WHERE key = 'schema_version'")).toEqual({
      value: String(SCHEMA_VERSION),
    });
  });

  it("upgrades a version 1 database (M1) stepwise: task indexes, then the M4a tables", () => {
    const sql = new NodeSqliteSql();
    migrate(sql, 0);
    // Rebuild the version 1 state: drop what versions 2 and 3 added.
    downToV2(sql);
    for (const ddl of V2_INDEXES) {
      const name = /CREATE INDEX (\w+)/.exec(ddl)?.[1] ?? "";
      sql.exec(`DROP INDEX ${name}`);
    }
    sql.exec("UPDATE meta SET value = '1' WHERE key = 'schema_version'");
    migrate(sql, 0);
    expect(SCHEMA_VERSION).toBe(19);
    expect(sql.one("SELECT value FROM meta WHERE key = 'schema_version'")).toEqual({ value: String(SCHEMA_VERSION) });
    for (const t of ["admin_events", "revoked_tokens"]) {
      expect(sql.one("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", t), t).toBeDefined();
    }
    expect(sql.one("SELECT created_by FROM topics WHERE name = ?", ADMIN_LOG)).toEqual({ created_by: "system" });
    const names = sql
      .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'index'")
      .map((r) => r.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "tasks_assignee_state",
        "task_blocks_blocked_by",
        "task_comments_task",
        "timers_kind_ref",
      ]),
    );
    expect(V2_INDEXES).toHaveLength(4);
    migrate(sql, 0);
  });

  it("creates #admin-log on a fresh board, with the same text the upgrade uses", () => {
    const fresh = new NodeSqliteSql();
    migrate(fresh, 5);
    const upgraded = new NodeSqliteSql();
    migrate(upgraded, 5);
    downToV2(upgraded);
    migrate(upgraded, 5);
    const pick = "SELECT name, description, created_by, state FROM topics WHERE name = 'admin-log'";
    expect(upgraded.one(pick)).toEqual(fresh.one(pick));
    expect(fresh.one(pick)).toMatchObject({ created_by: "system", state: "active" });
  });

  it("renames user topics that look like #admin-log when upgrading from version 2 (review m4)", () => {
    const sql = new NodeSqliteSql();
    migrate(sql, 0);
    downToV2(sql);
    sql.exec("INSERT INTO users (handle, kind, created_at) VALUES ('alice', 'agent', 0)");
    for (const name of ["admin-log", "Admin-Log", "user-admin-log"]) {
      sql.exec(
        "INSERT INTO topics (name, description, created_by, last_activity_at) VALUES (?, 'mine', 'alice', 1)",
        name,
      );
    }
    sql.exec(
      `INSERT INTO messages (topic, author, author_kind, via, body, created_at)
       VALUES ('Admin-Log', 'alice', 'agent', 'mcp', 'hello', 1)`,
    );
    sql.exec("INSERT INTO subscriptions (handle, topic, level) VALUES ('alice', 'admin-log', 'wake')");
    sql.exec(
      `INSERT INTO tasks (topic, title, state, created_by, created_at, updated_at)
       VALUES ('admin-log', 't', 'open', 'alice', 1, 1)`,
    );
    migrate(sql, 1_234_567);
    const topics = sql
      .all<{ name: string; created_by: string; last_activity_at: number }>(
        "SELECT name, created_by, last_activity_at FROM topics WHERE lower(name) LIKE '%admin-log%' ORDER BY name",
      )
      .map((t) => [t.name, t.created_by, Number(t.last_activity_at)]);
    expect(topics).toEqual([
      ["admin-log", "system", 1_234_567],
      // New names are unique without regard to case, like topic_create.
      ["user-Admin-Log-2", "alice", 1],
      ["user-admin-log", "alice", 1],
      ["user-admin-log-3", "alice", 1],
    ]);
    expect(sql.one("SELECT topic FROM messages WHERE body = 'hello'")).toEqual({ topic: "user-Admin-Log-2" });
    expect(sql.one("SELECT topic FROM subscriptions WHERE handle = 'alice'")).toEqual({ topic: "user-admin-log-3" });
    expect(sql.one("SELECT topic FROM tasks")).toEqual({ topic: "user-admin-log-3" });
    expect(JSON.parse(String(sql.one<{ value: string }>("SELECT value FROM meta WHERE key = 'v3_renamed_topics'")?.value))).toEqual([
      { from: "Admin-Log", to: "user-Admin-Log-2" },
      { from: "admin-log", to: "user-admin-log-3" },
    ]);
  });

  it("refuses a version below 1 or above the current one", () => {
    for (const v of ["0", "abc", String(SCHEMA_VERSION + 1)]) {
      const sql = new NodeSqliteSql();
      migrate(sql, 0);
      sql.exec("UPDATE meta SET value = ? WHERE key = 'schema_version'", v);
      expect(() => migrate(sql, 0)).toThrow(/unsupported schema version/);
    }
  });

  it("refuses a database with another schema version", () => {
    const sql = new NodeSqliteSql();
    migrate(sql, 0);
    sql.exec("UPDATE meta SET value = '99' WHERE key = 'schema_version'");
    expect(() => migrate(sql, 0)).toThrow(/unsupported schema version 99/);
  });

  it("enforces the spec's CHECK constraints", () => {
    const sql = new NodeSqliteSql();
    migrate(sql, 0);
    expect(() =>
      sql.exec("INSERT INTO users (handle, kind, created_at) VALUES ('x', 'robot', 0)"),
    ).toThrow();
    expect(() =>
      sql.exec(
        "INSERT INTO audit (ts, actor, actor_kind, via, action, result) " +
          "VALUES (0, 'a', 'agent', 'mcp', 'x', 'maybe')",
      ),
    ).toThrow();
  });

  it("rolls back a failed transaction and refuses nesting", () => {
    const sql = new NodeSqliteSql();
    migrate(sql, 0);
    expect(() =>
      sql.transaction(() => {
        sql.exec("INSERT INTO users (handle, kind, created_at) VALUES ('a', 'agent', 0)");
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(sql.one("SELECT handle FROM users")).toBeUndefined();
    expect(() => sql.transaction(() => sql.transaction(() => 1))).toThrow(/nested/);
  });
});

describe("NodeSqliteSql parity with Durable Object SQL (B8)", () => {
  it("binds at most 100 parameters per statement", () => {
    const sql = new NodeSqliteSql();
    const q = (n: number) => `SELECT 1 IN (${Array.from({ length: n }, () => "?").join(", ")}) AS hit`;
    const vals = (n: number) => Array.from({ length: n }, (_, i) => i);
    expect(sql.one(q(100), ...vals(100))).toEqual({ hit: 1 });
    expect(() => sql.one(q(101), ...vals(101))).toThrow("too many SQL variables");
    expect(() => sql.all(q(101), ...vals(101))).toThrow("too many SQL variables");
    expect(() => sql.exec(q(101), ...vals(101))).toThrow("too many SQL variables");
  });
});

describe("schema version 4 (M2)", () => {
  it("upgrades a version 3 database: notices table, doorbell and session columns", () => {
    const sql = new NodeSqliteSql();
    migrate(sql, 0);
    downToV3(sql);
    sql.exec("INSERT INTO users (handle, kind, created_at) VALUES ('alice', 'agent', 0)");
    sql.exec("INSERT INTO sessions (id, handle, state, attached_at) VALUES ('s1', 'alice', 'idle', 0)");
    sql.exec("INSERT INTO sessions (id, handle, state, attached_at) VALUES ('s2', 'alice', 'busy', 0)");
    migrate(sql, 1234);
    // Busy sessions get busy_since = the upgrade time (M2 security review).
    // Users past the new subscription cap are counted, not trimmed.
    expect(sql.one("SELECT value FROM meta WHERE key = 'v4_users_over_subscription_cap'")).toEqual({ value: "0" });
    expect(sql.all("SELECT id, busy_since FROM sessions ORDER BY id")).toEqual([
      { id: "s1", busy_since: null },
      { id: "s2", busy_since: 1234 },
    ]);
    expect(sql.one("SELECT value FROM meta WHERE key = 'schema_version'")).toEqual({ value: String(SCHEMA_VERSION) });
    expect(sql.one("SELECT ws_open FROM sessions WHERE id = 's1'")).toEqual({ ws_open: 0 });
    expect(sql.one("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'notices'")).toBeDefined();
    const cols = sql.all<{ name: string }>("PRAGMA table_info(doorbells)").map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining(["id", "due_at", "held_at", "session"]));
  });

  it("counts users past the subscription cap, not those at it, and keeps every subscription (F review N08)", () => {
    const sql = new NodeSqliteSql();
    migrate(sql, 0);
    downToV3(sql);
    const cap = DEFAULT_CONFIG.maxSubscriptionsPerUser;
    sql.exec("INSERT INTO users (handle, kind, created_at) VALUES ('at', 'agent', 0), ('over', 'agent', 0), ('offs', 'agent', 0)");
    for (let i = 0; i <= cap; i++) {
      sql.exec("INSERT INTO topics (name, created_by, last_activity_at) VALUES (?, 'at', 0)", `t${i}`);
      if (i < cap) sql.exec("INSERT INTO subscriptions (handle, topic, level) VALUES ('at', ?, 'wake')", `t${i}`);
      sql.exec("INSERT INTO subscriptions (handle, topic, level) VALUES ('over', ?, 'digest')", `t${i}`);
      // `off` subscriptions do not count toward the cap.
      sql.exec("INSERT INTO subscriptions (handle, topic, level) VALUES ('offs', ?, ?)", `t${i}`, i === 0 ? "wake" : "off");
    }
    migrate(sql, 0);
    expect(sql.one("SELECT value FROM meta WHERE key = 'v4_users_over_subscription_cap'")).toEqual({ value: "1" });
    expect(sql.one("SELECT COUNT(*) AS n FROM subscriptions WHERE handle = 'over'")).toEqual({ n: cap + 1 });
  });

  it("fills message_mentions from the messages already on the board", () => {
    const sql = new NodeSqliteSql();
    migrate(sql, 0);
    downToV3(sql);
    sql.exec("INSERT INTO users (handle, kind, created_at) VALUES ('alice', 'agent', 0), ('bob', 'agent', 0)");
    sql.exec(
      `INSERT INTO messages (topic, author, author_kind, via, body, mentions, is_system, created_at)
       VALUES ('Lobby', 'alice', 'agent', 'api', '@bob hi', '["bob"]', 0, 0),
              ('Lobby', 'bob', 'agent', 'api', 'plain', '[]', 0, 0)`,
    );
    migrate(sql, 0);
    expect(sql.all("SELECT handle, seq FROM message_mentions")).toEqual([
      { handle: "bob", seq: expect.any(Number) },
    ]);
  });
});

describe("schema version 5 (M6b)", () => {
  it("upgrades a version 4 database: topic archive and cold columns, task topic index; rows kept", () => {
    const sql = new NodeSqliteSql();
    migrate(sql, 0);
    downToV4(sql);
    sql.exec("INSERT INTO topics (name, created_by, last_activity_at) VALUES ('t', 'alice', 5)");
    migrate(sql, 1234);
    expect(sql.one("SELECT value FROM meta WHERE key = 'schema_version'")).toEqual({ value: String(SCHEMA_VERSION) });
    expect(sql.one("SELECT name, state, archive_notice_at, cold_key FROM topics WHERE name = 't'")).toEqual({
      name: "t",
      state: "active",
      archive_notice_at: null,
      cold_key: null,
    });
    expect(sql.one("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'tasks_topic_updated'")).toBeDefined();
  });
});

describe("schema version 6 (B56)", () => {
  it("upgrades a version 5 database: doorbells.confirmed added, doorbell rows kept", () => {
    const sql = new NodeSqliteSql();
    migrate(sql, 0);
    downToV5(sql);
    sql.exec("INSERT INTO users (handle, kind, created_at) VALUES ('alice', 'agent', 0)");
    sql.exec(
      `INSERT INTO doorbells (handle, first_event_at, summary, sent_at, acked_at, id, session)
       VALUES ('alice', 7, '{}', 8, 9, 'd_1', 's_1')`,
    );
    migrate(sql, 1234);
    expect(sql.one("SELECT value FROM meta WHERE key = 'schema_version'")).toEqual({ value: String(SCHEMA_VERSION) });
    expect(sql.one("SELECT handle, first_event_at, sent_at, acked_at, id, session, confirmed FROM doorbells")).toEqual({
      handle: "alice",
      first_event_at: 7,
      sent_at: 8,
      acked_at: 9,
      id: "d_1",
      session: "s_1",
      confirmed: null,
    });
  });
});

describe("schema version 7 (G1, B34)", () => {
  it("upgrades a version 6 database: admin_events.step added, offense rows kept with step NULL", () => {
    const sql = new NodeSqliteSql();
    migrate(sql, 0);
    downToV6(sql);
    sql.exec("INSERT INTO users (handle, kind, created_at) VALUES ('alice', 'agent', 0)");
    sql.exec("INSERT INTO admin_events (kind, handle, topic, at) VALUES ('lobby_flood', 'alice', 'Lobby', 5)");
    migrate(sql, 1234);
    expect(sql.one("SELECT value FROM meta WHERE key = 'schema_version'")).toEqual({ value: String(SCHEMA_VERSION) });
    expect(sql.one("SELECT kind, handle, topic, at, step FROM admin_events")).toEqual({
      kind: "lobby_flood",
      handle: "alice",
      topic: "Lobby",
      at: 5,
      step: null,
    });
  });
});

describe("schema version 8 (issue #47, web sign-in by pairing code)", () => {
  it("upgrades a version 7 database: the pairing and session tables are added, existing rows kept", () => {
    const sql = new NodeSqliteSql();
    migrate(sql, 0);
    downToV7(sql);
    expect(sql.one("SELECT name FROM sqlite_master WHERE name = 'web_pairings'")).toBeUndefined();
    sql.exec("INSERT INTO users (handle, kind, created_at) VALUES ('alice', 'agent', 0)");
    sql.exec("INSERT INTO admin_events (kind, handle, topic, at, step) VALUES ('lobby_flood', 'alice', 'Lobby', 5, 2)");
    migrate(sql, 1234);
    expect(SCHEMA_VERSION).toBe(19);
    expect(sql.one("SELECT value FROM meta WHERE key = 'schema_version'")).toEqual({ value: String(SCHEMA_VERSION) });
    expect(sql.one("SELECT handle, step FROM admin_events")).toEqual({ handle: "alice", step: 2 });
    for (const t of ["web_pairings", "web_sessions"]) {
      expect(sql.one("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", t), t).toBeDefined();
    }
    sql.exec(
      `INSERT INTO web_sessions (id, handle, token_hash, label, created_at, renewed_at, expires_at)
       VALUES ('ws_1', 'alice', 'h', 'l', 1, 1, 2)`,
    );
    migrate(sql, 1234);
  });

  it("a fresh database and an upgraded one have the same web tables", () => {
    const fresh = new NodeSqliteSql();
    migrate(fresh, 0);
    const upgraded = new NodeSqliteSql();
    migrate(upgraded, 0);
    downToV7(upgraded);
    migrate(upgraded, 0);
    const pick = "SELECT name, sql FROM sqlite_master WHERE name LIKE 'web_%' ORDER BY name";
    expect(upgraded.all(pick)).toEqual(fresh.all(pick));
    // web_pairings, web_sessions, its handle index, and (version 14) its passkey index.
    expect(fresh.all(pick)).toHaveLength(4);
  });
});

describe("schema version 9 (issue #55, OAuth on /mcp for remote connectors)", () => {
  const OAUTH_TABLES = ["oauth_clients", "oauth_requests", "oauth_grants", "oauth_codes", "oauth_tokens"];

  it("upgrades a version 8 database: the OAuth tables are added, existing rows kept", () => {
    const sql = new NodeSqliteSql();
    migrate(sql, 0);
    downToV8(sql);
    for (const t of OAUTH_TABLES) {
      expect(sql.one("SELECT name FROM sqlite_master WHERE name = ?", t), t).toBeUndefined();
    }
    sql.exec("INSERT INTO users (handle, kind, created_at) VALUES ('alice', 'agent', 0)");
    sql.exec(
      `INSERT INTO web_sessions (id, handle, token_hash, label, created_at, renewed_at, expires_at)
       VALUES ('ws_1', 'alice', 'h', 'l', 1, 1, 2)`,
    );
    migrate(sql, 1234);
    expect(SCHEMA_VERSION).toBe(19);
    expect(sql.one("SELECT value FROM meta WHERE key = 'schema_version'")).toEqual({ value: String(SCHEMA_VERSION) });
    expect(sql.one("SELECT handle FROM web_sessions")).toEqual({ handle: "alice" });
    for (const t of OAUTH_TABLES) {
      expect(sql.one("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", t), t).toBeDefined();
    }
    sql.exec(
      `INSERT INTO oauth_grants (id, client_id, client_name, client_host, handle, approved_by, created_at, renewed_at, expires_at)
       VALUES ('og_1', 'https://c.example/id', 'C', 'c.example', 'alice', 'alice', 1, 1, 2)`,
    );
    migrate(sql, 1234);
  });

  it("a fresh database and an upgraded one have the same OAuth tables and indexes", () => {
    const fresh = new NodeSqliteSql();
    migrate(fresh, 0);
    const upgraded = new NodeSqliteSql();
    migrate(upgraded, 0);
    downToV8(upgraded);
    migrate(upgraded, 0);
    const pick = "SELECT name, sql FROM sqlite_master WHERE name LIKE 'oauth_%' ORDER BY name";
    expect(upgraded.all(pick)).toEqual(fresh.all(pick));
    // Six tables (the sixth is version 10's assertion table), the indexes, and the unique and primary-key autoindexes.
    expect(fresh.all("SELECT name FROM sqlite_master WHERE name LIKE 'oauth_%' AND type = 'table'")).toHaveLength(6);
  });
});

describe("schema version 10 (issue #55, client authentication with private_key_jwt)", () => {
  it("upgrades a version 9 database: client rows become public clients, and the assertion table is added", () => {
    const sql = new NodeSqliteSql();
    migrate(sql, 0);
    downToV9(sql);
    expect(sql.one("SELECT name FROM sqlite_master WHERE name = 'oauth_client_jtis'")).toBeUndefined();
    sql.exec("INSERT INTO oauth_clients (client_id, name, redirect_uris, fetched_at) VALUES ('https://c.example/id', 'C', '[]', 5)");
    migrate(sql, 1234);
    expect(sql.one("SELECT value FROM meta WHERE key = 'schema_version'")).toEqual({ value: String(SCHEMA_VERSION) });
    expect(sql.one("SELECT auth_method, auth_alg, jwks_uri, jwks, jwks_fetched_at FROM oauth_clients")).toEqual({
      auth_method: "none",
      auth_alg: null,
      jwks_uri: null,
      jwks: null,
      jwks_fetched_at: 0,
    });
    expect(sql.one("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'oauth_client_jtis'")).toBeDefined();
    // A method outside the two is refused by the column, and a jti is unique per client.
    expect(() => sql.exec("UPDATE oauth_clients SET auth_method = 'client_secret_basic'")).toThrow();
    sql.exec("INSERT INTO oauth_client_jtis (client_id, jti_hash, expires_at) VALUES ('c', 'h', 1)");
    expect(() => sql.exec("INSERT INTO oauth_client_jtis (client_id, jti_hash, expires_at) VALUES ('c', 'h', 2)")).toThrow();
    sql.exec("INSERT INTO oauth_client_jtis (client_id, jti_hash, expires_at) VALUES ('d', 'h', 2)");
    migrate(sql, 1234);
  });

  it("a fresh database and an upgraded one have the same OAuth client tables", () => {
    const fresh = new NodeSqliteSql();
    migrate(fresh, 0);
    const upgraded = new NodeSqliteSql();
    migrate(upgraded, 0);
    downToV9(upgraded);
    migrate(upgraded, 0);
    const pick = "SELECT name, sql FROM sqlite_master WHERE name LIKE 'oauth_client%' ORDER BY name";
    expect(upgraded.all(pick)).toEqual(fresh.all(pick));
  });
});

describe("schema version 11 (session labels)", () => {
  it("upgrades a version 10 database: sessions keep working with null os and model", () => {
    const sql = new NodeSqliteSql();
    migrate(sql, 0);
    downToV10(sql);
    sql.exec("INSERT INTO users (handle, kind, created_at) VALUES ('alice', 'agent', 0)");
    sql.exec("INSERT INTO sessions (id, handle, machine, state, attached_at) VALUES ('s1', 'alice', 'workstation-1', 'idle', 0)");
    migrate(sql, 1234);
    expect(sql.one("SELECT value FROM meta WHERE key = 'schema_version'")).toEqual({ value: String(SCHEMA_VERSION) });
    expect(sql.one("SELECT id, handle, machine, os, model, state FROM sessions")).toEqual({
      id: "s1",
      handle: "alice",
      machine: "workstation-1",
      os: null,
      model: null,
      state: "idle",
    });
    sql.exec("UPDATE sessions SET os = 'Linux', model = 'm' WHERE id = 's1'");
    expect(sql.one("SELECT os, model FROM sessions")).toEqual({ os: "Linux", model: "m" });
  });

  it("upgrades a version 11 database: the audit and session indexes are added, rows kept", () => {
    const sql = new NodeSqliteSql();
    migrate(sql, 0);
    const before = sql.all("SELECT seq, action FROM audit ORDER BY seq");
    downToV11(sql);
    const index = "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'audit_action_actor_seq'";
    expect(sql.one(index)).toBeUndefined();
    migrate(sql, 1234);
    expect(sql.one("SELECT value FROM meta WHERE key = 'schema_version'")).toEqual({ value: String(SCHEMA_VERSION) });
    expect(sql.one(index)).toEqual({ name: "audit_action_actor_seq" });
    expect(sql.all("SELECT seq, action FROM audit ORDER BY seq")).toEqual(before);
    expect(
      sql.all<{ name: string }>("PRAGMA index_info(audit_action_actor_seq)").map((c) => c.name),
    ).toEqual(["action", "actor", "seq"]);
    expect(
      sql.all<{ name: string }>("PRAGMA index_info(sessions_handle_attached)").map((c) => c.name),
    ).toEqual(["handle", "attached_at"]);
  });

  it("a fresh database and an upgraded one have the same sessions table", () => {
    const fresh = new NodeSqliteSql();
    migrate(fresh, 0);
    const upgraded = new NodeSqliteSql();
    migrate(upgraded, 0);
    downToV10(upgraded);
    migrate(upgraded, 0);
    const cols = "SELECT name FROM pragma_table_info('sessions') ORDER BY cid";
    expect(upgraded.all(cols)).toEqual(fresh.all(cols));
  });
});

describe("schema version 13 (connector sessions)", () => {
  it("upgrades a version 12 database: sessions keep their rows, with no hash and not via a grant", () => {
    const sql = new NodeSqliteSql();
    migrate(sql, 0);
    downToV12(sql);
    sql.exec("INSERT INTO users (handle, kind, created_at) VALUES ('alice', 'agent', 0)");
    sql.exec("INSERT INTO sessions (id, handle, state, attached_at) VALUES ('s1', 'alice', 'idle', 0)");
    migrate(sql, 1234);
    expect(sql.one("SELECT value FROM meta WHERE key = 'schema_version'")).toEqual({ value: String(SCHEMA_VERSION) });
    expect(sql.one("SELECT id, handle, mcp_session_hash, via_grant FROM sessions")).toEqual({
      id: "s1",
      handle: "alice",
      mcp_session_hash: null,
      via_grant: 0,
    });
    for (const name of ["sessions_handle_mcp", "audit_session_ts"]) {
      expect(sql.one("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?", name), name).toBeDefined();
    }
  });

  it("an upgraded database has the same schema as a fresh one", () => {
    const fresh = new NodeSqliteSql();
    migrate(fresh, 0);
    const upgraded = new NodeSqliteSql();
    migrate(upgraded, 0);
    downToV12(upgraded);
    migrate(upgraded, 0);
    const pick = "SELECT name FROM sqlite_master WHERE name LIKE 'sessions%' OR name LIKE 'audit_session%' ORDER BY name";
    expect(upgraded.all(pick)).toEqual(fresh.all(pick));
    expect(upgraded.all("PRAGMA table_info(sessions)").map((c) => c.name)).toEqual(
      fresh.all("PRAGMA table_info(sessions)").map((c) => c.name),
    );
  });
});

describe("schema version 14 (passkey sign-in)", () => {
  it("upgrades a version 13 database: existing sessions are pairing sessions with no passkey, the passkey tables are added", () => {
    const sql = new NodeSqliteSql();
    migrate(sql, 0);
    sql.exec("INSERT INTO users (handle, kind, created_at) VALUES ('owner', 'human', 0)");
    sql.exec("INSERT INTO web_sessions (id, handle, token_hash, label, created_at, renewed_at, expires_at) VALUES ('ws_1', 'owner', 'h', 'Chrome', 1, 1, 2)");
    downToV13(sql);
    expect(sql.one("SELECT name FROM sqlite_master WHERE name = 'passkeys'")).toBeUndefined();
    migrate(sql, 1234);
    expect(sql.one("SELECT value FROM meta WHERE key = 'schema_version'")).toEqual({ value: String(SCHEMA_VERSION) });
    expect(sql.one("SELECT id, label, method, passkey FROM web_sessions")).toEqual({ id: "ws_1", label: "Chrome", method: "pairing", passkey: null });
    for (const t of ["passkeys", "passkey_users", "passkey_challenges"]) {
      expect(sql.one(`SELECT COUNT(*) AS n FROM ${t}`), t).toEqual({ n: 0 });
    }
    expect(() => sql.exec("UPDATE web_sessions SET method = 'other'")).toThrow();
    sql.exec("UPDATE web_sessions SET method = 'passkey'");
  });

  it("a fresh database and an upgraded one have the same passkey tables and session columns", () => {
    const fresh = new NodeSqliteSql();
    migrate(fresh, 0);
    const upgraded = new NodeSqliteSql();
    migrate(upgraded, 0);
    downToV13(upgraded);
    migrate(upgraded, 0);
    const pick = "SELECT name, sql FROM sqlite_master WHERE name LIKE 'passkey%' OR name = 'web_sessions_passkey' ORDER BY name";
    expect(upgraded.all(pick)).toEqual(fresh.all(pick));
    expect(fresh.all(pick).length).toBeGreaterThan(3);
    const cols = "SELECT name FROM pragma_table_info('web_sessions') ORDER BY cid";
    expect(upgraded.all(cols)).toEqual(fresh.all(cols));
  });

  it("steps from a version 12 database through 13 to 14", () => {
    const sql = new NodeSqliteSql();
    migrate(sql, 0);
    downToV12(sql);
    expect(sql.one("SELECT value FROM meta WHERE key = 'schema_version'")).toEqual({ value: "12" });
    migrate(sql, 1);
    expect(sql.one("SELECT value FROM meta WHERE key = 'schema_version'")).toEqual({ value: String(SCHEMA_VERSION) });
  });
});

describe("schema version 15 (new-topic announcements, issue #80)", () => {
  it("upgrades a version 14 database: existing topics are not pending", () => {
    const sql = new NodeSqliteSql();
    migrate(sql, 0);
    sql.exec("INSERT INTO topics (name, created_by, last_activity_at) VALUES ('work', 'system', 0)");
    downToV14(sql);
    expect(sql.all("SELECT name FROM pragma_table_info('topics')").map((c) => c.name)).not.toContain("announce_pending");
    migrate(sql, 1234);
    expect(sql.one("SELECT value FROM meta WHERE key = 'schema_version'")).toEqual({ value: String(SCHEMA_VERSION) });
    expect(sql.all("SELECT name, announce_pending FROM topics ORDER BY name")).toEqual([
      { name: "Lobby", announce_pending: 0 },
      { name: "admin-log", announce_pending: 0 },
      { name: "work", announce_pending: 0 },
    ]);
    expect(() => sql.exec("UPDATE topics SET announce_pending = 2")).toThrow();
  });

  it("a fresh database and an upgraded one have the same topics columns", () => {
    const fresh = new NodeSqliteSql();
    migrate(fresh, 0);
    const upgraded = new NodeSqliteSql();
    migrate(upgraded, 0);
    downToV14(upgraded);
    migrate(upgraded, 0);
    const cols = "SELECT name, type, \"notnull\", dflt_value FROM pragma_table_info('topics') ORDER BY cid";
    expect(upgraded.all(cols)).toEqual(fresh.all(cols));
  });
});

describe("schema version 16 (passkeys as approvers, issue #54)", () => {
  it("upgrades a version 15 database: the approvals table and the pairing column are added, rows kept", () => {
    const sql = new NodeSqliteSql();
    migrate(sql, 0);
    sql.exec(
      "INSERT INTO web_pairings (code_hash, poll_hash, label, source, created_at, expires_at) VALUES ('c', 'p', 'Chrome', 's', 1, 2)",
    );
    downToV15(sql);
    expect(sql.one("SELECT name FROM sqlite_master WHERE name = 'approvals'")).toBeUndefined();
    migrate(sql, 1234);
    expect(sql.one("SELECT value FROM meta WHERE key = 'schema_version'")).toEqual({ value: String(SCHEMA_VERSION) });
    expect(sql.all("SELECT label, approval_hash FROM web_pairings")).toEqual([{ label: "Chrome", approval_hash: null }]);
    expect(sql.all("SELECT COUNT(*) AS n FROM approvals")).toEqual([{ n: 0 }]);
  });

  it("a fresh database and an upgraded one have the same approvals table and pairing columns", () => {
    const fresh = new NodeSqliteSql();
    migrate(fresh, 0);
    const upgraded = new NodeSqliteSql();
    migrate(upgraded, 0);
    downToV15(upgraded);
    migrate(upgraded, 0);
    for (const table of ["approvals", "web_pairings"]) {
      const cols = `SELECT name, type, "notnull", dflt_value FROM pragma_table_info('${table}') ORDER BY cid`;
      expect(upgraded.all(cols), table).toEqual(fresh.all(cols));
    }
    const idx = "SELECT name, tbl_name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'approvals' ORDER BY name";
    expect(upgraded.all(idx)).toEqual(fresh.all(idx));
  });

  it("the state and action columns are constrained", () => {
    const sql = new NodeSqliteSql();
    migrate(sql, 0);
    sql.exec("INSERT INTO users (handle, kind, created_at) VALUES ('owner', 'human', 0)");
    const insert = (action: string, state: string) =>
      sql.exec(
        `INSERT INTO approvals (id, id_hash, handle, action, ref, target, scope, nonce, match_code, state, requested_via, created_at, expires_at)
         VALUES ('ap_x', 'h', 'owner', ?, 'r', 't', '{}', 'n', 'ABCDEF', ?, 'cli', 0, 1)`,
        action,
        state,
      );
    expect(() => insert("admin_user_add", "pending")).toThrow();
    expect(() => insert("oauth_decide", "decided")).toThrow();
    expect(() => insert("oauth_decide", "pending")).not.toThrow();
  });
});

describe("schema version 17 (case-insensitive handles, issue #90)", () => {
  it("upgrades a version 16 database: the users handle index is added, rows kept", () => {
    const sql = new NodeSqliteSql();
    migrate(sql, 0);
    sql.exec("INSERT INTO users (handle, kind, created_at) VALUES ('Owner', 'human', 1)");
    downToV16(sql);
    expect(sql.one("SELECT name FROM sqlite_master WHERE name = 'users_handle_nocase'")).toBeUndefined();
    migrate(sql, 1234);
    expect(sql.one("SELECT value FROM meta WHERE key = 'schema_version'")).toEqual({ value: "19" });
    expect(sql.all("SELECT handle FROM users")).toEqual([{ handle: "Owner" }]);
    expect(sql.one("SELECT name FROM sqlite_master WHERE name = 'users_handle_nocase'")).toBeDefined();
  });

  it("the index is not unique, so a board that already holds two spellings still upgrades", () => {
    const sql = new NodeSqliteSql();
    migrate(sql, 0);
    downToV16(sql);
    sql.exec("INSERT INTO users (handle, kind, created_at) VALUES ('Owner', 'human', 1)");
    sql.exec("INSERT INTO users (handle, kind, created_at) VALUES ('owner', 'agent', 2)");
    expect(() => migrate(sql, 1234)).not.toThrow();
    expect(sql.all("SELECT COUNT(*) AS n FROM users WHERE handle COLLATE NOCASE = 'OWNER'")).toEqual([{ n: 2 }]);
  });

  it("a fresh database and an upgraded one have the same users indexes", () => {
    const fresh = new NodeSqliteSql();
    migrate(fresh, 0);
    const upgraded = new NodeSqliteSql();
    migrate(upgraded, 0);
    downToV16(upgraded);
    migrate(upgraded, 0);
    const idx = "SELECT name, tbl_name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'users' ORDER BY name";
    expect(upgraded.all(idx)).toEqual(fresh.all(idx));
  });
});

describe("schema version 18 (the grant of a connector session, issue #86)", () => {
  it("upgrades a version 17 database: sessions.grant_id is added and NULL on existing rows", () => {
    const sql = new NodeSqliteSql();
    migrate(sql, 0);
    sql.exec("INSERT INTO users (handle, kind, created_at) VALUES ('claude-ai', 'agent', 1)");
    sql.exec("INSERT INTO sessions (id, handle, state, attached_at, via_grant) VALUES ('s_old', 'claude-ai', 'idle', 1, 1)");
    downToV17(sql);
    expect(sql.all("SELECT name FROM pragma_table_info('sessions') WHERE name = 'grant_id'")).toEqual([]);
    migrate(sql, 1234);
    expect(sql.one("SELECT value FROM meta WHERE key = 'schema_version'")).toEqual({ value: "19" });
    expect(sql.all("SELECT id, via_grant, grant_id FROM sessions")).toEqual([{ id: "s_old", via_grant: 1, grant_id: null }]);
  });

  it("a fresh database and an upgraded one have the same sessions columns", () => {
    const fresh = new NodeSqliteSql();
    migrate(fresh, 0);
    const upgraded = new NodeSqliteSql();
    migrate(upgraded, 0);
    downToV17(upgraded);
    migrate(upgraded, 0);
    const cols = "SELECT name, type FROM pragma_table_info('sessions') ORDER BY name";
    expect(upgraded.all(cols)).toEqual(fresh.all(cols));
  });
});

describe("schema version 19 (a handle per local session, issue #98)", () => {
  it("upgrades a version 18 database: the users columns are added and NULL on existing rows, rows kept", () => {
    const sql = new NodeSqliteSql();
    migrate(sql, 0);
    sql.exec("INSERT INTO users (handle, kind, created_at) VALUES ('alice', 'agent', 1)");
    downToV18(sql);
    const cols = () => sql.all<{ name: string }>("SELECT name FROM pragma_table_info('users')").map((c) => c.name);
    for (const c of ["parent", "harness_session", "retired_at"]) expect(cols()).not.toContain(c);
    migrate(sql, 1234);
    expect(sql.one("SELECT value FROM meta WHERE key = 'schema_version'")).toEqual({ value: "19" });
    expect(sql.all("SELECT handle, parent, harness_session, retired_at FROM users")).toEqual([
      { handle: "alice", parent: null, harness_session: null, retired_at: null },
    ]);
  });

  it("a fresh database and an upgraded one have the same users columns and indexes", () => {
    const fresh = new NodeSqliteSql();
    migrate(fresh, 0);
    const upgraded = new NodeSqliteSql();
    migrate(upgraded, 0);
    downToV18(upgraded);
    migrate(upgraded, 0);
    const cols = "SELECT name, type FROM pragma_table_info('users') ORDER BY cid";
    expect(upgraded.all(cols)).toEqual(fresh.all(cols));
    const idx = "SELECT name, tbl_name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'users' ORDER BY name";
    expect(upgraded.all(idx)).toEqual(fresh.all(idx));
    expect(fresh.all(idx).map((i) => i.name)).toEqual(
      expect.arrayContaining(["users_parent", "users_parent_harness_session", "users_handle_nocase"]),
    );
  });

  it("a row with a parent is an agent with no token and no flag; a harness session is unique per parent", () => {
    const sql = new NodeSqliteSql();
    migrate(sql, 0);
    const make = (handle: string, parent: string | null, hs: string | null, extra = "") =>
      sql.exec(
        `INSERT INTO users (handle, kind, created_at, parent, harness_session${extra ? ", " + extra.split("=")[0] : ""})
         VALUES (?, 'agent', 1, ?, ?${extra ? ", " + extra.split("=")[1] : ""})`,
        handle,
        parent,
        hs,
      );
    make("p", null, null);
    make("q", null, null);
    make("p-aaaa", "p", "hs");
    expect(() => make("p-bbbb", "p", "hs")).toThrow(/UNIQUE/);
    make("q-aaaa", "q", "hs");
    make("p-cccc", "p", null);
    make("p-dddd", "p", null);
    expect(() => make("p-eeee", "p", "x", "is_coordinator=1")).toThrow();
    expect(() => make("p-ffff", "p", "y", "token_hash='t'")).toThrow();
    expect(() => make("p-gggg", "p", "z", "is_admin=1")).toThrow();
    expect(() => sql.exec("INSERT INTO users (handle, kind, created_at, parent) VALUES ('p-hhhh', 'human', 1, 'p')")).toThrow();
  });

  it("the upgrade runs on a board that already holds users and sessions", () => {
    const sql = new NodeSqliteSql();
    migrate(sql, 0);
    sql.exec("INSERT INTO users (handle, kind, is_coordinator, token_hash, created_at) VALUES ('boss', 'agent', 1, 'h', 1)");
    sql.exec("INSERT INTO sessions (id, handle, state, attached_at) VALUES ('s_1', 'boss', 'idle', 1)");
    downToV18(sql);
    expect(() => migrate(sql, 5)).not.toThrow();
    expect(sql.all("SELECT handle, is_coordinator FROM users")).toEqual([{ handle: "boss", is_coordinator: 1 }]);
  });
});

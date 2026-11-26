// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0

import type { Sql, SqlValue } from "../sql.ts";
import { BbsError, type Tx } from "../types.ts";

export const LOBBY = "Lobby";

export interface TopicRow {
  name: string;
  description: string;
  created_by: string;
  state: "active" | "archived" | "cold";
  keep: number;
  last_activity_at: number;
  archived_at: number | null;
  archived_by: string | null;
  archive_reason: string | null;
  archive_notice_at: number | null;
  cold_key: string | null;
  cold_sha256: string | null;
  cold_bytes: number | null;
  cold_at: number | null;
  cold_last_seq: number | null;
  cold_attempt_at: number | null;
  cold_pending: string | null;
  cold_conflict_at: number | null;
  [key: string]: unknown;
}

/**
 * The stored spelling of the account whose handle matches `given` without
 * regard to case (issue #90; ASCII fold, `COLLATE NOCASE`), or undefined.
 * Every handle that arrives from a caller goes through here once; after it,
 * code keeps the stored spelling, so foreign keys and audit rows agree. A
 * board that held two handles differing only by case before the rule existed
 * answers deterministically: the exact-case match, else the oldest account.
 */
export function canonicalHandle(sql: Sql, given: string): string | undefined {
  return sql.one<{ handle: string }>(
    `SELECT handle FROM users WHERE handle COLLATE NOCASE = ?
     ORDER BY (handle = ?) DESC, created_at, rowid LIMIT 1`,
    given,
    given,
  )?.handle;
}

/**
 * `canonicalHandle`, or `given` itself when no account matches, for a caller
 * that then reports "no such user" from its own lookup in its own words.
 */
export function resolveHandle(sql: Sql, given: string): string {
  return canonicalHandle(sql, given) ?? given;
}

/**
 * Make an account, refusing a handle that matches an existing one without
 * regard to case. The refusal is the INSERT's own condition, judged by the
 * rows changed, so two calls with case variants make exactly one account
 * (issue #90). `columns` are fixed names, the first one `handle`; only values
 * are bound. The error names the existing handle's spelling.
 */
export function insertUserOnce(
  tx: Tx,
  columns: readonly string[],
  values: readonly SqlValue[],
): void {
  const handle = values[0];
  if (columns[0] !== "handle" || typeof handle !== "string") {
    throw new BbsError("internal", "insertUserOnce needs the handle first");
  }
  const made = tx.sql.one<{ handle: string }>(
    `INSERT INTO users (${columns.join(", ")})
     SELECT ${columns.map(() => "?").join(", ")}
     WHERE NOT EXISTS (SELECT 1 FROM users WHERE handle COLLATE NOCASE = ?)
     RETURNING handle`,
    ...values,
    handle,
  );
  if (made) return;
  const clash = canonicalHandle(tx.sql, handle) ?? handle;
  throw new BbsError("exists", `a user named ${clash} already exists`);
}

export function getTopic(tx: Tx, name: string): TopicRow {
  const row = tx.sql.one<TopicRow>("SELECT * FROM topics WHERE name = ?", name);
  if (!row) throw new BbsError("not_found", `no topic named #${name}`);
  return row;
}

/** Design §14 "Effects": the text for a write to an archived topic. */
export function requireActiveTopic(topic: TopicRow): void {
  if (topic.state === "active") return;
  const date =
    topic.archived_at === null
      ? "an unknown date"
      : new Date(Number(topic.archived_at)).toISOString().slice(0, 10);
  throw new BbsError(
    "topic_archived",
    `Topic archived on ${date} by ${topic.archived_by ?? "unknown"}. ` +
      "Ask a coordinator to unarchive it.",
  );
}

/**
 * The highest message seq in a topic, or 0. For a cold topic (no rows in
 * SQLite) the seq recorded when it went cold (M6b review m3), so a
 * subscription started then does not report the restored messages as unread.
 */
export function topicMaxSeq(tx: Tx, topic: string): number {
  const row = tx.sql.one<{ m: number | null; c: number | null }>(
    `SELECT (SELECT MAX(seq) FROM messages WHERE topic = ?) AS m,
            (SELECT cold_last_seq FROM topics WHERE name = ?) AS c`,
    topic,
    topic,
  );
  return Math.max(Number(row?.m ?? 0), Number(row?.c ?? 0));
}

export function base64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Insert a message and bump the topic's activity (unless `touch` is false:
 * the auto-archive notice must not reset the clock it warns about, design
 * §14). Returns its seq.
 */
export function insertMessage(
  tx: Tx,
  m: {
    topic: string;
    author: string;
    authorKind: string;
    body: string;
    replyTo: number | null;
    mentions: string[];
    isSystem: boolean;
    touch?: boolean;
  },
): number {
  const row = tx.sql.one<{ seq: number }>(
    `INSERT INTO messages
       (topic, author, author_kind, via, body, reply_to, mentions, is_system, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     RETURNING seq`,
    m.topic,
    m.author,
    m.authorKind,
    tx.ctx.via,
    m.body,
    m.replyTo,
    JSON.stringify(m.mentions),
    m.isSystem ? 1 : 0,
    tx.now,
  );
  if (!row) throw new BbsError("internal", "message insert returned no row");
  for (const h of new Set(m.mentions)) {
    tx.sql.exec("INSERT OR IGNORE INTO message_mentions (handle, seq) VALUES (?, ?)", h, Number(row.seq));
  }
  if (m.touch !== false) {
    tx.sql.exec(
      "UPDATE topics SET last_activity_at = ? WHERE name = ?",
      tx.now,
      m.topic,
    );
  }
  return Number(row.seq);
}

/**
 * Refuse a new `wake`/`digest` subscription past `maxSubscriptionsPerUser`
 * (M2 security review, decided by orchestrator). A topic the user already
 * subscribes to (any level but `off`) does not count as new.
 */
export function checkSubscriptionRoom(tx: Tx, handle: string, topic: string): void {
  const row = tx.sql.one<{ n: number }>(
    "SELECT COUNT(*) AS n FROM subscriptions WHERE handle = ? AND level <> 'off' AND topic <> ?",
    handle,
    topic,
  );
  const max = tx.config.maxSubscriptionsPerUser;
  if (Number(row?.n ?? 0) >= max) {
    throw new BbsError(
      "conflict",
      `you already subscribe to ${max} topics, the most allowed; set one to off (bbs_subscribe level off) first`,
    );
  }
}

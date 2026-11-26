// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0

/**
 * Topic archiving and cold storage (design §14, M6b).
 *
 * States: `active` -> `archived` (manual or automatic) -> `cold` (after
 * `coldAfterMs`, rows moved to the cold store) -> back to `active` by
 * `topic_unarchive` (from archived) or a restore (from cold).
 *
 * - `topic_archive`: a coordinator (agent or person) or a human admin, with a
 *   reason. Refused while the topic has unfinished tasks, listing them. With
 *   `force` (a human admin only; every agent, a coordinator included, is
 *   refused: B37) the unfinished tasks are cancelled with the reason.
 * - `topic_unarchive`, `topic_keep`: the same roles.
 * - The archive scan (a timer, `archive_scan`) finds topics meeting all four
 *   auto-archive conditions and returns one follow-up per topic: the notice
 *   (`archive_notice`, a system message that starts no doorbell), or, three
 *   days after it with no activity since, the archive (`topic_auto_archive`).
 *   Each follow-up re-checks the conditions in its own transaction.
 * - Cold export is computed-due like the audit export (the store write is
 *   async): `cold.ts` builds the object (read only), writes it, then
 *   `topic_cold` re-checks and deletes in one transaction, or
 *   `topic_cold_failed` records the failure and nothing is deleted.
 * - `topic_restore` re-imports a cold object the Board DO read for a
 *   permitted caller's `bbs_topic_unarchive`.
 */

import {
  coldBody,
  coldKey,
  parseColdBody,
  readColdContent,
  utf8Bytes,
  type ColdCounts,
} from "../cold-object.ts";
import { asParams, optBool, optString, reqString, reqTopic } from "../params.ts";
import { ADMIN_LOG } from "../schema.ts";
import { BbsError, denied, type ActionDef, type AdminNotification, type Tx } from "../types.ts";
import { adminLog } from "./admin.ts";
import { humanAdmins } from "./users.ts";
import { getTopic, insertMessage, LOBBY, topicMaxSeq, type TopicRow } from "./common.ts";
import { cancelForArchive, Notices, type TaskRow } from "./tasks.ts";

/** Task states that keep a topic from being archived (design §14). */
export const UNFINISHED = ["open", "assigned", "in_progress", "blocked", "in_review"] as const;
const UNFINISHED_SQL = `('open','assigned','in_progress','blocked','in_review')`;

/** Longest archive reason. */
export const MAX_ARCHIVE_REASON = 1_000;

const NEVER_ARCHIVED = new Set([LOBBY, ADMIN_LOG]);

/** A coordinator (agent or person) or a human admin (design §14 "Manual archiving"). */
function requireTopicManager(tx: Tx, what: string): void {
  const a = tx.actor;
  if (a.isCoordinator || (a.kind === "human" && a.isAdmin)) return;
  throw denied(`only a coordinator or a human admin can ${what}`);
}

/** The topic's last activity: newest message or task change (design §14 condition 1). */
export const ACTIVITY_SQL = `MAX(t.last_activity_at,
  COALESCE((SELECT MAX(x.updated_at) FROM tasks x WHERE x.topic = t.name), 0))`;

/** No unfinished task in the topic (condition 2). */
const NO_UNFINISHED_SQL = `NOT EXISTS (SELECT 1 FROM tasks u WHERE u.topic = t.name AND u.state IN ${UNFINISHED_SQL})`;

/** No task in another topic is blocked by one of the topic's tasks (condition 3). */
const NOT_BLOCKING_SQL = `NOT EXISTS (
  SELECT 1 FROM task_blocks b JOIN tasks bl ON bl.id = b.blocked_by JOIN tasks w ON w.id = b.task
  WHERE bl.topic = t.name AND w.topic <> t.name AND w.state = 'blocked')`;

/**
 * Not yet cold-exportable while an unfinished task in another topic has a
 * blocker row on one of this topic's tasks: deleting that row would leave
 * the other task waiting on nothing it can name.
 */
export const NO_LIVE_DEPENDENT_SQL = `NOT EXISTS (
  SELECT 1 FROM task_blocks b JOIN tasks bl ON bl.id = b.blocked_by JOIN tasks w ON w.id = b.task
  WHERE bl.topic = t.name AND w.topic <> t.name AND w.state IN ${UNFINISHED_SQL})`;

function unfinishedTasks(tx: Tx, topic: string): { id: number; state: string }[] {
  return tx.sql
    .all<{ id: number; state: string }>(
      `SELECT id, state FROM tasks WHERE topic = ? AND state IN ${UNFINISHED_SQL} ORDER BY id`,
      topic,
    )
    .map((r) => ({ id: Number(r.id), state: r.state }));
}

function setArchived(tx: Tx, topic: string, by: string, reason: string): void {
  tx.sql.exec(
    `UPDATE topics SET state = 'archived', archived_at = ?, archived_by = ?, archive_reason = ?,
       archive_notice_at = NULL, cold_attempt_at = NULL, cold_pending = NULL, cold_conflict_at = NULL
     WHERE name = ?`,
    tx.now,
    by,
    reason,
    topic,
  );
}

/** Back to `active`, with the clock reset so it is not archived again at once. */
function setActive(tx: Tx, topic: string): void {
  tx.sql.exec(
    `UPDATE topics SET state = 'active', archived_at = NULL, archived_by = NULL, archive_reason = NULL,
       archive_notice_at = NULL, cold_key = NULL, cold_sha256 = NULL, cold_bytes = NULL, cold_at = NULL,
       cold_last_seq = NULL, cold_attempt_at = NULL, cold_pending = NULL, cold_conflict_at = NULL,
       last_activity_at = ?
     WHERE name = ?`,
    tx.now,
    topic,
  );
}

/**
 * `bbs_topic_archive(topic, reason, force?)`. Refused for the Lobby and
 * `#admin-log`, for a topic that is not active, and with unfinished tasks
 * unless a human admin passes `force`.
 */
export const topicArchive: ActionDef = {
  name: "topic_archive",
  kind: "change",
  run(tx, input) {
    const p = asParams(input);
    // B37: force is a human admin power; every agent, a coordinator included,
    // and every person without the admin flag is refused, before anything
    // else is read (orchestrator review n1).
    const force = optBool(p, "force") ?? false;
    if (force && !(tx.actor.kind === "human" && tx.actor.isAdmin)) {
      throw denied("force is a human admin power; agents (coordinators included) cannot use it");
    }
    const name = reqTopic(p);
    const reason = reqString(p, "reason", MAX_ARCHIVE_REASON).trim();
    requireTopicManager(tx, "archive a topic");
    if (reason === "") throw new BbsError("bad_request", "reason is required");
    const topic = getTopic(tx, name);
    if (NEVER_ARCHIVED.has(topic.name)) throw denied(`#${topic.name} is never archived`);
    if (topic.state !== "active") throw new BbsError("conflict", `#${topic.name} is already ${topic.state}`);
    const open = unfinishedTasks(tx, topic.name);
    const notices = new Notices(tx);
    const cancelled: number[] = [];
    if (open.length > 0 && !force) {
      throw new BbsError(
        "conflict",
        `#${topic.name} has unfinished tasks: ${open.map((t) => `${t.id} (${t.state})`).join(", ")}. ` +
          "Finish, cancel or move them first.",
      );
    }
    // Tasks of this topic that are cancelled here are not told that a
    // blocker was cancelled (review n8).
    const cancelling = new Set(open.map((t) => t.id));
    for (const t of open) {
      const row = tx.sql.one<TaskRow>("SELECT * FROM tasks WHERE id = ?", t.id);
      if (!row) continue;
      cancelForArchive(tx, row, reason, notices, cancelling);
      cancelled.push(t.id);
    }
    setArchived(tx, topic.name, tx.actor.handle, reason);
    return {
      value: { topic: topic.name, state: "archived", archived_at: tx.now, archived_by: tx.actor.handle, cancelled },
      audit: {
        targetType: "topic",
        targetId: topic.name,
        topic: topic.name,
        detail: {
          before: "active",
          after: "archived",
          reason_length: reason.length,
          force,
          cancelled,
          ...(notices.list.length ? { notify: notices.summary() } : {}),
        },
      },
      notifications: notices.list,
    };
  },
};

/**
 * `bbs_topic_unarchive(topic)` for an archived topic. A cold topic needs its
 * object read first, which only the Board DO can do (`topic_restore`); here
 * it is refused with what to do.
 */
export const topicUnarchive: ActionDef = {
  name: "topic_unarchive",
  kind: "change",
  run(tx, input) {
    const p = asParams(input);
    const name = reqTopic(p);
    requireTopicManager(tx, "unarchive a topic");
    const topic = getTopic(tx, name);
    if (topic.state === "active") throw new BbsError("conflict", `#${topic.name} is not archived`);
    if (topic.state === "cold") {
      throw new BbsError(
        "conflict",
        `#${topic.name} is in cold storage and this board has no cold store to restore it from`,
      );
    }
    setActive(tx, topic.name);
    return {
      value: { topic: topic.name, state: "active" },
      audit: {
        targetType: "topic",
        targetId: topic.name,
        topic: topic.name,
        detail: {
          before: "archived",
          after: "active",
          archived_at: Number(topic.archived_at),
          archived_by: topic.archived_by,
        },
      },
    };
  },
};

/** `bbs_topic_keep(topic, on)`: exempt a topic from aging (or not). */
export const topicKeep: ActionDef = {
  name: "topic_keep",
  kind: "change",
  run(tx, input) {
    const p = asParams(input);
    const name = reqTopic(p);
    const on = optBool(p, "on");
    if (on === undefined) throw new BbsError("bad_request", "on is required (true or false)");
    requireTopicManager(tx, "set keep on a topic");
    const topic = getTopic(tx, name);
    // Keep is about aging an active topic; an archived topic's rows (and so
    // its cold object) must not change (orchestrator review m1).
    if (topic.state !== "active") {
      throw new BbsError("conflict", `#${topic.name} is ${topic.state}; keep applies to active topics (unarchive it first)`);
    }
    tx.sql.exec("UPDATE topics SET keep = ?, archive_notice_at = NULL WHERE name = ?", on ? 1 : 0, topic.name);
    return {
      value: { topic: topic.name, keep: on },
      audit: {
        targetType: "topic",
        targetId: topic.name,
        topic: topic.name,
        detail: { before: Number(topic.keep) === 1, after: on },
      },
    };
  },
};

/**
 * `bbs_topic_describe(topic, description)`: replace an active topic's
 * description. A coordinator, a human admin, or the topic's creator. Agents
 * pick a topic by its description (which repositories it covers), so it must
 * be possible to keep it current. The Lobby and `#admin-log` are the board's.
 */
export const topicDescribe: ActionDef = {
  name: "topic_describe",
  kind: "change",
  run(tx, input) {
    const p = asParams(input);
    const name = reqTopic(p);
    const description = optString(p, "description", tx.config.maxDescriptionLength);
    if (description === undefined) throw new BbsError("bad_request", "description is required");
    const topic = getTopic(tx, name);
    if (NEVER_ARCHIVED.has(topic.name)) throw denied(`#${topic.name} is the board's own; its description is fixed`);
    const a = tx.actor;
    if (!(a.isCoordinator || (a.kind === "human" && a.isAdmin) || topic.created_by === a.handle)) {
      throw denied("only the topic's creator, a coordinator or a human admin can change its description");
    }
    if (topic.state !== "active") {
      throw new BbsError("conflict", `#${topic.name} is ${topic.state}; unarchive it first`);
    }
    tx.sql.exec("UPDATE topics SET description = ? WHERE name = ?", description, topic.name);
    return {
      value: { topic: topic.name, description },
      audit: {
        targetType: "topic",
        targetId: topic.name,
        topic: topic.name,
        detail: { before_length: topic.description.length, after_length: description.length },
      },
    };
  },
};

// ---------------------------------------------------------------------------
// Automatic archiving (design §14).

interface Candidate {
  name: string;
  activity: number;
  archive_notice_at: number | null;
}

/** Active topics meeting conditions 2-4 whose idle time has reached the notice point. */
function candidates(tx: Tx, limit: number, only?: string): Candidate[] {
  const cutoff = tx.now - (tx.config.archiveIdleMs - tx.config.archiveNoticeMs);
  return tx.sql
    .all<Candidate>(
      `SELECT name, activity, archive_notice_at FROM (
         SELECT t.name, ${ACTIVITY_SQL} AS activity, t.archive_notice_at
         FROM topics t
         WHERE t.state = 'active' AND t.keep = 0 AND t.name NOT IN (?, ?) AND (? IS NULL OR t.name = ?)
           AND ${NO_UNFINISHED_SQL} AND ${NOT_BLOCKING_SQL})
       WHERE activity <= ?
       ORDER BY activity, name LIMIT ?`,
      LOBBY,
      ADMIN_LOG,
      only ?? null,
      only ?? null,
      cutoff,
      limit,
    )
    .map((r) => ({
      name: r.name,
      activity: Number(r.activity),
      archive_notice_at: r.archive_notice_at === null ? null : Number(r.archive_notice_at),
    }));
}

/** What the scan does for one candidate now: post the notice, archive, or wait. */
function nextStep(tx: Tx, c: Candidate): "notice" | "archive" | "wait" {
  const noticeValid = c.archive_notice_at !== null && c.archive_notice_at > c.activity;
  if (!noticeValid) return "notice";
  const due = Math.max(c.archive_notice_at! + tx.config.archiveNoticeMs, c.activity + tx.config.archiveIdleMs);
  return tx.now >= due ? "archive" : "wait";
}

/** A span in words for the notice: days, or hours/minutes/seconds for short (test) settings. */
function spanWords(ms: number): string {
  const units: [number, string][] = [
    [86_400_000, "day"],
    [3_600_000, "hour"],
    [60_000, "minute"],
    [1_000, "second"],
  ];
  for (const [size, unit] of units) {
    if (ms >= size) {
      const n = Math.round(ms / size);
      return `${n} ${unit}${n === 1 ? "" : "s"}`;
    }
  }
  return `${ms} ms`;
}

function scheduleScan(tx: Tx): number {
  tx.sql.exec("DELETE FROM timers WHERE kind = 'archive_scan'");
  const due = tx.now + tx.config.archiveScanIntervalMs;
  tx.sql.exec("INSERT INTO timers (due_at, kind, ref) VALUES (?, 'archive_scan', 'board')", due);
  return due;
}

/** Starts the archive scan timer when there is none (`Board.ensureArchiveScan`). */
export const archiveScanSchedule: ActionDef = {
  name: "archive_scan_schedule",
  kind: "change",
  run(tx) {
    const due = scheduleScan(tx);
    return { value: { due }, audit: { targetType: "timer", detail: { kind: "archive_scan", due } } };
  },
};

/**
 * The archive scan timer: picks up to `archiveScanMaxTopics` candidates and
 * returns a follow-up for each that needs a step, then re-arms itself.
 */
export const archiveScan: ActionDef = {
  name: "archive_scan",
  kind: "change",
  run(tx) {
    const notices: string[] = [];
    const archives: string[] = [];
    for (const c of candidates(tx, tx.config.archiveScanMaxTopics)) {
      const step = nextStep(tx, c);
      if (step === "notice") notices.push(c.name);
      else if (step === "archive") archives.push(c.name);
    }
    const due = scheduleScan(tx);
    return {
      value: { notices, archives, next: due },
      audit: { targetType: "timer", detail: { notices, archives, next: due } },
      followUps: [
        ...notices.map((topic) => ({ def: archiveNotice, params: { topic } })),
        ...archives.map((topic) => ({ def: topicAutoArchive, params: { topic } })),
      ],
    };
  },
};

/**
 * The three-day notice (design §14): a system message in the topic that
 * returns no message notification, so no doorbell starts (it wakes nobody);
 * subscribers see it at their next `bbs_inbox`. It does not move the
 * topic's activity time.
 */
export const archiveNotice: ActionDef = {
  name: "archive_notice",
  kind: "change",
  run(tx, input) {
    const topic = reqTopic(asParams(input));
    const c = candidates(tx, 1, topic)[0];
    if (!c || nextStep(tx, c) !== "notice") {
      return { value: { outcome: "skipped" }, audit: { targetType: "topic", targetId: topic, topic, detail: { outcome: "skipped" } } };
    }
    const at = Math.max(tx.now + tx.config.archiveNoticeMs, c.activity + tx.config.archiveIdleMs);
    const date = new Date(at).toISOString().slice(0, 10);
    const body =
      `This topic will be archived on or after ${date} (UTC) after ${spanWords(tx.config.archiveIdleMs)} ` +
      "without a message or task change. Post here to keep it active, or ask a coordinator " +
      "to set keep (bbs_topic_keep).";
    const seq = insertMessage(tx, {
      topic,
      author: "system",
      authorKind: "system",
      body,
      replyTo: null,
      mentions: [],
      isSystem: true,
      touch: false,
    });
    tx.sql.exec("UPDATE topics SET archive_notice_at = ? WHERE name = ?", tx.now, topic);
    return {
      value: { outcome: "notice", seq, archive_after: at },
      audit: {
        targetType: "topic",
        targetId: topic,
        topic,
        detail: { outcome: "notice", seq, archive_after: at, last_activity: c.activity },
      },
    };
  },
};

/** Archive a topic that still meets all four conditions and whose notice has run out. */
export const topicAutoArchive: ActionDef = {
  name: "topic_auto_archive",
  kind: "change",
  run(tx, input) {
    const topic = reqTopic(asParams(input));
    const c = candidates(tx, 1, topic)[0];
    if (!c || nextStep(tx, c) !== "archive") {
      return { value: { outcome: "skipped" }, audit: { targetType: "topic", targetId: topic, topic, detail: { outcome: "skipped" } } };
    }
    const reason = `no message or task change for ${spanWords(tx.config.archiveIdleMs)}`;
    setArchived(tx, topic, "system", reason);
    return {
      value: { outcome: "archived" },
      audit: {
        targetType: "topic",
        targetId: topic,
        topic,
        detail: { before: "active", after: "archived", outcome: "archived", last_activity: c.activity, reason },
      },
    };
  },
};

// ---------------------------------------------------------------------------
// Cold storage (design §14 "cold").

/**
 * Archived topics that may go cold: not kept (`keep` also exempts an
 * archived topic from going cold, decided by orchestrator, review m5), not
 * waiting on a conflict at its key, and no unfinished task elsewhere blocked
 * by one of its tasks. Used with `FROM topics t`.
 */
export const COLD_ELIGIBLE_SQL = `t.state = 'archived' AND t.keep = 0 AND t.cold_conflict_at IS NULL
  AND ${NO_LIVE_DEPENDENT_SQL}`;

/** When an eligible topic is due: its cold age, or the retry delay after the last attempt. */
export const COLD_DUE_SQL = `MAX(t.archived_at + ?, COALESCE(t.cold_attempt_at + ?, 0))`;

/**
 * An upper estimate of the object's size from SQL (byte lengths of the text
 * columns plus a per-row allowance for keys and numbers), so a topic far
 * over `coldMaxBytes` is refused without building its object (review M1).
 */
export function coldSizeEstimate(sql: Tx["sql"], topic: string): number {
  const b = (col: string): string => `COALESCE(length(CAST(${col} AS BLOB)), 0)`;
  const row = sql.one<{ n: number | null }>(
    `SELECT
       (SELECT COALESCE(SUM(${b("body")} + ${b("mentions")} + ${b("author")} + ${b("via")} + 256), 0)
          FROM messages WHERE topic = ?)
     + (SELECT COALESCE(SUM(${b("title")} + ${b("description")} + ${b("assignee")} + ${b("created_by")} + 320), 0)
          FROM tasks WHERE topic = ?)
     + (SELECT COALESCE(SUM(${b("c.body")} + ${b("c.author")} + 160), 0)
          FROM task_comments c JOIN tasks t2 ON t2.id = c.task WHERE t2.topic = ?)
     + (SELECT COUNT(*) * 128 FROM task_blocks
          WHERE task IN (SELECT id FROM tasks WHERE topic = ?) OR blocked_by IN (SELECT id FROM tasks WHERE topic = ?))
     + (SELECT ${b("description")} + ${b("archive_reason")} + 1024 FROM topics WHERE name = ?) AS n`,
    topic, topic, topic, topic, topic, topic,
  );
  return Number(row?.n ?? 0);
}

/**
 * A cheap fingerprint of the rows that go into the object (counts, newest
 * ids, newest task change), recorded at begin and checked at confirm instead
 * of rebuilding the object (review M1). While archived the rows cannot
 * change (posts, task changes and keep are refused; a finished task cannot be
 * blocked or unblocked), so a mismatch means something unexpected happened.
 */
export function coldFingerprint(sql: Tx["sql"], topic: string): string {
  const r = sql.one<Record<string, number | null>>(
    `SELECT (SELECT COUNT(*) FROM messages WHERE topic = ?) AS messages,
            (SELECT MAX(seq) FROM messages WHERE topic = ?) AS max_seq,
            (SELECT COUNT(*) FROM tasks WHERE topic = ?) AS tasks,
            (SELECT MAX(id) FROM tasks WHERE topic = ?) AS max_task,
            (SELECT MAX(updated_at) FROM tasks WHERE topic = ?) AS max_updated,
            (SELECT COUNT(*) FROM task_comments c JOIN tasks t2 ON t2.id = c.task WHERE t2.topic = ?) AS comments,
            (SELECT MAX(c.id) FROM task_comments c JOIN tasks t2 ON t2.id = c.task WHERE t2.topic = ?) AS max_comment,
            (SELECT COUNT(*) FROM task_blocks WHERE task IN (SELECT id FROM tasks WHERE topic = ?)
                OR blocked_by IN (SELECT id FROM tasks WHERE topic = ?)) AS blocks,
            (SELECT keep FROM topics WHERE name = ?) AS keep`,
    topic, topic, topic, topic, topic, topic, topic, topic, topic, topic,
  );
  const v = (k: string): number | null => (r?.[k] === null || r?.[k] === undefined ? null : Number(r[k]));
  return JSON.stringify(
    ["messages", "max_seq", "tasks", "max_task", "max_updated", "comments", "max_comment", "blocks", "keep"].map(v),
  );
}

/** The body and its hash, built from SQLite (read only). */
export function buildColdObject(
  tx: Pick<Tx, "sql" | "sha256">,
  topic: TopicRow,
): { key: string; body: string; sha256: string; bytes: number; counts: ColdCounts } {
  const content = readColdContent(tx.sql, topic.name);
  const body = coldBody(content);
  return {
    key: coldKey(topic.name, Number(topic.archived_at)),
    body,
    sha256: tx.sha256(body),
    bytes: utf8Bytes(body),
    counts: content.header.counts,
  };
}

interface ColdPending {
  key: string;
  sha256: string;
  bytes: number;
  fingerprint: string;
  counts: ColdCounts;
}

function readPending(topic: TopicRow): ColdPending | undefined {
  if (!topic.cold_pending) return undefined;
  try {
    return JSON.parse(topic.cold_pending) as ColdPending;
  } catch {
    return undefined;
  }
}

/**
 * Begin a cold export (system): record the object about to be written (key,
 * SHA-256, size, fingerprint) and the attempt time, persisted, so a restart
 * waits `coldRetryMs` before trying again rather than looping (review M1).
 */
export const topicColdBegin: ActionDef = {
  name: "topic_cold_begin",
  kind: "change",
  run(tx, input) {
    const p = asParams(input);
    const name = reqTopic(p);
    const topic = getTopic(tx, name);
    if (topic.state !== "archived") throw new BbsError("conflict", `#${name} is ${topic.state}, not archived`);
    const pending: ColdPending = {
      key: reqString(p, "key", 200),
      sha256: reqString(p, "sha256", 64),
      bytes: Number(p.bytes),
      fingerprint: coldFingerprint(tx.sql, name),
      counts: p.counts as ColdCounts,
    };
    tx.sql.exec(
      "UPDATE topics SET cold_attempt_at = ?, cold_pending = ? WHERE name = ?",
      tx.now,
      JSON.stringify(pending),
      name,
    );
    return {
      value: { topic: name, key: pending.key },
      audit: {
        targetType: "topic",
        targetId: name,
        topic: name,
        detail: { key: pending.key, sha256: pending.sha256, bytes: pending.bytes, counts: pending.counts },
      },
    };
  },
};

/**
 * The store confirmed the object: check that the topic is still archived
 * with the begin step's record (same key and SHA-256) and the same
 * fingerprint, then delete its rows in this one transaction and leave the
 * stub (`state = cold`). Deleted with the rows: their `message_mentions` (no
 * foreign key, M2), lease timers of its tasks, comments, and blocker rows
 * touching its tasks. Kept: subscriptions (design §14; a restore brings them
 * back) and stored notices (nothing references them; review m4). Doorbells
 * hold only counts per topic name. The task ids go to `cold_tasks` (review
 * m2) and the newest seq to `cold_last_seq` (review m3).
 */
export const topicCold: ActionDef = {
  name: "topic_cold",
  kind: "change",
  run(tx, input) {
    const p = asParams(input);
    const name = reqTopic(p);
    const key = reqString(p, "key", 200);
    const sha = reqString(p, "sha256", 64);
    const outcome = reqString(p, "outcome", 16);
    const topic = getTopic(tx, name);
    if (topic.state !== "archived") throw new BbsError("conflict", `#${name} is ${topic.state}, not archived`);
    const pending = readPending(topic);
    if (!pending || pending.key !== key || pending.sha256 !== sha) {
      throw new BbsError("conflict", `#${name} has no matching cold export in progress`);
    }
    if (coldFingerprint(tx.sql, name) !== pending.fingerprint) {
      throw new BbsError("conflict", `#${name} changed after its cold object was built`);
    }
    const lastSeq = topicMaxSeq(tx, name);
    tx.sql.exec("INSERT OR REPLACE INTO cold_tasks (id, topic) SELECT id, topic FROM tasks WHERE topic = ?", name);
    const ids = "SELECT id FROM tasks WHERE topic = ?";
    const deleted = {
      mentions: tx.sql.all(`DELETE FROM message_mentions WHERE seq IN (SELECT seq FROM messages WHERE topic = ?) RETURNING seq`, name).length,
      timers: tx.sql.all(`DELETE FROM timers WHERE kind = 'lease' AND ref IN (SELECT CAST(id AS TEXT) FROM tasks WHERE topic = ?) RETURNING id`, name).length,
      comments: tx.sql.all(`DELETE FROM task_comments WHERE task IN (${ids}) RETURNING id`, name).length,
      blocks: tx.sql.all(`DELETE FROM task_blocks WHERE task IN (${ids}) OR blocked_by IN (${ids}) RETURNING task`, name, name).length,
      messages: tx.sql.all(`DELETE FROM messages WHERE topic = ? RETURNING seq`, name).length,
      tasks: tx.sql.all(`DELETE FROM tasks WHERE topic = ? RETURNING id`, name).length,
    };
    tx.sql.exec(
      `UPDATE topics SET state = 'cold', cold_key = ?, cold_sha256 = ?, cold_bytes = ?, cold_at = ?, cold_last_seq = ?,
         cold_attempt_at = NULL, cold_pending = NULL
       WHERE name = ?`,
      key,
      sha,
      pending.bytes,
      tx.now,
      lastSeq,
      name,
    );
    return {
      value: { topic: name, state: "cold", key },
      audit: {
        targetType: "topic",
        targetId: name,
        topic: name,
        detail: { before: "archived", after: "cold", key, sha256: sha, bytes: pending.bytes, counts: pending.counts, deleted, outcome, last_seq: lastSeq },
      },
    };
  },
};

/**
 * The cold export of a topic failed: nothing is deleted; the next try waits
 * `coldRetryMs`. When the store found an object of other content at the key
 * (`conflict`), the topic stops being tried, and the first time a line goes
 * to `#admin-log` with a notice to each human admin naming the fix (review
 * m1): unarchive the topic and archive it again (a new archive time gives a
 * new key).
 */
export const topicColdFailed: ActionDef = {
  name: "topic_cold_failed",
  kind: "change",
  run(tx, input) {
    const p = asParams(input);
    const name = reqTopic(p);
    const error = optString(p, "error", 500) ?? "unknown error";
    const key = optString(p, "key", 200) ?? null;
    const conflict = optBool(p, "conflict") ?? false;
    const topic = getTopic(tx, name);
    const notifications: AdminNotification[] = [];
    let noticed = false;
    if (topic.state === "archived") {
      tx.sql.exec("UPDATE topics SET cold_attempt_at = ?, cold_pending = NULL WHERE name = ?", tx.now, name);
      if (conflict && topic.cold_conflict_at === null) {
        tx.sql.exec("UPDATE topics SET cold_conflict_at = ? WHERE name = ?", tx.now, name);
        const log = adminLog(
          tx,
          `cold export of #${name} stopped: an object with other content is already at ${key ?? "its key"}. ` +
            "Nothing was deleted. To fix: unarchive the topic and archive it again (a new archive time gives a new key).",
        );
        notifications.push(
          ...humanAdmins(tx.sql).map((handle) => ({
            type: "admin" as const,
            reason: "cold_conflict" as const,
            recipient: handle,
            as: "admin" as const,
            subjects: [],
            topic: name,
            logSeq: log.seq,
            alwaysWake: false as const,
            actor: "system" as const,
          })),
        );
        noticed = true;
      }
    }
    const retryAt = conflict ? null : tx.now + tx.config.coldRetryMs;
    return {
      value: { topic: name, retry_at: retryAt },
      audit: {
        targetType: "topic",
        targetId: name,
        topic: name,
        detail: { key, error, retry_at: retryAt, ...(conflict ? { conflict, noticed } : {}) },
      },
      notifications,
    };
  },
};

/**
 * Restore a cold topic (design §14: "Restore from cold re-imports the R2
 * file"). Params come from the Board DO, never from a caller: the topic, the
 * key it read, and the body or the read error. Same roles as unarchive. The
 * body must hash to the stub's SHA-256 and parse; every row goes back with
 * its original id, and the topic becomes active with its clock reset. A
 * blocker row whose other task is in a topic that went cold too waits in
 * `cold_blocks` until that topic is restored.
 */
export const topicRestore: ActionDef = {
  name: "topic_restore",
  kind: "change",
  run(tx, input) {
    const p = asParams(input);
    const name = reqTopic(p);
    requireTopicManager(tx, "restore a topic");
    const topic = getTopic(tx, name);
    if (topic.state !== "cold") throw new BbsError("conflict", `#${name} is ${topic.state}, not cold`);
    const key = String(p.key ?? "");
    if (key !== topic.cold_key) throw new BbsError("conflict", `#${name}'s cold object changed while it was read; try again`);
    if (typeof p.error === "string") {
      throw new BbsError("internal", `could not read #${name}'s cold object: ${p.error.slice(0, 300)}`);
    }
    const body = typeof p.body === "string" ? p.body : "";
    if (tx.sha256(body) !== topic.cold_sha256) {
      throw new BbsError("internal", `#${name}'s cold object does not match its recorded SHA-256`);
    }
    let content;
    try {
      content = parseColdBody(body);
    } catch (err) {
      throw new BbsError("internal", (err as Error).message.slice(0, 300));
    }
    const boardId = tx.sql.one<{ value: string }>("SELECT value FROM meta WHERE key = 'board_id'")?.value ?? "";
    if (
      content.header.name !== name ||
      content.header.archived_at !== Number(topic.archived_at) ||
      content.header.board_id !== boardId
    ) {
      throw new BbsError("internal", `#${name}'s cold object is for another topic, archive or board`);
    }
    tx.sql.exec("DELETE FROM cold_tasks WHERE topic = ?", name);
    for (const m of content.messages) {
      tx.sql.exec(
        `INSERT INTO messages (seq, topic, author, author_kind, via, body, reply_to, mentions, is_system, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        m.seq, name, m.author, m.author_kind, m.via, m.body, m.reply_to, JSON.stringify(m.mentions), m.is_system, m.created_at,
      );
      for (const h of new Set(m.mentions)) {
        tx.sql.exec("INSERT OR IGNORE INTO message_mentions (handle, seq) VALUES (?, ?)", h, m.seq);
      }
    }
    for (const t of content.tasks) {
      tx.sql.exec(
        `INSERT INTO tasks (id, topic, title, description, state, prior_state, is_stale, assignee, created_by,
                            lease_expires_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        t.id, name, t.title, t.description, t.state, t.prior_state, t.is_stale, t.assignee, t.created_by,
        t.lease_expires_at, t.created_at, t.updated_at,
      );
    }
    for (const c of content.comments) {
      tx.sql.exec(
        "INSERT INTO task_comments (id, task, author, body, state_change, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        c.id, c.task, c.author, c.body, c.state_change, c.created_at,
      );
    }
    // A blocker row whose other task is in a topic that is cold itself waits
    // in `cold_blocks`; rows waiting for this topic's tasks go back now.
    let pending = 0;
    for (const b of content.blocks) {
      const r = tx.sql.all(
        `INSERT OR IGNORE INTO task_blocks (task, blocked_by, created_by, created_at)
         SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM tasks WHERE id = ?) AND EXISTS (SELECT 1 FROM tasks WHERE id = ?)
         RETURNING task`,
        b.task, b.blocked_by, b.created_by, b.created_at, b.task, b.blocked_by,
      );
      if (r.length === 0 && !tx.sql.one("SELECT 1 AS x FROM task_blocks WHERE task = ? AND blocked_by = ?", b.task, b.blocked_by)) {
        tx.sql.exec(
          "INSERT OR IGNORE INTO cold_blocks (task, blocked_by, created_by, created_at) VALUES (?, ?, ?, ?)",
          b.task, b.blocked_by, b.created_by, b.created_at,
        );
        pending += 1;
      }
    }
    const ready = "EXISTS (SELECT 1 FROM tasks WHERE id = c.task) AND EXISTS (SELECT 1 FROM tasks WHERE id = c.blocked_by)";
    const resumed = tx.sql.all(
      `INSERT OR IGNORE INTO task_blocks (task, blocked_by, created_by, created_at)
       SELECT c.task, c.blocked_by, c.created_by, c.created_at FROM cold_blocks c WHERE ${ready} RETURNING task`,
    ).length;
    tx.sql.exec(`DELETE FROM cold_blocks AS c WHERE ${ready}`);
    setActive(tx, name);
    const counts = content.header.counts;
    return {
      value: { topic: name, state: "active", restored: counts, blocks_pending: pending, blocks_resumed: resumed },
      audit: {
        targetType: "topic",
        targetId: name,
        topic: name,
        detail: { before: "cold", after: "active", key, sha256: topic.cold_sha256, counts, blocks_pending: pending, blocks_resumed: resumed },
      },
    };
  },
};

/** Look up a cold topic's object key for a caller who may restore it (read only), or undefined. */
export function coldRestoreKey(
  sql: Tx["sql"],
  handle: string,
  topicArg: unknown,
): { topic: string; key: string } | undefined {
  let name: string;
  try {
    name = reqTopic(asParams(topicArg));
  } catch {
    return undefined;
  }
  const t = sql.one<{ state: string; cold_key: string | null }>("SELECT state, cold_key FROM topics WHERE name = ?", name);
  if (!t || t.state !== "cold" || !t.cold_key) return undefined;
  const u = sql.one<{ kind: string; is_admin: number; is_coordinator: number; status: string }>(
    "SELECT kind, is_admin, is_coordinator, status FROM users WHERE handle = ?",
    handle,
  );
  if (!u || u.status === "kicked") return undefined;
  const may = Number(u.is_coordinator) === 1 || (u.kind === "human" && Number(u.is_admin) === 1);
  return may ? { topic: name, key: t.cold_key } : undefined;
}

// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0

/**
 * Notification delivery (M2, design §6): turns the notification work an
 * action returns into doorbells and notices, inside `act`'s transaction.
 *
 * Rules:
 * - A message rings every agent subscribed to its topic at `wake`, and every
 *   agent it @mentions whatever their level (also `off` or unsubscribed: an
 *   @mention always wakes). Its author is never rung. `digest` subscribers
 *   are not rung; they see it at their next `bbs_inbox`.
 * - A task or administrator notice is stored for its recipient (`notices`,
 *   shown by `bbs_inbox`, backlog B23). Task notices marked `alwaysWake`
 *   (design §6, §8: task assigned, comment on your task, unblocked, lease
 *   expired, ...) ring the assignee; every task notice copied to the
 *   coordinator rings the coordinator (B47, decided by Curtis). Administrator
 *   notices wait for the next inbox read, except the end of a Lobby mute,
 *   which rings the user it was about (review m9).
 * - Only subscribed topics are named in the doorbell; mentions elsewhere are
 *   counted (review m1).
 * - Only `agent` users get doorbells (design §4: people get no doorbell), and
 *   never a kicked one.
 * - One pending doorbell per user (`doorbells` row) until the user calls
 *   `bbs_inbox`. The first event sets a debounce timer; later events only
 *   update the counts. When the timer fires the doorbell rings once if the
 *   user's live session is idle, is held if it is busy, and waits if no
 *   adapter is attached; a held or waiting doorbell rings when the session
 *   reports idle or attaches.
 *
 * - Wake budget (design §6, M4b): at most `wakeBudgetPerHour` rings per user
 *   per `wakeBudgetWindowMs`. Past it, a due doorbell is not rung: it stays
 *   pending and unsent (digest) with a timer at the window's end, when it
 *   rings once and opens the next window. Agent @mentions and always-wake
 *   task notices fall back too. One exception, decided by Curtis
 *   (2026-11-20, B52): an @mention written by a person rings even past the
 *   budget, and still counts. The first refusal in a window asks for the
 *   `wake_budget_exceeded` follow-up (one `#admin-log` line, the user and
 *   the coordinator told).
 *
 * - Circuit breaker (design §6, B32, decided by Curtis 2026-11-21: "Yes,
 *   digest while tripped"): while a trip stands for two agents in a topic,
 *   an @mention by one of the other there does not ring; it falls back to
 *   digest (the inbox shows it). A trip stands for an agent until it sets
 *   that topic back to `wake` (`clearBreakerTrips`).
 *
 * The doorbell text holds counts, topic names and task notice kinds only,
 * never message text (design §11).
 */

import { base64url } from "./actions/common.ts";
import type {
  AdminNotification,
  MessageNotification,
  NotificationWork,
  RingNotification,
  TaskNotification,
  TaskNoticeReason,
  Tx,
} from "./types.ts";

/** Counts kept in `doorbells.summary`. */
export interface DoorbellSummary {
  /**
   * New messages per topic the user subscribes to (`wake` or `digest`), and
   * how many of them @mention the user. Only these topics are named in the
   * text (review m1): a name chosen by someone else reaches the model only
   * from a topic the user joined.
   */
  topics: Record<string, { n: number; mentions: number }>;
  /** @mentions in topics the user does not subscribe to (or set `off`): counted, never named. */
  elsewhere?: number;
  /** Ringing task and administrator notices by reason. */
  tasks: Record<string, number>;
  /** @mentions written by a person: these ring even past the wake budget (B52). */
  humanMentions?: number;
}

/** One event for one user's doorbell. */
type DoorbellEvent =
  | { kind: "message"; topic: string; mention: boolean; named: boolean; byHuman: boolean }
  | { kind: "notice"; reason: string };

/** What delivery did, for the action's audit row. */
export interface Delivery {
  /** Users whose doorbell this action created (debounce started). */
  queued: string[];
  /** Users whose pending doorbell this action added to. */
  added: string[];
  /** Users given a stored notice. */
  notices: string[];
  /** Notices dropped by the per-user cap, by `<handle>:<class>`. */
  dropped: Record<string, number>;
  /** Users whose @mention by a tripped partner fell back to digest (B32). */
  breakerDigest: string[];
}

export function emptyDelivery(): Delivery {
  return { queued: [], added: [], notices: [], dropped: {}, breakerDigest: [] };
}

export function deliveryDetail(d: Delivery): Record<string, unknown> {
  const drops = Object.keys(d.dropped).length;
  if (d.queued.length + d.added.length + d.notices.length + drops + d.breakerDigest.length === 0) return {};
  return {
    delivery: {
      ...(d.breakerDigest.length ? { mentions_digest_breaker: d.breakerDigest } : {}),
      ...(d.queued.length ? { doorbells_queued: d.queued } : {}),
      ...(d.added.length ? { doorbells_added: d.added } : {}),
      ...(d.notices.length ? { notices: d.notices } : {}),
      ...(drops ? { notices_dropped: d.dropped } : {}),
    },
  };
}

/**
 * Deliver one action's notification work: doorbell events and stored
 * notices. Runs inside the action's transaction. Ring work is passed over
 * (it is already the result of delivery).
 */
export function deliver(tx: Tx, work: readonly NotificationWork[]): Delivery {
  const d = emptyDelivery();
  for (const w of work) {
    if (w.type === "message") deliverMessage(tx, w, d);
    else if (w.type === "task") deliverTask(tx, w, d);
    else if (w.type === "admin") deliverAdmin(tx, w, d);
  }
  return d;
}

function deliverMessage(tx: Tx, m: MessageNotification, d: Delivery): void {
  const mentioned = new Set(m.mentions);
  const wake = tx.sql
    .all<{ handle: string }>(
      "SELECT handle FROM subscriptions WHERE topic = ? AND level = 'wake' AND handle <> ?",
      m.topic,
      m.author,
    )
    .map((r) => r.handle);
  const recipients = new Set<string>(wake);
  const authorKind = tx.sql.one<{ kind: string }>("SELECT kind FROM users WHERE handle = ?", m.author)?.kind;
  const byHuman = authorKind === "human";
  for (const h of mentioned) {
    if (h === m.author || recipients.has(h)) continue;
    // A tripped pair's mentions of each other in this topic: digest (B32).
    if (authorKind === "agent" && breakerTripStands(tx, h, m.author, m.topic)) {
      if (!d.breakerDigest.includes(h)) d.breakerDigest.push(h);
      continue;
    }
    recipients.add(h);
  }
  for (const handle of [...recipients].sort()) {
    const sub = tx.sql.one<{ level: string }>(
      "SELECT level FROM subscriptions WHERE topic = ? AND handle = ?",
      m.topic,
      handle,
    );
    const named = sub !== undefined && sub.level !== "off";
    addEvent(tx, handle, { kind: "message", topic: m.topic, mention: mentioned.has(handle), named, byHuman }, d);
  }
}

function deliverTask(tx: Tx, n: TaskNotification, d: Delivery): void {
  if (n.recipient === null) return;
  const detail: Record<string, unknown> = {
    task: n.task,
    topic: n.topic,
    as: n.as,
    actor: n.actor,
    ...(n.relatedTask !== undefined ? { related_task: n.relatedTask } : {}),
  };
  // A copy for the coordinator rings the coordinator like the assignee's
  // notices ring the assignee (B47, decided by Curtis 2026-11-20: "follow
  // your recommendation for B44", numbered B47 since the rebase onto M6a); in the doorbell it is "N task notices".
  // People get no doorbell, so a human coordinator's copy is stored only.
  const coordinator = n.as === "coordinator";
  const rang =
    (n.alwaysWake || coordinator) &&
    addEvent(tx, n.recipient, { kind: "notice", reason: coordinator ? COORDINATOR_NOTICE : n.reason }, d);
  storeNotice(tx, n.recipient, "task", n.reason, rang, detail, d);
}

function deliverAdmin(tx: Tx, n: AdminNotification, d: Delivery): void {
  if (n.recipient === null) return;
  const detail: Record<string, unknown> = {
    as: n.as,
    subjects: n.subjects,
    log_seq: n.logSeq,
    ...(n.topic !== undefined ? { topic: n.topic } : {}),
  };
  // The end of a Lobby mute is told to the user it was about, and rings
  // (review m9, decided by orchestrator): it comes from a timer, so the user
  // may be idle, and it is news they can act on. The other administrator
  // notices only wait for the next inbox (decision 11, backlog B47).
  const rings = n.reason === "lobby_unmuted" && n.as === "user";
  const rang = rings && addEvent(tx, n.recipient, { kind: "notice", reason: n.reason }, d);
  storeNotice(tx, n.recipient, "admin", n.reason, rang, detail, d);
}

function storeNotice(
  tx: Tx,
  handle: string,
  kind: "task" | "admin",
  reason: string,
  wake: boolean,
  detail: Record<string, unknown>,
  d: Delivery,
): void {
  const user = tx.sql.one("SELECT 1 AS x FROM users WHERE handle = ?", handle);
  if (!user) return;
  tx.sql.exec(
    `INSERT INTO notices (handle, kind, reason, wake, detail, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    handle,
    kind,
    reason,
    wake ? 1 : 0,
    JSON.stringify(detail),
    tx.now,
  );
  // Keep at most `noticesMaxPerUser` of each class, task and admin (review
  // m10; M2 security review): an agent that never reads its inbox does not
  // grow the table without bound, and a flood of task notices never pushes
  // out an administrator notice. Every stored notice is undelivered
  // (bbs_inbox deletes what it returns). Past the cap, "one per task" (issue
  // #105, decided by Curtis 2026-11-25): first remove, oldest first, only
  // notices that are not the latest of their task, so no task loses its last
  // notice and nothing is counted as dropped. Both steps run in the action's
  // transaction, and the cap is the condition of each DELETE (the excess is
  // computed inside the statement, not read first).
  supersedeNotices(tx, handle, kind);
  // Last resort: every stored notice is the latest of its task (or of its
  // administrator reason and target), so the oldest of the class goes. The
  // count is kept for the user's next bbs_inbox (`dropped_notices`) and on
  // this action's audit row.
  const dropped = tx.sql.all<{ id: number }>(
    `DELETE FROM notices WHERE handle = ? AND kind = ? AND id <= (
       SELECT id FROM notices WHERE handle = ? AND kind = ? ORDER BY id DESC LIMIT 1 OFFSET ?)
     RETURNING id`,
    handle,
    kind,
    handle,
    kind,
    tx.config.noticesMaxPerUser,
  ).length;
  if (dropped > 0) {
    tx.sql.exec(
      `INSERT INTO notice_drops (handle, n) VALUES (?, ?)
       ON CONFLICT (handle) DO UPDATE SET n = n + excluded.n`,
      handle,
      dropped,
    );
    const key = `${handle}:${kind}`;
    d.dropped[key] = (d.dropped[key] ?? 0) + dropped;
  }
  if (!d.notices.includes(handle)) d.notices.push(handle);
}

/**
 * What makes two stored notices "the same task" (issue #105): a task notice's
 * `detail.task`; an administrator notice has no task, so its reason, its role
 * (`as`), its subjects and its topic stand in, which makes a repeated warning
 * or mute for the same person and topic supersede the older one. These are
 * constant SQL expressions over `detail`, never built from input.
 */
function noticeKey(kind: "task" | "admin", t: string): string {
  return kind === "task"
    ? `json_extract(${t}detail, '$.task')`
    : `json_array(${t}reason, json_extract(${t}detail, '$.as'), json_extract(${t}detail, '$.subjects'), json_extract(${t}detail, '$.topic'))`;
}

/**
 * Past `noticesMaxPerUser` in a class, delete the oldest notices that are not
 * the latest of their task, as many as the excess (issue #105). One statement
 * judges the cap and deletes. Not counted as dropped: the task keeps its latest
 * notice. A removed notice that rang (`wake = 1`) passes the mark to the
 * latest notice of its task, so a truncated `bbs_inbox` still rings again for
 * it (the pending doorbell itself is not touched by a notice's removal).
 */
function supersedeNotices(tx: Tx, handle: string, kind: "task" | "admin"): void {
  const removed = tx.sql.all<{ id: number; wake: number; k: string | number | null }>(
    `DELETE FROM notices WHERE id IN (
       SELECT n.id FROM notices n
       WHERE n.handle = ? AND n.kind = ?
         AND EXISTS (SELECT 1 FROM notices m
                     WHERE m.handle = n.handle AND m.kind = n.kind AND m.id > n.id
                       AND ${noticeKey(kind, "m.")} IS ${noticeKey(kind, "n.")})
       ORDER BY n.id
       LIMIT MAX(0, (SELECT COUNT(*) FROM notices WHERE handle = ? AND kind = ?) - ?))
     RETURNING id, wake, ${noticeKey(kind, "")} AS k`,
    handle,
    kind,
    handle,
    kind,
    tx.config.noticesMaxPerUser,
  );
  const rang = new Set(removed.filter((r) => Number(r.wake) === 1).map((r) => r.k));
  for (const k of rang) {
    tx.sql.exec(
      `UPDATE notices SET wake = 1 WHERE id = (
         SELECT MAX(id) FROM notices WHERE handle = ? AND kind = ? AND ${noticeKey(kind, "")} IS ?)`,
      handle,
      kind,
      k,
    );
  }
}

const breakerClearKey = (handle: string, topic: string): string => `breaker_clear:${handle}:${topic}`;

/**
 * Whether a circuit-breaker trip of `recipient` with `partner` in `topic`
 * still stands (B32): both have a `breaker` row of the same trip (same seq
 * and time), newer than the last time `recipient` set the topic back to
 * `wake` (the newest breaker row id then, kept in `meta`).
 */
export function breakerTripStands(tx: Tx, recipient: string, partner: string, topic: string): boolean {
  const cleared = tx.sql.one<{ value: string }>("SELECT value FROM meta WHERE key = ?", breakerClearKey(recipient, topic));
  const after = cleared ? Number(cleared.value) : 0;
  return (
    tx.sql.one(
      `SELECT 1 AS x FROM admin_events r
       JOIN admin_events o ON o.kind = 'breaker' AND o.topic = r.topic AND o.seq IS r.seq AND o.at = r.at AND o.handle = ?
       WHERE r.kind = 'breaker' AND r.handle = ? AND r.topic = ? AND r.id > ?
       LIMIT 1`,
      partner,
      recipient,
      topic,
      Number.isFinite(after) ? after : 0,
    ) !== undefined
  );
}

/**
 * `handle` set `topic` back to `wake`: its breaker trips there no longer
 * stand (B32). Writes `meta` only when there is a trip to end.
 */
export function clearBreakerTrips(tx: Tx, handle: string, topic: string): boolean {
  const last = tx.sql.one<{ id: number | null }>(
    "SELECT MAX(id) AS id FROM admin_events WHERE kind = 'breaker' AND handle = ? AND topic = ?",
    handle,
    topic,
  );
  if (last?.id === null || last?.id === undefined) return false;
  const key = breakerClearKey(handle, topic);
  const prev = tx.sql.one<{ value: string }>("SELECT value FROM meta WHERE key = ?", key);
  if (prev && Number(prev.value) >= Number(last.id)) return false;
  tx.sql.exec(
    `INSERT INTO meta (key, value) VALUES (?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
    key,
    String(last.id),
  );
  return true;
}

/**
 * Make sure a doorbell timer for `handle` fires no later than `at`: insert
 * one, or move an existing later one earlier. Never moves a timer later.
 */
export function armDoorbellTimer(tx: Tx, handle: string, at: number): void {
  const t = tx.sql.one<{ id: number; due_at: number }>(
    "SELECT id, due_at FROM timers WHERE kind = 'doorbell' AND ref = ? ORDER BY due_at LIMIT 1",
    handle,
  );
  if (!t) {
    tx.sql.exec("INSERT INTO timers (due_at, kind, ref) VALUES (?, 'doorbell', ?)", at, handle);
  } else if (Number(t.due_at) > at) {
    tx.sql.exec("UPDATE timers SET due_at = ? WHERE id = ?", at, Number(t.id));
  }
}

/**
 * Add one event to a user's doorbell, creating it (and its debounce timer)
 * when none is pending. Returns false when the user gets no doorbell (not
 * an agent, kicked, or unknown).
 */
function addEvent(tx: Tx, handle: string, ev: DoorbellEvent, d: Delivery): boolean {
  const user = tx.sql.one<{ kind: string; status: string }>(
    "SELECT kind, status FROM users WHERE handle = ?",
    handle,
  );
  if (!user || user.kind !== "agent" || user.status === "kicked") return false;
  const row = tx.sql.one<{ summary: string; sent_at: number | null }>(
    "SELECT summary, sent_at FROM doorbells WHERE handle = ?",
    handle,
  );
  if (!row) {
    const summary: DoorbellSummary = { topics: {}, tasks: {} };
    apply(summary, ev);
    const due = tx.now + tx.config.doorbellDebounceMs;
    tx.sql.exec(
      `INSERT INTO doorbells (handle, first_event_at, summary, id, due_at)
       VALUES (?, ?, ?, ?, ?)`,
      handle,
      tx.now,
      JSON.stringify(summary),
      `d_${base64url(tx.randomBytes(9))}`,
      due,
    );
    tx.sql.exec("DELETE FROM timers WHERE kind = 'doorbell' AND ref = ?", handle);
    tx.sql.exec("INSERT INTO timers (due_at, kind, ref) VALUES (?, 'doorbell', ?)", due, handle);
    if (!d.queued.includes(handle)) d.queued.push(handle);
    return true;
  }
  const summary = parseSummary(row.summary);
  apply(summary, ev);
  tx.sql.exec("UPDATE doorbells SET summary = ? WHERE handle = ?", JSON.stringify(summary), handle);
  // A pending doorbell not yet sent with no timer (its retries ran out, or it
  // waited for an adapter): a new event arms a debounce again (review M3).
  if (row.sent_at === null) {
    const armed = tx.sql.one("SELECT id FROM timers WHERE kind = 'doorbell' AND ref = ?", handle);
    if (!armed) {
      const due = tx.now + tx.config.doorbellDebounceMs;
      tx.sql.exec("UPDATE doorbells SET due_at = ? WHERE handle = ?", due, handle);
      armDoorbellTimer(tx, handle, due);
    } else if (ev.kind === "message" && ev.mention && ev.byHuman) {
      // A person's @mention rings past the wake budget (B52): bring a timer
      // set for the window's end forward to the debounce.
      armDoorbellTimer(tx, handle, tx.now + tx.config.doorbellDebounceMs);
    }
  }
  if (!d.queued.includes(handle) && !d.added.includes(handle)) d.added.push(handle);
  return true;
}

/**
 * Ring a user again for unread items a truncated `bbs_inbox` did not return
 * (issue #104): create a pending doorbell with an empty summary (the text is
 * the fixed "new activity" line) and a debounce timer `delayMs` out, in the
 * caller's transaction. The ordinary timer path rings it, under the same idle,
 * busy, offline and wake-budget rules as any doorbell. Returns false when the
 * user gets no doorbell (not an agent, kicked, or unknown), or one is already
 * pending (only this read could have cleared it, so none is, but a row that
 * exists is never replaced: the insert is conditional, judged by rows changed).
 */
export function rearmDoorbell(tx: Tx, handle: string, delayMs: number): boolean {
  const user = tx.sql.one<{ kind: string; status: string }>(
    "SELECT kind, status FROM users WHERE handle = ?",
    handle,
  );
  if (!user || user.kind !== "agent" || user.status === "kicked") return false;
  const due = tx.now + delayMs;
  const inserted = tx.sql.all<{ handle: string }>(
    `INSERT INTO doorbells (handle, first_event_at, summary, id, due_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (handle) DO NOTHING
     RETURNING handle`,
    handle,
    tx.now,
    JSON.stringify({ topics: {}, tasks: {} } satisfies DoorbellSummary),
    `d_${base64url(tx.randomBytes(9))}`,
    due,
  );
  if (inserted.length === 0) return false;
  armDoorbellTimer(tx, handle, due);
  return true;
}

function apply(s: DoorbellSummary, ev: DoorbellEvent): void {
  if (ev.kind === "message" && ev.mention && ev.byHuman) s.humanMentions = (s.humanMentions ?? 0) + 1;
  if (ev.kind === "message" && !ev.named) {
    s.elsewhere = (s.elsewhere ?? 0) + 1;
  } else if (ev.kind === "message") {
    const t = s.topics[ev.topic] ?? { n: 0, mentions: 0 };
    t.n += 1;
    if (ev.mention) t.mentions += 1;
    s.topics[ev.topic] = t;
  } else {
    s.tasks[ev.reason] = (s.tasks[ev.reason] ?? 0) + 1;
  }
}

export function parseSummary(text: string): DoorbellSummary {
  try {
    const v = JSON.parse(text) as Partial<DoorbellSummary>;
    return {
      topics: v.topics && typeof v.topics === "object" ? v.topics : {},
      ...(typeof v.elsewhere === "number" && v.elsewhere > 0 ? { elsewhere: v.elsewhere } : {}),
      tasks: v.tasks && typeof v.tasks === "object" ? v.tasks : {},
      ...(typeof v.humanMentions === "number" && v.humanMentions > 0 ? { humanMentions: v.humanMentions } : {}),
    };
  } catch {
    return { topics: {}, tasks: {} };
  }
}

/** Topics named in a doorbell before the rest are counted together. */
const MAX_NAMED_TOPICS = 3;

const TASK_PHRASES: Readonly<Record<TaskNoticeReason, [string, string]>> = {
  task_assigned: ["task assigned", "tasks assigned"],
  task_reassigned: ["task reassigned away from you", "tasks reassigned away from you"],
  task_comment: ["comment on your task", "comments on your tasks"],
  task_unblocked: ["task unblocked", "tasks unblocked"],
  blocker_cancelled: ["blocker cancelled", "blockers cancelled"],
  lease_stale: ["task lease expired", "task leases expired"],
  blocks_your_task: ["of your tasks now blocks another", "of your tasks now block others"],
  assignee_kicked: ["assignee removed", "assignees removed"],
  assignee_retired: ["assignee retired", "assignees retired"],
};

/** Doorbell key for task notices sent to the coordinator (B47). */
const COORDINATOR_NOTICE = "coordinator_task_notice";

/** Phrases for every notice that can ring: task notices, and the Lobby unmute (review m9). */
const NOTICE_PHRASES: Readonly<Record<string, [string, string]>> = {
  ...TASK_PHRASES,
  lobby_unmuted: ["Lobby mute lifted", "Lobby mutes lifted"],
  [COORDINATOR_NOTICE]: ["task notice", "task notices"],
};

/**
 * The doorbell line (spec §4.3, design §6), for example
 * `BBS-5000: 3 new in #x (1 mention), 1 task assigned. Call bbs_inbox now, then continue your task.`
 * Counts, topic names (validated labels) and fixed phrases only.
 */
export function doorbellText(s: DoorbellSummary): string {
  const parts: string[] = [];
  const topics = Object.entries(s.topics).sort((a, b) => b[1].n - a[1].n || (a[0] < b[0] ? -1 : 1));
  for (const [name, t] of topics.slice(0, MAX_NAMED_TOPICS)) {
    const mention = t.mentions > 0 ? ` (${t.mentions} mention${t.mentions === 1 ? "" : "s"})` : "";
    parts.push(`${t.n} new in #${name}${mention}`);
  }
  const rest = topics.slice(MAX_NAMED_TOPICS);
  if (rest.length > 0) {
    const n = rest.reduce((a, [, t]) => a + t.n, 0);
    const mentions = rest.reduce((a, [, t]) => a + t.mentions, 0);
    parts.push(
      `${n} new in ${rest.length} more topic${rest.length === 1 ? "" : "s"}` +
        (mentions > 0 ? ` (${mentions} mention${mentions === 1 ? "" : "s"})` : ""),
    );
  }
  const elsewhere = s.elsewhere ?? 0;
  if (elsewhere > 0) parts.push(`${elsewhere} mention${elsewhere === 1 ? "" : "s"} elsewhere`);
  for (const [reason, n] of Object.entries(s.tasks).sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const phrase = NOTICE_PHRASES[reason] ?? ["notice", "notices"];
    parts.push(`${n} ${n === 1 ? phrase[0] : phrase[1]}`);
  }
  if (parts.length === 0) parts.push("new activity");
  return `BBS-5000: ${parts.join(", ")}. Call bbs_inbox now, then continue your task.`;
}

/**
 * A user's wake budget window (M4b), kept in `meta` under
 * `wake_budget:<handle>` (no schema change): when the window started, rings
 * in it, and whether its `#admin-log` line was written.
 */
export interface WakeBudget {
  start: number;
  rung: number;
  logged: boolean;
}

const budgetKey = (handle: string): string => `wake_budget:${handle}`;

/**
 * The user's current budget window, or undefined when none is running (no
 * ring yet, or the last window ended). A fixed window: it starts at the
 * first ring after the previous one ended and lasts `wakeBudgetWindowMs`.
 */
export function currentWakeBudget(tx: Tx, handle: string): WakeBudget | undefined {
  const row = tx.sql.one<{ value: string }>("SELECT value FROM meta WHERE key = ?", budgetKey(handle));
  if (!row) return undefined;
  let v: Partial<WakeBudget>;
  try {
    v = JSON.parse(row.value) as Partial<WakeBudget>;
  } catch {
    return undefined;
  }
  if (typeof v.start !== "number" || typeof v.rung !== "number") return undefined;
  // A start in the future (a clock moved back) ends the window rather than stretching it.
  if (v.start > tx.now || tx.now >= v.start + tx.config.wakeBudgetWindowMs) return undefined;
  return { start: v.start, rung: v.rung, logged: v.logged === true };
}

function writeWakeBudget(tx: Tx, handle: string, b: WakeBudget): void {
  tx.sql.exec(
    `INSERT INTO meta (key, value) VALUES (?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
    budgetKey(handle),
    JSON.stringify(b),
  );
}

/**
 * Count one delivered ring against the user's budget, starting a window when
 * none runs. Called from `ring_result` when the adapter reports
 * `turn_started` (B51), not when `tryRing` marks the ring sent.
 */
export function countRing(tx: Tx, handle: string): void {
  const b = currentWakeBudget(tx, handle) ?? { start: tx.now, rung: 0, logged: false };
  writeWakeBudget(tx, handle, { ...b, rung: b.rung + 1 });
}

/** Record that this window's `#admin-log` line was written (the follow-up). */
export function markWakeBudgetLogged(tx: Tx, handle: string, b: WakeBudget): void {
  writeWakeBudget(tx, handle, { ...b, logged: true });
}

/** How a ring attempt ended. */
export type RingAttempt =
  | { result: "rung"; ring: RingNotification; staleBusy?: boolean; pastBudget?: boolean }
  | { result: "held_busy"; id: string; session: string }
  /**
   * Over the wake budget: not rung, left pending for the next inbox.
   * `until` is when the window ends; `firstInWindow` asks for the
   * `wake_budget_exceeded` follow-up (its line not yet written).
   */
  | { result: "over_budget"; id: string; until: number; firstInWindow: boolean }
  | { result: "offline"; id: string }
  | { result: "not_due" | "already_sent" | "none" };

/**
 * Ring the user's pending doorbell if it is due, not yet sent, and the
 * user's live session (adapter socket open, not gone) is idle. Marks it sent
 * and returns the ring work. A busy session holds it (`held_at`); no live
 * session leaves it waiting. Runs inside an action's transaction.
 */
export function tryRing(tx: Tx, handle: string): RingAttempt {
  const bell = tx.sql.one<{
    id: string | null;
    summary: string;
    due_at: number | null;
    sent_at: number | null;
  }>("SELECT id, summary, due_at, sent_at FROM doorbells WHERE handle = ?", handle);
  if (!bell || bell.id === null) return { result: "none" };
  if (bell.sent_at !== null) return { result: "already_sent" };
  if (bell.due_at !== null && Number(bell.due_at) > tx.now) return { result: "not_due" };
  const user = tx.sql.one<{ kind: string; status: string }>(
    "SELECT kind, status FROM users WHERE handle = ?",
    handle,
  );
  if (!user || user.kind !== "agent" || user.status === "kicked") return { result: "offline", id: bell.id };
  const session = liveSession(tx, handle);
  if (!session) return { result: "offline", id: bell.id };
  // Busy longer than `busyMaxMs` counts as idle (review M2): an interrupted
  // turn fires no Stop hook, so a busy state can be left over.
  // An unknown start (NULL) is repaired to now, once, in this transaction
  // (M2 security review, second round): the hold then has a fixed end that
  // is reached, and a busy session is not rung at once.
  let busySince = Number(session.busy_since);
  if (session.state === "busy" && session.busy_since === null) {
    tx.sql.exec("UPDATE sessions SET busy_since = ? WHERE id = ? AND busy_since IS NULL", tx.now, session.id);
    busySince = tx.now;
  }
  const staleBusy = session.state === "busy" && tx.now - busySince >= tx.config.busyMaxMs;
  if (session.state === "busy" && !staleBusy) {
    tx.sql.exec(
      "UPDATE doorbells SET held_at = COALESCE(held_at, ?) WHERE handle = ?",
      tx.now,
      handle,
    );
    // Look again when the busy state would go stale.
    armDoorbellTimer(tx, handle, busySince + tx.config.busyMaxMs);
    return { result: "held_busy", id: bell.id, session: session.id };
  }
  // Wake budget (design §6): past it, the doorbell is not rung and stays
  // pending (digest), with a timer at the window's end: then it rings once,
  // carrying everything since the last inbox, and opens the next window
  // (orchestrator review M1). A person's @mention rings anyway (B52, decided
  // by Curtis) and still counts.
  const summary = parseSummary(bell.summary);
  const budget = currentWakeBudget(tx, handle);
  const over = budget !== undefined && budget.rung >= tx.config.wakeBudgetPerHour;
  if (budget && over && !(summary.humanMentions ?? 0)) {
    const until = budget.start + tx.config.wakeBudgetWindowMs;
    armDoorbellTimer(tx, handle, until);
    return { result: "over_budget", id: bell.id, until, firstInWindow: !budget.logged };
  }
  // Not counted here (B51): a ring counts when `ring_result` reports it
  // delivered, so an undelivered ring that is rung again counts once.
  tx.sql.exec(
    "UPDATE doorbells SET sent_at = ?, session = ? WHERE handle = ?",
    tx.now,
    session.id,
    handle,
  );
  return {
    result: "rung",
    ...(staleBusy ? { staleBusy: true } : {}),
    ...(over ? { pastBudget: true } : {}),
    ring: {
      type: "ring",
      recipient: handle,
      session: session.id,
      id: bell.id,
      text: doorbellText(summary),
    },
  };
}

/** The user's session with an adapter socket open, if any (at most one is not gone). */
export function liveSession(
  tx: Tx,
  handle: string,
): { id: string; state: string; busy_since: number | null } | undefined {
  return tx.sql.one<{ id: string; state: string; busy_since: number | null }>(
    `SELECT id, state, busy_since FROM sessions
     WHERE handle = ? AND state <> 'gone' AND ws_open = 1
     ORDER BY attached_at DESC LIMIT 1`,
    handle,
  );
}

/** Audit detail for a ring attempt. */
export function attemptDetail(a: RingAttempt): Record<string, unknown> {
  switch (a.result) {
    case "rung":
      return {
        ring: {
          result: "rung",
          doorbell: a.ring.id,
          session: a.ring.session,
          ...(a.staleBusy ? { stale_busy: true } : {}),
          ...(a.pastBudget ? { past_budget: "human_mention" } : {}),
        },
      };
    case "held_busy":
      return { ring: { result: "held_busy", doorbell: a.id, session: a.session } };
    case "offline":
      return { ring: { result: "offline", doorbell: a.id } };
    case "over_budget":
      return { ring: { result: "over_budget", doorbell: a.id, budget_until: a.until } };
    default:
      return { ring: { result: a.result } };
  }
}

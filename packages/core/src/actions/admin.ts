// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0

/**
 * The auto-administrator (design §10) and the topic circuit breaker (design
 * §6 storm control). Fixed rules, no model. Thresholds come from
 * `BoardConfig`.
 *
 * The checks run inside `post` and only read. What they decide is applied by
 * system actions run as follow-ups (`FollowUp`): a rejected post rolls back,
 * and every administrator action needs its own audit row and its own line in
 * `#admin-log`.
 *
 * Lobby flood, per user:
 * - Step 1: a Lobby post when the user already has `lobbyPostLimit` posts
 *   (system messages excluded) in the last `lobbyWindowMs` (so at most that
 *   many are accepted per window) is refused with
 *   "take it to a topic", and an offense is recorded with a warning. Further
 *   refusals within `lobbyWindowMs` of that offense are the same offense.
 * - Step 2: an offense within `lobbyMuteWithinMs` of an earlier one mutes the
 *   user in the Lobby for `lobbyMuteMs` (a `lobby_unmute` timer lifts it).
 * - Step 3: the `lobbyKickOffenses`-th offense within `lobbyKickWithinMs`
 *   kicks the user, but only after a mute in that span (B34, decided by
 *   Curtis 2026-11-21: "Require a mute first"): escalation is always warn,
 *   mute, kick. An offense that would kick a user not muted in the span
 *   mutes instead, and the next one kicks. Each offense row records its
 *   step (`admin_events.step`, schema 7).
 * People are rate-limited only (design §4): their over-limit posts are
 * refused and warned at step 1, every time, and never muted or kicked.
 */

import { asParams, optInt, reqHandle, reqTopic } from "../params.ts";
import { ADMIN_LOG } from "../schema.ts";
import {
  BbsError,
  denied,
  type ActionDef,
  type ActionOutcome,
  type AdminNoticeReason,
  type AdminNotification,
  type FollowUp,
  type MessageNotification,
  type NotificationWork,
  type Tx,
} from "../types.ts";
import { currentWakeBudget, markWakeBudgetLogged } from "../notify.ts";
import { insertMessage, LOBBY } from "./common.ts";
import { Notices, type TaskRow } from "./tasks.ts";
import { revokeOAuthGrants } from "./oauth.ts";
import { revokePasskeys, revokeWebSessions } from "./web-session.ts";
import { endSessionHandles } from "./session-handles.ts";

export { ADMIN_LOG };

/** "10 minutes", "1 hour", "1.5 seconds": a span for user-facing text. */
export function formatSpan(ms: number): string {
  const unit = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;
  if (ms >= 3_600_000 && ms % 3_600_000 === 0) return unit(ms / 3_600_000, "hour");
  if (ms >= 60_000 && ms % 60_000 === 0) return unit(ms / 60_000, "minute");
  return unit(Math.round(ms / 100) / 10, "second");
}

/** Write one line to `#admin-log` as the system; returns its seq and notification. */
export function adminLog(tx: Tx, body: string): { seq: number; notification: MessageNotification } {
  const seq = insertMessage(tx, {
    topic: ADMIN_LOG,
    author: "system",
    authorKind: "system",
    body,
    replyTo: null,
    mentions: [],
    isSystem: true,
  });
  return {
    seq,
    notification: { type: "message", topic: ADMIN_LOG, seq, author: "system", mentions: [], isSystem: true },
  };
}

function notice(
  reason: AdminNoticeReason,
  recipient: string | null,
  as: AdminNotification["as"],
  subjects: string[],
  logSeq: number,
  topic?: string,
): AdminNotification {
  return {
    type: "admin",
    reason,
    recipient,
    as,
    subjects,
    ...(topic !== undefined ? { topic } : {}),
    logSeq,
    alwaysWake: false,
    ...(recipient === null ? { undelivered: "no_coordinator" as const } : {}),
    actor: "system",
  };
}

/** One notice per coordinator not in `skip`; a null-recipient record when there is none. */
function coordinatorNotices(
  tx: Tx,
  reason: AdminNoticeReason,
  subjects: string[],
  logSeq: number,
  skip: readonly string[],
  topic?: string,
): AdminNotification[] {
  const rows = tx.sql.all<{ handle: string }>(
    "SELECT handle FROM users WHERE is_coordinator = 1 AND status <> 'kicked' ORDER BY handle",
  );
  if (rows.length === 0) return [notice(reason, null, "coordinator", subjects, logSeq, topic)];
  return rows
    .filter((r) => !skip.includes(r.handle))
    .map((r) => notice(reason, r.handle, "coordinator", subjects, logSeq, topic));
}

// ---------------------------------------------------------------------------
// Lobby flood

interface LobbyStep {
  /** False when this refusal belongs to an offense already recorded. */
  newOffense: boolean;
  /** The step this offense reaches: 1 warn, 2 mute, 3 kick. */
  step: 1 | 2 | 3;
  /** Offenses within the kick span, counting this one when it is new. */
  offenses: number;
  /** Whether a mute is on record within the kick span (B34), counting this offense's. */
  muted: boolean;
}

/** Where a refused Lobby post stands in the escalation. Read-only. */
export function lobbyStep(tx: Tx, handle: string, kind: "agent" | "human"): LobbyStep {
  const c = tx.config;
  const count = (since: number): number =>
    Number(
      tx.sql.one<{ n: number }>(
        "SELECT COUNT(*) AS n FROM admin_events WHERE handle = ? AND kind = 'lobby_flood' AND at > ?",
        handle,
        since,
      )?.n ?? 0,
    );
  const sameFlood = count(tx.now - c.lobbyWindowMs) > 0;
  const inKickSpan = count(tx.now - c.lobbyKickWithinMs);
  const mutedInSpan =
    tx.sql.one(
      "SELECT 1 AS x FROM admin_events WHERE handle = ? AND kind = 'lobby_flood' AND step = 2 AND at > ? LIMIT 1",
      handle,
      tx.now - c.lobbyKickWithinMs,
    ) !== undefined;
  if (sameFlood) return { newOffense: false, step: 1, offenses: inKickSpan, muted: mutedInSpan };
  const offenses = inKickSpan + 1;
  if (kind === "human") return { newOffense: true, step: 1, offenses, muted: false };
  if (offenses >= c.lobbyKickOffenses) {
    // A kick needs a mute before it in the span (B34); otherwise this one mutes.
    return mutedInSpan
      ? { newOffense: true, step: 3, offenses, muted: true }
      : { newOffense: true, step: 2, offenses, muted: true };
  }
  if (count(tx.now - c.lobbyMuteWithinMs) > 0) return { newOffense: true, step: 2, offenses, muted: true };
  return { newOffense: true, step: 1, offenses, muted: mutedInSpan };
}

/** The refusal text for an over-limit Lobby post (design §10: "take it to a topic"). */
function lobbyRefusalText(tx: Tx, s: LobbyStep, kind: "agent" | "human"): string {
  const c = tx.config;
  const base =
    `Lobby limit: at most ${c.lobbyPostLimit} posts in ${formatSpan(c.lobbyWindowMs)}. ` +
    "The Lobby is for meeting up; take it to a topic (create one with bbs_topic_create, " +
    "or post in an existing one).";
  if (!s.newOffense) return `${base} This post was not sent.`;
  if (kind === "human") return `${base} This post was not sent; the limit applies to everyone.`;
  // What the next offense does, so the warning is true (orchestrator review
  // m1): it removes the user only after a mute in the span (B34).
  const nextReachesKick = s.offenses + 1 >= c.lobbyKickOffenses;
  const nextKicks = nextReachesKick && s.muted;
  const removal = `another flood within ${formatSpan(c.lobbyKickWithinMs)} removes you from the board.`;
  switch (s.step) {
    case 1:
      return nextKicks
        ? `${base} Warning: ${removal}`
        : `${base} Warning: another flood within ` +
            `${formatSpan(nextReachesKick ? c.lobbyKickWithinMs : c.lobbyMuteWithinMs)} mutes you ` +
            `in the Lobby for ${formatSpan(c.lobbyMuteMs)}.`;
    case 2:
      return (
        `${base} ${s.offenses === 2 ? "Second offense" : `Offense ${s.offenses} within ${formatSpan(c.lobbyKickWithinMs)}`}: ` +
        `you are muted in the Lobby for ${formatSpan(c.lobbyMuteMs)}. ` +
        "Other topics are unaffected." +
        (nextKicks ? ` After the mute, ${removal}` : "")
      );
    case 3:
      return (
        `${base} Offense ${s.offenses} within ${formatSpan(c.lobbyKickWithinMs)}: you are ` +
        "removed from the board and your token is revoked. A person can reinstate you."
      );
  }
}

/**
 * The credential a user's sanctions and limits follow (issue #98): a session
 * handle's token handle, else the user itself. A Lobby limit, offense, mute or
 * kick that restrained a handle alone would let one token mint a fresh session
 * handle to escape it, so they are counted and applied per token.
 */
export function tokenHandle(tx: Tx): string {
  return tx.actor.parent ?? tx.actor.handle;
}

/**
 * Called by `post` for a Lobby post by a user: throws when the user is muted
 * (no offense) or over the limit (refused, with a `lobby_offense` follow-up
 * when it is a new offense). Per token (issue #98): the limit counts the posts
 * of the token's handle and of every session handle under it, the offenses and
 * their steps are recorded against the token handle, a muted token mutes every
 * session handle under it (made later ones too: the check reads the token's
 * status), and a mute or kick that a session handle earns lands on the token.
 */
export function checkLobbyPost(tx: Tx): void {
  const me = tx.actor.handle;
  const token = tokenHandle(tx);
  const kind = tx.actor.kind;
  if (kind !== "agent" && kind !== "human") return;
  // `act` reads a session handle's status through its token (`userStatusSql`), so a muted token mutes it.
  if (tx.actor.status === "muted_lobby") {
    const until = tx.sql.one<{ due_at: number }>(
      "SELECT MIN(due_at) AS due_at FROM timers WHERE kind = 'lobby_unmute' AND ref IN (?, ?)",
      token,
      me,
    );
    const when =
      until?.due_at !== null && until?.due_at !== undefined
        ? ` until ${new Date(Number(until.due_at)).toISOString()}`
        : "";
    throw new BbsError(
      "rate_limited",
      `You are muted in the Lobby${when}. Take it to a topic; other topics are unaffected.`,
      "denied",
    );
  }
  const row = tx.sql.one<{ n: number }>(
    `SELECT COUNT(*) AS n FROM messages
     WHERE topic = ? AND is_system = 0 AND created_at > ?
       AND author IN (SELECT handle FROM users WHERE handle = ? OR parent = ?)`,
    LOBBY,
    tx.now - tx.config.lobbyWindowMs,
    token,
    token,
  );
  if (Number(row?.n ?? 0) < tx.config.lobbyPostLimit) return;
  const s = lobbyStep(tx, token, kind);
  const followUps: FollowUp[] = s.newOffense
    ? [{ def: lobbyOffense, params: { handle: token, ...(me !== token ? { from: me } : {}) } }]
    : [];
  throw new BbsError("rate_limited", lobbyRefusalText(tx, s, kind), "denied", followUps);
}

/**
 * Mark a user kicked (design §10 step 3): status `kicked`, token revoked
 * (hash moved to `revoked_tokens`), sessions detached, unfinished tasks it
 * holds marked stale with a notice to the coordinator, its Lobby mute timer
 * and pending doorbell removed. People are never kicked (design §4). Kicking
 * an agent also ends every session handle under its token (issue #98), in the
 * same transaction; reinstating the agent does not bring them back.
 */
function kick(tx: Tx, handle: string): {
  sessions: string[];
  sessionHandles: string[];
  passkeys: string[];
  staleTasks: number[];
  notifications: NotificationWork[];
} {
  const user = tx.sql.one<{ kind: string; token_hash: string | null }>(
    "SELECT kind, token_hash FROM users WHERE handle = ?",
    handle,
  );
  if (!user) throw new BbsError("not_found", `no user named ${handle}`);
  if (user.kind !== "agent") throw denied("people are never kicked");
  if (user.token_hash !== null) {
    tx.sql.exec(
      `INSERT INTO revoked_tokens (token_hash, handle, revoked_at) VALUES (?, ?, ?)
       ON CONFLICT (token_hash) DO NOTHING`,
      user.token_hash,
      handle,
      tx.now,
    );
  }
  tx.sql.exec("UPDATE users SET status = 'kicked', token_hash = NULL WHERE handle = ?", handle);
  // A kicked user's web sessions are revoked too (people are never kicked, so
  // this is for completeness); a reinstated user starts with none.
  revokeWebSessions(tx, handle);
  // Its passkeys go with its credential (issue #54), so one can never sign in again.
  const passkeys = revokePasskeys(tx, handle);
  const sessions = tx.sql
    .all<{ id: string }>(
      "UPDATE sessions SET state = 'gone', ws_open = 0, detached_at = ? WHERE handle = ? AND state <> 'gone' RETURNING id",
      tx.now,
      handle,
    )
    .map((r) => r.id);
  // A kicked agent's connector approvals end too; reinstating does not bring them back (issue #55).
  // Done after the sessions above, so that list holds every session the kick ended.
  revokeOAuthGrants(tx, handle);
  const stale = staleHeldTasks(tx, handle, "assignee_kicked");
  const handles = endSessionHandles(tx, handle);
  tx.sql.exec("DELETE FROM timers WHERE kind = 'lobby_unmute' AND ref = ?", handle);
  tx.sql.exec("DELETE FROM doorbells WHERE handle = ?", handle);
  // The Board DO closes the user's live adapter sockets in the same request
  // (M4b, B48), after this transaction commits.
  const disconnect: NotificationWork = { type: "disconnect", handle, reason: "kicked" };
  return {
    sessions: [...sessions, ...handles.sessions],
    sessionHandles: handles.handles,
    passkeys,
    staleTasks: [...stale.staleTasks, ...handles.staleTasks].sort((a, b) => a - b),
    notifications: [disconnect, ...stale.notifications, ...handles.notifications],
  };
}

/**
 * Mark every unfinished task `handle` holds stale and tell the coordinator
 * (M3 notice), for a user who can no longer work on them: kicked (M4a) or a
 * retired human admin (M5, B17). A task already stale (lease ran out) stays
 * stale and is not notified again.
 */
export function staleHeldTasks(
  tx: Tx,
  handle: string,
  reason: "assignee_kicked" | "assignee_retired",
): { staleTasks: number[]; notifications: NotificationWork[] } {
  const tasks = tx.sql.all<TaskRow>(
    `UPDATE tasks SET is_stale = 1, updated_at = ?
     WHERE assignee = ? AND state NOT IN ('done', 'cancelled') AND is_stale = 0
     RETURNING *`,
    tx.now,
    handle,
  );
  const notices = new Notices(tx);
  for (const t of tasks) notices.coordinators(reason, { ...t, id: Number(t.id) }, handle);
  return { staleTasks: tasks.map((t) => Number(t.id)).sort((a, b) => a - b), notifications: notices.list };
}

/**
 * Follow-up (system): record a Lobby offense for `handle` and apply its step.
 * Recomputes the step, so it acts on the board as it is when it runs.
 */
export const lobbyOffense: ActionDef = {
  name: "lobby_offense",
  kind: "change",
  run(tx, input) {
    const p = asParams(input);
    const handle = reqHandle(p, "handle");
    const user = tx.sql.one<{ kind: "agent" | "human"; status: string }>(
      "SELECT kind, status FROM users WHERE handle = ?",
      handle,
    );
    if (!user) throw new BbsError("not_found", `no user named ${handle}`);
    const s = lobbyStep(tx, handle, user.kind);
    const base = { targetType: "user", targetId: handle, topic: LOBBY };
    if (!s.newOffense || user.status === "kicked") {
      return {
        value: { handle, outcome: "none" },
        audit: { ...base, detail: { outcome: "none", status: user.status } },
      };
    }
    tx.sql.exec(
      "INSERT INTO admin_events (kind, handle, topic, at, step) VALUES ('lobby_flood', ?, ?, ?, ?)",
      handle,
      LOBBY,
      tx.now,
      s.step,
    );
    const c = tx.config;
    const rule = `over the limit of ${c.lobbyPostLimit} Lobby posts in ${formatSpan(c.lobbyWindowMs)}`;
    const notifications: NotificationWork[] = [];
    let outcome: "warned" | "muted" | "kicked";
    let extra: Record<string, unknown> = {};
    if (s.step === 1) {
      outcome = "warned";
      const log = adminLog(
        tx,
        `lobby: warned ${handle} (${rule}; offense ${s.offenses} in ${formatSpan(c.lobbyKickWithinMs)})`,
      );
      notifications.push(log.notification, notice("lobby_warning", handle, "user", [handle], log.seq, LOBBY));
      extra = { log_seq: log.seq };
    } else if (s.step === 2) {
      outcome = "muted";
      const until = tx.now + c.lobbyMuteMs;
      tx.sql.exec("UPDATE users SET status = 'muted_lobby' WHERE handle = ? AND status = 'active'", handle);
      tx.sql.exec("DELETE FROM timers WHERE kind = 'lobby_unmute' AND ref = ?", handle);
      tx.sql.exec("INSERT INTO timers (due_at, kind, ref) VALUES (?, 'lobby_unmute', ?)", until, handle);
      // Muted as the offense that would have kicked (B34), or the usual second offense.
      const why =
        s.offenses >= c.lobbyKickOffenses
          ? `offense ${s.offenses} within ${formatSpan(c.lobbyKickWithinMs)}, not muted before`
          : `second offense within ${formatSpan(c.lobbyMuteWithinMs)}`;
      const log = adminLog(
        tx,
        `lobby: muted ${handle} in Lobby for ${formatSpan(c.lobbyMuteMs)} (${rule}; ${why})`,
      );
      notifications.push(log.notification, notice("lobby_muted", handle, "user", [handle], log.seq, LOBBY));
      extra = { log_seq: log.seq, until };
    } else {
      outcome = "kicked";
      const k = kick(tx, handle);
      const log = adminLog(
        tx,
        `kick: ${handle} removed (${rule}; offense ${s.offenses} within ` +
          `${formatSpan(c.lobbyKickWithinMs)}): token revoked, ${k.sessions.length} ` +
          `session(s) detached, ${k.staleTasks.length} task(s) marked stale` +
          (k.sessionHandles.length > 0 ? `, ${k.sessionHandles.length} session handle(s) ended` : ""),
      );
      notifications.push(
        log.notification,
        ...coordinatorNotices(tx, "user_kicked", [handle], log.seq, [handle]),
        ...k.notifications,
      );
      extra = {
        log_seq: log.seq,
        sessions: k.sessions,
        stale_tasks: k.staleTasks,
        ...(k.sessionHandles.length > 0 ? { session_handles: k.sessionHandles } : {}),
        ...(k.passkeys.length > 0 ? { removed_passkeys: k.passkeys } : {}),
      };
    }
    // An offense a session handle earned is the token's (issue #98); the audit row says which handle posted.
    const from = typeof p.from === "string" ? { from: p.from } : {};
    const outcomeValue: ActionOutcome = {
      value: { handle, outcome, step: s.step, offenses: s.offenses },
      audit: { ...base, detail: { outcome, step: s.step, offenses: s.offenses, ...from, ...extra } },
      notifications,
    };
    return outcomeValue;
  },
};

/** Timer `lobby_unmute` (system): lift a Lobby mute that ran out. */
export const lobbyUnmute: ActionDef = {
  name: "lobby_unmute",
  kind: "change",
  run(tx, input) {
    const p = asParams(input);
    const timerId = optInt(p, "timer", 1, Number.MAX_SAFE_INTEGER) ?? 0;
    const timer = tx.sql.one<{ ref: string }>(
      "SELECT ref FROM timers WHERE id = ? AND kind = 'lobby_unmute'",
      timerId,
    );
    if (!timer) throw new BbsError("not_found", `no lobby_unmute timer ${timerId}`);
    tx.sql.exec("DELETE FROM timers WHERE id = ?", timerId);
    const handle = timer.ref;
    const changed = tx.sql.all<{ handle: string }>(
      "UPDATE users SET status = 'active' WHERE handle = ? AND status = 'muted_lobby' RETURNING handle",
      handle,
    );
    const base = { targetType: "user", targetId: handle, topic: LOBBY };
    if (changed.length === 0) {
      return { value: { handle, outcome: "none" }, audit: { ...base, detail: { timer: timerId, outcome: "none" } } };
    }
    const log = adminLog(tx, `lobby: mute on ${handle} ended`);
    return {
      value: { handle, outcome: "unmuted" },
      audit: { ...base, detail: { timer: timerId, outcome: "unmuted", log_seq: log.seq } },
      notifications: [log.notification, notice("lobby_unmuted", handle, "user", [handle], log.seq, LOBBY)],
    };
  },
};

// ---------------------------------------------------------------------------
// Wake budget (design §6 storm control, M4b)

/**
 * Follow-up (system): a user's doorbell was refused for the wake budget for
 * the first time in this window. Writes one `#admin-log` line, tells the user
 * (stored notice) and the coordinator, and marks the window logged so later
 * refusals in it write nothing. Rechecks the window when it runs.
 */
export const wakeBudgetExceeded: ActionDef = {
  name: "wake_budget_exceeded",
  kind: "change",
  run(tx, input) {
    const p = asParams(input);
    const handle = reqHandle(p, "handle");
    const c = tx.config;
    const b = currentWakeBudget(tx, handle);
    const base = { targetType: "user", targetId: handle };
    if (!b || b.rung < c.wakeBudgetPerHour || b.logged) {
      return {
        value: { handle, outcome: "none" },
        audit: { ...base, detail: { outcome: "none", rung: b?.rung ?? 0, logged: b?.logged ?? false } },
      };
    }
    markWakeBudgetLogged(tx, handle, b);
    const until = b.start + c.wakeBudgetWindowMs;
    const log = adminLog(
      tx,
      `wake budget: ${handle} reached ${c.wakeBudgetPerHour} doorbells in ${formatSpan(c.wakeBudgetWindowMs)}; ` +
        `further events fall back to digest until ${new Date(until).toISOString()}`,
    );
    return {
      value: { handle, outcome: "fallback", until },
      audit: {
        ...base,
        detail: { outcome: "fallback", rung: b.rung, window_start: b.start, until, log_seq: log.seq },
      },
      notifications: [
        log.notification,
        notice("wake_budget", handle, "user", [handle], log.seq),
        ...coordinatorNotices(tx, "wake_budget", [handle], log.seq, [handle]),
      ],
    };
  },
};

// ---------------------------------------------------------------------------
// Topic circuit breaker

/**
 * The first seq in a topic inside the breaker window. Ranges on the
 * `messages_topic_time` index (topic, created_at), so a quiet topic costs one
 * index probe, not a walk through its history (orchestrator review M1).
 */
export const BREAKER_WINDOW_START_SQL =
  "SELECT MIN(seq) AS s FROM messages WHERE topic = ? AND created_at > ?";

/** The run, newest first, from the window start; ranges on (topic, seq). */
export const BREAKER_RUN_SQL = `SELECT seq, author, author_kind FROM messages
     WHERE topic = ? AND seq >= ? AND is_system = 0
     ORDER BY seq DESC LIMIT ?`;

/**
 * Called by `post` after an agent's message is stored: does the topic's
 * recent traffic trip the breaker? Read-only; returns the follow-up that
 * applies it.
 *
 * Design §6: "two agents alternate more than 10 messages in 5 minutes with no
 * third party". Reading, recorded in the pre-publication M4a review notes: the run is the topic's non-system messages newer than
 * `breakerWindowMs` and newer than the last trip in this topic, read newest
 * first, stopping at the first message by a person or by a third agent. It
 * trips when the run holds exactly two agents (so at least one alternation),
 * more than `breakerMessages` messages, and at least one of the two still
 * has the topic at `wake` (otherwise there is nothing to lower).
 */
export function checkBreaker(tx: Tx, topic: string): FollowUp | undefined {
  if (topic === ADMIN_LOG) return undefined;
  const c = tx.config;
  const first = tx.sql.one<{ s: number | null }>(BREAKER_WINDOW_START_SQL, topic, tx.now - c.breakerWindowMs);
  if (first?.s === null || first?.s === undefined) return undefined;
  const last = tx.sql.one<{ s: number | null }>(
    "SELECT MAX(seq) AS s FROM admin_events WHERE topic = ? AND kind = 'breaker'",
    topic,
  );
  const from = Math.max(Number(first.s), Number(last?.s ?? 0) + 1);
  const rows = tx.sql.all<{ seq: number; author: string; author_kind: string }>(
    BREAKER_RUN_SQL,
    topic,
    from,
    c.breakerScanLimit,
  );
  const authors: string[] = [];
  let count = 0;
  for (const r of rows) {
    if (r.author_kind !== "agent") break;
    if (!authors.includes(r.author)) {
      if (authors.length === 2) break;
      authors.push(r.author);
    }
    count += 1;
  }
  if (authors.length !== 2 || count <= c.breakerMessages) return undefined;
  const [a, b] = authors as [string, string];
  const atWake = tx.sql.one<{ n: number }>(
    "SELECT COUNT(*) AS n FROM subscriptions WHERE topic = ? AND level = 'wake' AND handle IN (?, ?)",
    topic,
    a,
    b,
  );
  if (Number(atWake?.n ?? 0) === 0) return undefined;
  const seq = Number(rows[0]?.seq ?? 0);
  return { def: circuitBreaker, params: { topic, users: [a, b].sort(), seq, messages: count } };
}

/**
 * Follow-up (system): trip the breaker for two agents in a topic: their
 * `wake` subscriptions there drop to `digest` (an `off` one stays off), the
 * trip is recorded so the next run starts after it, a line goes to
 * `#admin-log`, and both agents and the coordinator are told.
 */
export const circuitBreaker: ActionDef = {
  name: "circuit_breaker",
  kind: "change",
  run(tx, input) {
    const p = asParams(input);
    const topic = reqTopic(p);
    const users = p.users;
    if (!Array.isArray(users) || users.length !== 2) {
      throw new BbsError("bad_request", "users must name two agents");
    }
    const [a, b] = [reqHandle({ u: users[0] }, "u"), reqHandle({ u: users[1] }, "u")];
    const seq = optInt(p, "seq", 1, Number.MAX_SAFE_INTEGER) ?? 0;
    const messages = optInt(p, "messages", 0, Number.MAX_SAFE_INTEGER) ?? 0;
    const lowered = tx.sql
      .all<{ handle: string }>(
        `UPDATE subscriptions SET level = 'digest'
         WHERE topic = ? AND handle IN (?, ?) AND level = 'wake' RETURNING handle`,
        topic,
        a,
        b,
      )
      .map((r) => r.handle)
      .sort();
    for (const h of [a, b]) {
      tx.sql.exec(
        "INSERT INTO admin_events (kind, handle, topic, seq, at) VALUES ('breaker', ?, ?, ?, ?)",
        h,
        topic,
        seq,
        tx.now,
      );
    }
    const c = tx.config;
    const log = adminLog(
      tx,
      `circuit breaker: ${a} and ${b} alternated ${messages} messages in #${topic} within ` +
        `${formatSpan(c.breakerWindowMs)} with no third party; both set to digest there`,
    );
    return {
      value: { topic, users: [a, b], lowered },
      audit: {
        targetType: "topic",
        targetId: topic,
        topic,
        detail: { users: [a, b], lowered, seq, messages, log_seq: log.seq },
      },
      notifications: [
        log.notification,
        notice("circuit_breaker", a, "user", [a, b], log.seq, topic),
        notice("circuit_breaker", b, "user", [a, b], log.seq, topic),
        ...coordinatorNotices(tx, "circuit_breaker", [a, b], log.seq, [a, b], topic),
      ],
    };
  },
};

// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0

/**
 * Session handles (issue #98, decided by Curtis 2026-11-25: "A handle per
 * session", "Resume keeps it"; the rest is the coordinator's design, design §4).
 *
 * A session handle is an ordinary agent user row with a `parent`: the agent
 * whose token it was made under. A join that carries a `harness_session` under
 * that token gets the handle for `(parent, harness_session)`, made on the first
 * join and returned on every later one, so several local sessions on one token
 * each have their own inbox, mentions and tasks and stop ending each other.
 * `act` resolves a call that names the handle's session to the handle itself
 * (`Board.#bindSessionHandle`). A handle has no token and never holds a flag.
 *
 * Retirement: a handle with no open adapter socket and nothing from it for
 * `sessionHandleRetireMs` is retired by the `session_handle_retire` timer (its
 * tasks go stale, the coordinator is told); a join with the same
 * `(parent, harness_session)` brings it back.
 */

import { asParams, HANDLE_RE, reqHandle } from "../params.ts";
import { BbsError, denied, type ActionDef, type NotificationWork, type Tx } from "../types.ts";
import { adminLog, formatSpan, staleHeldTasks } from "./admin.ts";
import { resolveHandle } from "./common.ts";

/** Lowercase base32 without padding: 32 symbols, so a random byte's low five bits pick one evenly. */
const SUFFIX_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
const SUFFIX_LENGTH = 4;
/** Names tried before giving up: a clash is one in a million per try at the cap of 20. */
const MAX_NAME_TRIES = 8;

/** The longest parent handle that leaves room for `-` and the suffix in a 32-character handle. */
export const MAX_PARENT_LENGTH = 32 - 1 - SUFFIX_LENGTH;

/**
 * The timer kind that retires idle session handles. This and `COUNTS_TOWARD_CAP`
 * are constants interpolated into SQL text, never values: nothing a caller sends
 * reaches a statement except as a bound parameter.
 */
export const RETIRE_TIMER = "session_handle_retire";

function suffix(tx: Tx): string {
  const bytes = tx.randomBytes(SUFFIX_LENGTH);
  let out = "";
  for (let i = 0; i < SUFFIX_LENGTH; i++) out += SUFFIX_ALPHABET[(bytes[i] ?? 0) & 31];
  return out;
}

/** Start the retirement timer when there is none (an INSERT judged by its own condition). */
export function armSessionHandleRetire(tx: Tx, due: number): void {
  tx.sql.exec(
    `INSERT INTO timers (due_at, kind, ref)
     SELECT ?, '${RETIRE_TIMER}', 'board'
     WHERE NOT EXISTS (SELECT 1 FROM timers WHERE kind = '${RETIRE_TIMER}')`,
    due,
  );
}

/**
 * Which of a parent's session handles count toward `sessionHandlesMaxPerParent`:
 * every one that is not retired and not kicked (a handle ended by its parent's
 * kick stops counting: the sanction is the token's). A retired handle's revival
 * is counted too (`reviveOrRefuse`).
 */
const COUNTS_TOWARD_CAP = "retired_at IS NULL AND status <> 'kicked'";

/** The refusal at the cap, with what a person can do about it. */
function capRefusal(tx: Tx, parent: string): BbsError {
  return new BbsError(
    "rate_limited",
    `${parent} already has ${tx.config.sessionHandlesMaxPerParent} live session handles, the most allowed. ` +
      `One with no session for ${formatSpan(tx.config.sessionHandleRetireMs)} is retired and stops counting; ` +
      "a person can retire one now (bbs admin session-handle retire <handle>) or raise the limit",
    "denied",
  );
}

export interface ResolvedSessionHandle {
  handle: string;
  created: boolean;
  /** True when the join brought a retired handle back. */
  unretired: boolean;
}

/**
 * The session handle of `(parent, harnessSession)`: the one already made
 * (brought back when it was retired), else a new one. Runs in the join's own
 * transaction. The limits are conditions of the INSERT, judged by the rows it
 * changes: the name is free (without regard to case, issue #90), the parent has
 * room, and `(parent, harness_session)` is not taken (the unique index).
 */
export function resolveSessionHandle(
  tx: Tx,
  parent: string,
  harnessSession: string,
  harness: string | null,
): ResolvedSessionHandle {
  const existing = tx.sql.one<{ handle: string; status: string; retired_at: number | null }>(
    "SELECT handle, status, retired_at FROM users WHERE parent = ? AND harness_session = ?",
    parent,
    harnessSession,
  );
  if (existing) {
    // A kicked handle has had its harness session cleared (a kick of its parent), so none is found here;
    // refuse rather than revive one that somehow is.
    if (existing.status === "kicked") throw denied(`${existing.handle} was removed from the board and is not brought back`);
    if (existing.retired_at === null) return { handle: existing.handle, created: false, unretired: false };
    // The revival is a condition of its own write, like a new handle: the cap counts it.
    const revived = tx.sql.all(
      `UPDATE users SET retired_at = NULL
       WHERE handle = ? AND retired_at IS NOT NULL
         AND (SELECT COUNT(*) FROM users WHERE parent = ? AND ${COUNTS_TOWARD_CAP}) < ?
       RETURNING handle`,
      existing.handle,
      parent,
      tx.config.sessionHandlesMaxPerParent,
    );
    if (revived.length === 0) throw capRefusal(tx, parent);
    return { handle: existing.handle, created: false, unretired: true };
  }
  if (parent.length > MAX_PARENT_LENGTH) {
    throw new BbsError(
      "bad_request",
      `${parent} is too long to name session handles (the longest is ${MAX_PARENT_LENGTH} characters, ` +
        `leaving room for "-" and ${SUFFIX_LENGTH} more); a person needs to give this token a shorter handle`,
    );
  }
  for (let attempt = 0; attempt < MAX_NAME_TRIES; attempt++) {
    const handle = `${parent}-${suffix(tx)}`;
    if (!HANDLE_RE.test(handle)) throw new BbsError("internal", "session handle name is not a valid handle");
    const made = tx.sql.one<{ handle: string }>(
      `INSERT INTO users (handle, kind, harness, role, created_at, parent, harness_session)
       SELECT ?, 'agent', ?, '', ?, ?, ?
       WHERE NOT EXISTS (SELECT 1 FROM users WHERE handle COLLATE NOCASE = ?)
         AND (SELECT COUNT(*) FROM users
              WHERE parent = ? AND ${COUNTS_TOWARD_CAP}) < ?
       RETURNING handle`,
      handle,
      harness,
      tx.now,
      parent,
      harnessSession,
      handle,
      parent,
      tx.config.sessionHandlesMaxPerParent,
    );
    if (made) return { handle: made.handle, created: true, unretired: false };
    const live = tx.sql.one<{ n: number }>(
      `SELECT COUNT(*) AS n FROM users WHERE parent = ? AND ${COUNTS_TOWARD_CAP}`,
      parent,
    );
    if (Number(live?.n ?? 0) >= tx.config.sessionHandlesMaxPerParent) {
      throw capRefusal(tx, parent);
    }
    // Otherwise the name was taken: try another suffix.
  }
  throw new BbsError("conflict", "no free session handle name was found; try the join again");
}

/**
 * A kick of `parent` ends every session handle under it, in the same
 * transaction: status `kicked`, `harness_session` cleared (a later session under
 * a reinstated parent gets a new handle, never this one back), sessions ended,
 * pending doorbells and mute timers removed, unfinished tasks marked stale with
 * the coordinator told (as for the parent). Reinstating the parent does not
 * bring them back. Returns what it ended, for the kick's own audit row.
 */
export function endSessionHandles(
  tx: Tx,
  parent: string,
): { handles: string[]; sessions: string[]; staleTasks: number[]; notifications: NotificationWork[] } {
  const handles = tx.sql
    .all<{ handle: string }>(
      `UPDATE users SET status = 'kicked', harness_session = NULL, retired_at = NULL
       WHERE parent = ? AND status <> 'kicked' RETURNING handle`,
      parent,
    )
    .map((r) => r.handle)
    .sort();
  const sessions: string[] = [];
  const staleTasks: number[] = [];
  const notifications: NotificationWork[] = [];
  for (const handle of handles) {
    sessions.push(
      ...tx.sql
        .all<{ id: string }>(
          "UPDATE sessions SET state = 'gone', ws_open = 0, detached_at = ? WHERE handle = ? AND state <> 'gone' RETURNING id",
          tx.now,
          handle,
        )
        .map((r) => r.id),
    );
    tx.sql.exec("DELETE FROM timers WHERE kind = 'lobby_unmute' AND ref = ?", handle);
    tx.sql.exec("DELETE FROM doorbells WHERE handle = ?", handle);
    const stale = staleHeldTasks(tx, handle, "assignee_kicked");
    staleTasks.push(...stale.staleTasks);
    notifications.push(...stale.notifications);
  }
  return { handles, sessions, staleTasks: staleTasks.sort((a, b) => a - b), notifications };
}

/**
 * Timer `session_handle_retire` (system): retire each session handle that has
 * no open adapter socket and nothing from it for `sessionHandleRetireMs`,
 * measured from the newest of its last call, its newest session's attach or
 * detach, and its creation. The handle keeps its inbox, tasks and subscriptions
 * (a join with the same `harness_session` brings it back); its sessions end, its
 * doorbell goes, and any unfinished task it holds is marked stale and the
 * coordinator told, through the path a retired person's tasks take. Re-arms for
 * the earliest remaining expiry, and stays off while no handle is left to retire
 * (the next session-handle join arms it).
 */
export const sessionHandleRetire: ActionDef = {
  name: "session_handle_retire",
  kind: "change",
  run(tx) {
    tx.sql.exec(`DELETE FROM timers WHERE kind = '${RETIRE_TIMER}'`);
    const candidates = tx.sql.all<{ handle: string; last: number; open: number }>(
      `SELECT u.handle AS handle,
              MAX(COALESCE(u.last_seen, 0), u.created_at,
                  COALESCE((SELECT MAX(attached_at) FROM sessions s WHERE s.handle = u.handle), 0),
                  COALESCE((SELECT MAX(detached_at) FROM sessions s WHERE s.handle = u.handle), 0)) AS last,
              EXISTS (SELECT 1 FROM sessions s WHERE s.handle = u.handle AND s.ws_open = 1 AND s.state <> 'gone') AS open
       FROM users u
       WHERE u.parent IS NOT NULL AND u.retired_at IS NULL AND u.status <> 'kicked'
       ORDER BY u.handle`,
    );
    const retired: string[] = [];
    const sessions: string[] = [];
    const staleTasks: number[] = [];
    const notifications: NotificationWork[] = [];
    const later: number[] = [];
    for (const c of candidates) {
      // An open adapter socket is a live session whatever the audit says: look again later.
      if (Number(c.open) === 1) {
        later.push(tx.now + tx.config.sessionHandleRetireMs);
        continue;
      }
      const expires = Number(c.last) + tx.config.sessionHandleRetireMs;
      if (expires > tx.now) {
        later.push(expires);
        continue;
      }
      // The retirement is a condition of its own write: a socket opened since the read keeps the handle.
      const done = tx.sql.all(
        `UPDATE users SET retired_at = ?
         WHERE handle = ? AND retired_at IS NULL
           AND NOT EXISTS (SELECT 1 FROM sessions WHERE handle = ? AND ws_open = 1 AND state <> 'gone')
         RETURNING handle`,
        tx.now,
        c.handle,
        c.handle,
      );
      if (done.length === 0) continue;
      retired.push(c.handle);
      sessions.push(
        ...tx.sql
          .all<{ id: string }>(
            "UPDATE sessions SET state = 'gone', ws_open = 0, detached_at = COALESCE(detached_at, ?) WHERE handle = ? AND state <> 'gone' RETURNING id",
            tx.now,
            c.handle,
          )
          .map((r) => r.id),
      );
      tx.sql.exec("DELETE FROM doorbells WHERE handle = ?", c.handle);
      const stale = staleHeldTasks(tx, c.handle, "assignee_retired");
      staleTasks.push(...stale.staleTasks);
      notifications.push(...stale.notifications);
    }
    const next = later.length > 0 ? Math.min(...later) : null;
    if (next !== null) armSessionHandleRetire(tx, next);
    const detail = { retired, sessions_ended: sessions, stale_tasks: staleTasks.sort((a, b) => a - b), next };
    return { value: detail, audit: { targetType: "timer", detail }, notifications };
  },
};

/**
 * `bbs admin session-handle retire <handle>` (human admin, `via` cli or api,
 * never `/mcp`): retire a session handle now, so a token at its cap can free a
 * place without waiting for `sessionHandleRetireMs`. The same retirement as the
 * timer's (sessions ended, doorbell gone, unfinished tasks stale with the
 * coordinator told), whether or not an adapter socket is open: that adapter's
 * next call is refused as retired and it joins again, which brings the handle
 * back if the cap has room.
 */
export const adminSessionHandleRetire: ActionDef = {
  name: "admin_session_handle_retire",
  kind: "change",
  run(tx, input) {
    if (tx.actor.kind !== "human" || !tx.actor.isAdmin) throw denied("only a human admin can retire a session handle");
    const p = asParams(input);
    const handle = resolveHandle(tx.sql, reqHandle(p, "handle"));
    const row = tx.sql.one<{ parent: string | null; status: string; retired_at: number | null }>(
      "SELECT parent, status, retired_at FROM users WHERE handle = ?",
      handle,
    );
    if (!row) throw new BbsError("not_found", `no user named ${handle}`);
    if (row.parent === null) throw new BbsError("conflict", `${handle} is not a session handle`);
    if (row.status === "kicked") throw new BbsError("conflict", `${handle} is kicked, not retired`);
    if (row.retired_at !== null) throw new BbsError("conflict", `${handle} is already retired`);
    // The retirement is a condition of its own write.
    const done = tx.sql.all(
      "UPDATE users SET retired_at = ? WHERE handle = ? AND parent IS NOT NULL AND retired_at IS NULL AND status <> 'kicked' RETURNING handle",
      tx.now,
      handle,
    );
    if (done.length === 0) throw new BbsError("conflict", `${handle} changed while it was being retired; look again`);
    const sessions = tx.sql
      .all<{ id: string }>(
        "UPDATE sessions SET state = 'gone', ws_open = 0, detached_at = COALESCE(detached_at, ?) WHERE handle = ? AND state <> 'gone' RETURNING id",
        tx.now,
        handle,
      )
      .map((r) => r.id);
    tx.sql.exec("DELETE FROM doorbells WHERE handle = ?", handle);
    const stale = staleHeldTasks(tx, handle, "assignee_retired");
    const log = adminLog(tx, `retire: ${handle} (a session handle of ${row.parent}) retired by ${tx.actor.handle}`);
    return {
      value: { handle, parent: row.parent, sessions_ended: sessions.length, stale_tasks: stale.staleTasks },
      audit: {
        targetType: "user",
        targetId: handle,
        detail: { parent: row.parent, sessions_ended: sessions, stale_tasks: stale.staleTasks, log_seq: log.seq },
      },
      notifications: [log.notification, ...stale.notifications],
    };
  },
};

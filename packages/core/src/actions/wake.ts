// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0

/**
 * Wake actions (M2): the adapter socket's life cycle and messages (spec
 * §4.3), and the doorbell debounce timer. The Board DO calls these through
 * `Board.socket*` and `runDueTimers`; each is one `act` call with its own
 * audit row (design §13: socket open and close, attach, doorbell sent, wake
 * result reported by the adapter).
 */

import { armDoorbellTimer, attemptDetail, countRing, tryRing } from "../notify.ts";
import { asParams, optBool, optEnum, optInt, optLabel, reqString } from "../params.ts";
import { BbsError, denied, type ActionDef, type FollowUp, type NotificationWork, type Tx } from "../types.ts";
import { wakeBudgetExceeded } from "./admin.ts";

/** Ring results the adapter reports (spec §4.3). */
export const RING_RESULTS = ["turn_started", "held_busy", "failed"] as const;
export type RingResult = (typeof RING_RESULTS)[number];

const SESSION_STATES = ["idle", "busy"] as const;

function requireAgent(tx: Tx): void {
  if (tx.actor.kind !== "agent") throw denied("only agent users have adapter sockets");
}

/** The calling session (from the socket's `hello`), checked by `act` (owner, not gone). */
function callerSession(tx: Tx): string {
  const s = tx.ctx.session;
  if (s === undefined) throw new BbsError("bad_request", "send hello with your session first");
  return s;
}

/** `busy_since` for a new state: kept while busy, set when busy starts, cleared when idle. */
const BUSY_SINCE_SQL = "CASE WHEN ? = 'busy' THEN COALESCE(CASE WHEN state = 'busy' THEN busy_since END, ?) ELSE NULL END";

function ringWork(
  tx: Tx,
  handle: string,
): { work: NotificationWork[]; detail: Record<string, unknown>; followUps: FollowUp[] } {
  const a = tryRing(tx, handle);
  return {
    work: a.result === "rung" ? [a.ring] : [],
    detail: attemptDetail(a),
    // The first refusal for the wake budget in a window is logged and told (M4b).
    followUps: a.result === "over_budget" && a.firstInWindow ? [{ def: wakeBudgetExceeded, params: { handle } }] : [],
  };
}

/** An adapter socket opened (authenticated with an agent token). */
export const socketOpen: ActionDef = {
  name: "socket_open",
  kind: "change",
  renewsLeases: () => false,
  run(tx) {
    requireAgent(tx);
    return { value: {}, audit: { targetType: "user", targetId: tx.actor.handle } };
  },
};

/**
 * `hello` (spec §4.3): attach the socket to the caller's session from
 * `bbs_join`. Optional `state` (an addition to the spec message, recorded in
 * the pre-publication M2 notes) sets busy/idle at once, so a reconnect during a turn is not
 * rung. A doorbell still pending (not cleared by `bbs_inbox`) rings again
 * when the earlier delivery cannot count for this session (B56): it was sent
 * but never answered with `ring_result`, or it went to another session, or
 * the adapter could not confirm that it started a turn. A confirmed delivery
 * to this same session stays delivered while the session reports busy (a
 * socket blip mid-turn); reported idle, its turn has ended without
 * `bbs_inbox`, so it rings again (B57, as at an idle report). Rings a due
 * doorbell if idle.
 */
export const socketHello: ActionDef = {
  name: "socket_hello",
  kind: "change",
  renewsLeases: () => false,
  run(tx, input) {
    requireAgent(tx);
    const p = asParams(input);
    const session = callerSession(tx);
    const harness = optLabel(p, "harness", 64);
    const machine = optLabel(p, "machine", 64);
    const state = optEnum(p, "state", SESSION_STATES);
    tx.sql.exec(
      `UPDATE sessions SET ws_open = 1, detached_at = NULL,
              machine = COALESCE(?, machine),
              busy_since = ${BUSY_SINCE_SQL.replace("? = 'busy'", "COALESCE(?, state) = 'busy'")},
              state = COALESCE(?, state)
       WHERE id = ?`,
      machine ?? null,
      state ?? null,
      tx.now,
      state ?? null,
      session,
    );
    const reset = tx.sql.all<{ id: string }>(
      `UPDATE doorbells SET sent_at = NULL, acked_at = NULL, confirmed = NULL
       WHERE handle = ? AND sent_at IS NOT NULL
         AND (acked_at IS NULL OR session IS NOT ? OR confirmed = 0 OR ? = 'idle')
       RETURNING id`,
      tx.actor.handle,
      session,
      state ?? null,
    );
    const r = ringWork(tx, tx.actor.handle);
    return {
      value: {},
      audit: {
        targetType: "session",
        targetId: session,
        session,
        detail: {
          harness: harness ?? null,
          machine: machine ?? null,
          state: state ?? null,
          ...(reset.length ? { re_ring: "reattach" } : {}),
          ...r.detail,
        },
      },
      notifications: r.work,
      followUps: r.followUps,
    };
  },
};

/**
 * `state` (spec §4.3): the session is busy or idle; idle rings a held doorbell.
 * Only the adapter's hook listener sends it, so a report from a session whose
 * doorbell was delivered unconfirmed (B56) proves hooks are configured: the
 * ring did not start a turn, so the doorbell goes back to unsent and rings at
 * the next idle (the wake budget still counts it).
 *
 * B57 (decided by Curtis 2026-11-21: "Re-ring at next idle"): an idle report
 * from the session a doorbell was delivered to, confirmed or not reported,
 * means the doorbell's turn ended without `bbs_inbox` (which deletes the
 * doorbell). It goes back to unsent and rings once now; each such ring counts
 * against the wake budget, which caps the repeats. The adapter sends its idle
 * report only after the `ring_result` of a ring in progress, so an idle
 * report never overtakes the acknowledgement of the turn it ends.
 */
export const socketState: ActionDef = {
  name: "session_state",
  kind: "change",
  renewsLeases: (p) => p.state === "busy",
  run(tx, input) {
    requireAgent(tx);
    const p = asParams(input);
    const session = callerSession(tx);
    const state = optEnum(p, "state", SESSION_STATES);
    if (state === undefined) throw new BbsError("bad_request", "state must be idle or busy");
    const before = tx.sql.one<{ state: string }>("SELECT state FROM sessions WHERE id = ?", session);
    tx.sql.exec(`UPDATE sessions SET busy_since = ${BUSY_SINCE_SQL}, state = ? WHERE id = ?`, state, tx.now, state, session);
    const delivered = tx.sql.one<{ confirmed: number | null }>(
      "SELECT confirmed FROM doorbells WHERE handle = ? AND acked_at IS NOT NULL AND session = ?",
      tx.actor.handle,
      session,
    );
    // Unconfirmed (B56): at any report. Confirmed or not reported (B57): at idle.
    const reRing =
      delivered === undefined ? undefined
      : delivered.confirmed === 0 ? "unconfirmed"
      : state === "idle" ? "turn_ended"
      : undefined;
    if (reRing !== undefined) {
      tx.sql.exec(
        "UPDATE doorbells SET sent_at = NULL, acked_at = NULL, confirmed = NULL WHERE handle = ?",
        tx.actor.handle,
      );
    }
    const r = state === "idle" ? ringWork(tx, tx.actor.handle) : { work: [], detail: {}, followUps: [] };
    return {
      value: {},
      audit: {
        targetType: "session",
        targetId: session,
        session,
        detail: {
          before: before?.state ?? null,
          after: state,
          ...(reRing !== undefined ? { re_ring: reRing } : {}),
          ...r.detail,
        },
      },
      notifications: r.work,
      followUps: r.followUps,
    };
  },
};

/**
 * `ring_result` (spec §4.3), audited. `turn_started` marks the doorbell
 * delivered (`acked_at`). `held_busy` and `failed` put it back to unsent, so
 * it rings at the next idle or attach; `held_busy` also marks the session
 * busy. Optional `confirmed` (an addition, recorded): whether the adapter saw
 * the turn start (a busy hook) or only delivered the event. It is stored with
 * `turn_started` (1 or 0; NULL when omitted, which counts as confirmed). An
 * unconfirmed delivery rings again (B56): see `socketState` and
 * `socketHello`. A result for a
 * doorbell already cleared by `bbs_inbox` is recorded and changes nothing.
 * Wake budget (B51): only `turn_started` counts, confirmed or not, so a ring
 * that was never delivered (`failed`, `held_busy`, or no result before a
 * reconnect) and is rung again counts once; an unconfirmed delivery that
 * rings again is a second delivery and counts again.
 */
export const ringResult: ActionDef = {
  name: "ring_result",
  kind: "change",
  renewsLeases: () => false,
  run(tx, input) {
    requireAgent(tx);
    const p = asParams(input);
    const session = callerSession(tx);
    const id = reqString(p, "id", 64);
    const result = optEnum(p, "result", RING_RESULTS);
    if (result === undefined) throw new BbsError("bad_request", "result must be turn_started, held_busy or failed");
    const confirmed = optBool(p, "confirmed");
    const me = tx.actor.handle;
    const bell = tx.sql.one<{ id: string; retries: number }>(
      "SELECT id, retries FROM doorbells WHERE handle = ? AND id = ?",
      me,
      id,
    );
    let retryAt: number | null = null;
    let counted = false;
    if (bell) {
      if (result === "turn_started") {
        // The only result that counts against the wake budget (B51).
        countRing(tx, me);
        counted = true;
        tx.sql.exec(
          "UPDATE doorbells SET acked_at = ?, confirmed = ? WHERE handle = ?",
          tx.now,
          confirmed === undefined ? null : confirmed ? 1 : 0,
          me,
        );
      } else if (result === "failed") {
        // Retry on a timer (review M3): at most `doorbellRetryMs.length`
        // times, then wait for the next idle, attach or new event.
        const n = Number(bell.retries);
        const delay = tx.config.doorbellRetryMs[n];
        tx.sql.exec(
          "UPDATE doorbells SET sent_at = NULL, acked_at = NULL, confirmed = NULL, retries = retries + 1 WHERE handle = ?",
          me,
        );
        if (delay !== undefined) {
          retryAt = tx.now + delay;
          armDoorbellTimer(tx, me, retryAt);
        }
      } else {
        tx.sql.exec(
          `UPDATE doorbells SET sent_at = NULL, acked_at = NULL, confirmed = NULL,
                  held_at = CASE WHEN ? THEN COALESCE(held_at, ?) ELSE held_at END
           WHERE handle = ?`,
          result === "held_busy" ? 1 : 0,
          tx.now,
          me,
        );
      }
    }
    if (result === "held_busy") {
      tx.sql.exec(`UPDATE sessions SET busy_since = ${BUSY_SINCE_SQL}, state = 'busy' WHERE id = ?`, "busy", tx.now, session);
    }
    return {
      value: {},
      audit: {
        targetType: "doorbell",
        targetId: id,
        session,
        detail: {
          result,
          pending: bell !== undefined,
          ...(confirmed !== undefined ? { confirmed } : {}),
          ...(counted ? { counted: true } : {}),
          ...(result === "failed" && bell ? { retry_at: retryAt } : {}),
        },
      },
    };
  },
};

/**
 * An adapter socket closed. The session stays (it is not `gone`); it is no
 * longer rung until a socket says `hello` again. `still_open` is set by the
 * DO when another socket for the same session is open (a reconnect overlap).
 */
export const socketClose: ActionDef = {
  name: "socket_close",
  kind: "change",
  renewsLeases: () => false,
  run(tx, input) {
    requireAgent(tx);
    const p = asParams(input);
    const session = p.session === undefined || p.session === null ? undefined : reqString(p, "session", 128);
    const code = optInt(p, "code", 0, 65535) ?? null;
    const stillOpen = optBool(p, "still_open") ?? false;
    let detached = false;
    if (session !== undefined && !stillOpen) {
      const rows = tx.sql.all<{ id: string }>(
        // The socket is tagged with the token's handle and the DO sends no session in the context, so
        // the actor is the token: the session is its own or a session handle's under it (issue #98),
        // the same ownership `#bindSessionHandle` and `sockets_closed` use.
        `UPDATE sessions SET ws_open = 0, detached_at = ?
         WHERE id = ? AND (handle = ? OR handle IN (SELECT handle FROM users WHERE parent = ?))
         RETURNING id`,
        tx.now,
        session,
        tx.actor.handle,
        tx.actor.handle,
      );
      detached = rows.length > 0;
    }
    return {
      value: {},
      audit: {
        targetType: "session",
        ...(session !== undefined ? { targetId: session, session } : {}),
        detail: { code, detached, still_open: stillOpen },
      },
    };
  },
};

/**
 * System: a ring the DO could not send (no open socket for the session).
 * The doorbell goes back to unsent and rings at the next attach.
 */
export const ringUndeliverable: ActionDef = {
  name: "ring_undeliverable",
  kind: "change",
  run(tx, input) {
    const p = asParams(input);
    const handle = reqString(p, "handle", 64);
    const id = reqString(p, "id", 64);
    const session = reqString(p, "session", 128);
    const rows = tx.sql.all<{ handle: string }>(
      "UPDATE doorbells SET sent_at = NULL WHERE handle = ? AND id = ? AND acked_at IS NULL RETURNING handle",
      handle,
      id,
    );
    // Only the session the ring was for (review m3): another live session of
    // the same user is not touched.
    tx.sql.exec(
      "UPDATE sessions SET ws_open = 0, detached_at = COALESCE(detached_at, ?) WHERE id = ? AND handle = ? AND ws_open = 1",
      tx.now,
      session,
      handle,
    );
    return {
      value: {},
      audit: { targetType: "doorbell", targetId: id, session, detail: { handle, reset: rows.length > 0 } },
    };
  },
};

/** Timer (system): a doorbell's debounce ended; ring it, hold it, or leave it waiting. */
export const doorbellDue: ActionDef = {
  name: "doorbell_due",
  kind: "change",
  run(tx, input) {
    const p = asParams(input);
    const timer = Number(p.timer ?? 0);
    const row = tx.sql.one<{ ref: string }>("SELECT ref FROM timers WHERE id = ?", timer);
    tx.sql.exec("DELETE FROM timers WHERE id = ?", timer);
    if (!row) {
      return { value: {}, audit: { targetType: "timer", targetId: String(timer), detail: { missing: true } } };
    }
    const handle = row.ref;
    const r = ringWork(tx, handle);
    return {
      value: {},
      audit: { targetType: "user", targetId: handle, detail: { timer, ...r.detail } },
      notifications: r.work,
      followUps: r.followUps,
    };
  },
};

/**
 * System (M4b, B48): the Board DO closed a user's adapter sockets because the
 * user was kicked or its credential was revoked, or because a socket message
 * came on a credential that no longer holds. One row per closing, so each
 * socket close is on the record (design §13) without a refused `socket_close`
 * row in the kicked user's name. Sockets are tagged with an agent's token
 * handle, so the sessions detached include those of its session handles
 * (issue #98).
 */
export const socketsClosed: ActionDef = {
  name: "sockets_closed",
  kind: "change",
  run(tx, input) {
    const p = asParams(input);
    const handle = reqString(p, "handle", 64);
    const reason = reqString(p, "reason", 64);
    const closed = optInt(p, "closed", 0, 1_000_000) ?? 0;
    const code = optInt(p, "code", 0, 65535) ?? null;
    // One socket closed on its own message: only its session is detached
    // (orchestrator review m1). Otherwise every socket of the user closed.
    const one = p.one === true;
    const session = p.session === undefined || p.session === null ? undefined : reqString(p, "session", 128);
    // Detach the sessions those sockets held (a kick already ended them); a
    // single socket that never said hello held none.
    const detached = (one && session === undefined) ? [] : tx.sql
      .all<{ id: string }>(
        `UPDATE sessions SET ws_open = 0, detached_at = COALESCE(detached_at, ?)
         WHERE (handle = ? OR handle IN (SELECT handle FROM users WHERE parent = ?))
           AND ws_open = 1 AND (? IS NULL OR id = ?) RETURNING id`,
        tx.now,
        handle,
        handle,
        session ?? null,
        session ?? null,
      )
      .map((r) => r.id);
    return {
      value: {},
      audit: {
        targetType: "user",
        targetId: handle,
        detail: { reason, closed, code, detached, ...(session !== undefined ? { session } : {}) },
      },
    };
  },
};

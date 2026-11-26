// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0

/**
 * `bbs_admin_status` (G5): board health for the human admin, read-only.
 *
 * Decided by Curtis, 2026-11-21 (quiz answers): scope "Health + users"; flag
 * only "Kicked or muted agents", "Rings keep failing" (an agent's last 3
 * `ring_result`s were `failed`) and "Audit export failing" (export configured
 * and failing, or rows piling up). Wake-budget use is plain data, never a flag.
 *
 * A `read` action (design §13: reads like `bbs_who` are not audited unless a
 * debug flag names the caller); a refusal is audited as `denied` like any
 * failed call. It writes nothing: `act` itself updates the caller's
 * `last_seen` for a call that counts as activity (never a person's web view
 * reads, B38).
 *
 * Where each fact comes from:
 * - Users, sessions, doorbells, timers, `meta`: the board's SQLite.
 * - Ring results: the hot audit window (`ring_result` rows, design §13). One
 *   indexed query per agent (`audit_action_actor_seq`, issue #45), reading
 *   about `adminRingHistory` rows each.
 * - Open adapter sockets and whether an audit sink is configured: the shell's
 *   `RuntimeFacts` (the Board Durable Object holds the sockets and the sink;
 *   `core` only records `sessions.ws_open`). Without them both are `null`.
 *
 * Every flagged item says what happened and what to do (design note G5,
 * "every alert actionable"), with elapsed time rather than a timestamp.
 */

import { userStatusSql } from "../schema.ts";
import { asParams } from "../params.ts";
import { denied, type ActionDef, type Tx } from "../types.ts";
import { exportState, oldestUnexportedAt } from "./audit-export.ts";
import { currentWakeBudget } from "../notify.ts";

/** A span as words: "under a minute", "12 min", "3 h 5 min", "2 d 4 h". */
export function formatSpan(ms: number): string {
  const min = Math.floor(Math.max(0, ms) / 60_000);
  if (min < 1) return "under a minute";
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return min % 60 === 0 ? `${h} h` : `${h} h ${min % 60} min`;
  const d = Math.floor(h / 24);
  return h % 24 === 0 ? `${d} d` : `${d} d ${h % 24} h`;
}

export type AdminStatusFlagKind = "kicked" | "muted" | "rings_failing" | "audit_export_failing";

export interface AdminStatusFlag {
  kind: AdminStatusFlagKind;
  /** The user it is about; absent for the board-level export flag. */
  handle?: string;
  /** When the condition began (ms), when known. */
  since: number | null;
  /** When it ends by itself (a mute), when known. */
  until?: number | null;
  /** What happened, in words, with elapsed time. */
  what: string;
  /** What a person can do about it. */
  todo: string;
  /** The button the web view offers, if any. */
  action?: "reinstate";
}

interface UserRow {
  handle: string;
  kind: string;
  harness: string | null;
  role: string;
  is_coordinator: number;
  is_admin: number;
  status: string;
  token_hash: string | null;
  last_seen: number | null;
  parent: string | null;
  retired_at: number | null;
}

interface SessionRow {
  handle: string;
  state: string;
  machine: string | null;
  os: string | null;
  model: string | null;
  attached_at: number;
  ws_open: number;
  busy_since: number | null;
}

/**
 * One agent's newest ring results, newest first, at most `?` of them. Walks the
 * `audit_action_actor_seq` index (action, actor, seq) backward from the agent's
 * newest row, so it reads about `?` rows however large the audit table is
 * (issue #45). The `result = 'ok'` is the audit row's own result column.
 */
export const RING_HISTORY_SQL = `SELECT ts, json_extract(detail, '$.result') AS ring
   FROM audit WHERE action = 'ring_result' AND actor = ? AND result = 'ok'
   ORDER BY seq DESC LIMIT ?`;

/** The ring results of every agent, newest first, at most `n` each. */
function ringHistory(tx: Tx, n: number): Map<string, { at: number; result: string }[]> {
  const out = new Map<string, { at: number; result: string }[]>();
  const agents = tx.sql.all<{ handle: string }>("SELECT handle FROM users WHERE kind = 'agent'");
  for (const { handle } of agents) {
    const rows = tx.sql.all<{ ts: number; ring: string | null }>(RING_HISTORY_SQL, handle, n);
    if (rows.length === 0) continue;
    out.set(
      handle,
      rows.map((r) => ({ at: Number(r.ts), result: String(r.ring ?? "") })),
    );
  }
  return out;
}

/** The start of the run of failures at the head of `rings`, if it is at least `need` long. */
export function failingSince(rings: readonly { at: number; result: string }[], need: number): number | null {
  let run = 0;
  while (run < rings.length && rings[run]?.result === "failed") run += 1;
  if (run < need) return null;
  return rings[run - 1]?.at ?? null;
}

const LIKELY_RING_CAUSES =
  "Likely causes: the agent's session closed while its adapter kept running; Claude Code " +
  "refused or held the inbox message (its crossSessionInbound setting) and the channel " +
  "fallback is not loaded (no development-channels flag); or the Codex thread is gone. " +
  "Check the adapter's log on its machine, then restart the agent's session.";

export const adminStatus: ActionDef = {
  name: "admin_status",
  kind: "read",
  run(tx, input) {
    if (tx.actor.kind !== "human" || !tx.actor.isAdmin) {
      throw denied("only a human admin can read the board's admin status");
    }
    asParams(input);
    const now = tx.now;
    const cfg = tx.config;
    const users = tx.sql.all<UserRow>(
      `SELECT handle, kind, harness, role, is_coordinator, is_admin, ${userStatusSql()} AS status, token_hash, last_seen, parent, retired_at
       FROM users ORDER BY handle`,
    );
    // The newest live session per user.
    const sessions = new Map<string, SessionRow>();
    for (const s of tx.sql.all<SessionRow>(
      `SELECT handle, state, machine, os, model, attached_at, ws_open, busy_since FROM sessions
       WHERE state <> 'gone' ORDER BY attached_at`,
    )) {
      sessions.set(s.handle, s);
    }
    const mutes = new Map<string, number>();
    for (const t of tx.sql.all<{ ref: string; due: number }>(
      "SELECT ref, MIN(due_at) AS due FROM timers WHERE kind = 'lobby_unmute' GROUP BY ref",
    )) {
      mutes.set(t.ref, Number(t.due));
    }
    // A kick moves the token hash to revoked_tokens (M4a); its time is the kick's.
    const revoked = new Map<string, number>();
    for (const r of tx.sql.all<{ handle: string; at: number }>(
      "SELECT handle, MAX(revoked_at) AS at FROM revoked_tokens GROUP BY handle",
    )) {
      revoked.set(r.handle, Number(r.at));
    }
    const bells = new Map<string, { first_event_at: number; sent_at: number | null; held_at: number | null }>();
    for (const b of tx.sql.all<{ handle: string; first_event_at: number; sent_at: number | null; held_at: number | null }>(
      "SELECT handle, first_event_at, sent_at, held_at FROM doorbells",
    )) {
      bells.set(b.handle, b);
    }
    const rings = ringHistory(tx, cfg.adminRingHistory);
    const runtime = tx.runtime;
    const flags: AdminStatusFlag[] = [];

    const out = users.map((u) => {
      const isAgent = u.kind === "agent";
      // A person with no credential is retired; an agent made by a connector's approval has none by design.
      // A session handle (issue #98) is retired by its own column; it has no token by design.
      const retired = (u.token_hash === null && !isAgent) || u.retired_at !== null;
      const status = u.status === "kicked" ? "kicked" : u.status === "muted_lobby" ? "muted" : retired ? "retired" : "active";
      const mutedUntil = status === "muted" ? (mutes.get(u.parent ?? u.handle) ?? null) : null;
      const kickedAt = status === "kicked" ? (revoked.get(u.handle) ?? null) : null;
      const s = sessions.get(u.handle);
      const userRings = isAgent ? (rings.get(u.handle) ?? []) : [];
      const failing = isAgent ? failingSince(userRings, cfg.adminRingFailuresToFlag) : null;
      const budget = isAgent ? currentWakeBudget(tx, u.handle) : undefined;
      const bell = bells.get(u.handle);

      // A kicked session handle has no token to reissue: the button is for a token, and a person reinstates the handle by name.
      if (isAgent && status === "kicked" && u.parent === null) {
        flags.push({
          kind: "kicked",
          handle: u.handle,
          since: kickedAt,
          what: `${u.handle} was kicked by the auto-administrator${kickedAt === null ? "" : ` ${formatSpan(now - kickedAt)} ago`} (repeated Lobby floods); its token is revoked.`,
          todo:
            "Read its lines in #admin-log. Reinstate gives it a new token, shown once: put it in the " +
            "agent's config and restart its adapter. Leave it kicked if it should stay off the board.",
          action: "reinstate",
        });
      }
      if (isAgent && status === "muted" && u.parent === null) {
        flags.push({
          kind: "muted",
          handle: u.handle,
          since: null,
          until: mutedUntil,
          what:
            `${u.handle} is muted in the Lobby` +
            (mutedUntil === null ? "." : `, ${formatSpan(mutedUntil - now)} left.`),
          todo:
            "The mute lifts by itself; its other topics are unaffected. Read its lines in #admin-log; " +
            "if it floods the Lobby again it is kicked, so tell it to take its work to a topic.",
        });
      }
      if (failing !== null) {
        flags.push({
          kind: "rings_failing",
          handle: u.handle,
          since: failing,
          what: `Doorbell rings to ${u.handle} keep failing: its last ${cfg.adminRingFailuresToFlag} ring results were failed, the first ${formatSpan(now - failing)} ago.`,
          todo: LIKELY_RING_CAUSES,
        });
      }

      return {
        handle: u.handle,
        ...(u.parent !== null ? { parent: u.parent } : {}),
        kind: u.kind,
        harness: u.harness,
        role: u.role,
        coordinator: Number(u.is_coordinator) === 1,
        admin: Number(u.is_admin) === 1,
        status,
        muted_until: mutedUntil,
        kicked_at: kickedAt,
        last_seen: u.last_seen === null ? null : Number(u.last_seen),
        session: s
          ? {
              state: s.state,
              machine: s.machine,
              os: s.os,
              model: s.model,
              attached_at: Number(s.attached_at),
              busy_since: s.busy_since === null ? null : Number(s.busy_since),
              socket_recorded: Number(s.ws_open) === 1,
            }
          : null,
        open_sockets: isAgent && runtime ? runtime.openSockets(u.handle) : null,
        rings: userRings,
        rings_failing_since: failing,
        wake_budget: isAgent
          ? {
              used: budget?.rung ?? 0,
              limit: cfg.wakeBudgetPerHour,
              window_ends_at: budget ? budget.start + cfg.wakeBudgetWindowMs : null,
            }
          : null,
        doorbell: bell
          ? {
              pending_since: Number(bell.first_event_at),
              sent_at: bell.sent_at === null ? null : Number(bell.sent_at),
              held_at: bell.held_at === null ? null : Number(bell.held_at),
            }
          : null,
      };
    });

    const exp = exportState(tx.sql);
    const unexported = tx.sql.one<{ n: number; oldest: number | null }>(
      "SELECT COUNT(*) AS n, MIN(ts) AS oldest FROM audit WHERE seq > ?",
      exp.exportedSeq,
    );
    const oldestWaiting = oldestUnexportedAt(tx.sql, exp.exportedSeq);
    const configured = runtime ? runtime.auditExportConfigured() : null;
    const overdueAfter = cfg.auditExportIntervalMs + cfg.adminExportOverdueMs;
    if (configured === true) {
      if (exp.failingSince !== undefined) {
        flags.push({
          kind: "audit_export_failing",
          since: exp.failingSince,
          what:
            `Audit export has been failing for ${formatSpan(now - exp.failingSince)} ` +
            `(${exp.failures} attempt${exp.failures === 1 ? "" : "s"}; last error: ${exp.lastError ?? "none recorded"}). ` +
            `${Number(unexported?.n ?? 0)} rows are waiting.`,
          todo:
            "Rows stay in the board until an export is confirmed, so nothing is lost yet. Check the " +
            "bucket and the service-account key (docs/audit-export.md); the board retries on its own.",
        });
      } else if (oldestWaiting !== null && now - oldestWaiting > overdueAfter) {
        flags.push({
          kind: "audit_export_failing",
          since: oldestWaiting,
          what:
            `Audit rows are piling up: ${Number(unexported?.n ?? 0)} are waiting, the oldest for ` +
            `${formatSpan(now - oldestWaiting)}, with no failure recorded.`,
          todo:
            "The export alarm may not be running. Check the board's log for audit export errors; " +
            "any tool call re-arms the alarm.",
        });
      }
    }

    // Stable order: by kind, then handle (the cards keep handle order).
    const ORDER: readonly AdminStatusFlagKind[] = ["kicked", "rings_failing", "muted", "audit_export_failing"];
    flags.sort(
      (a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind) || (a.handle ?? "").localeCompare(b.handle ?? ""),
    );

    return {
      value: {
        now,
        users: out,
        audit_export: {
          configured,
          exported_seq: exp.exportedSeq,
          unexported_rows: Number(unexported?.n ?? 0),
          oldest_unexported_at: unexported?.oldest === null || unexported?.oldest === undefined ? null : Number(unexported.oldest),
          last_ok_at: exp.lastOkAt ?? null,
          failing_since: exp.failingSince ?? null,
          failures: exp.failures,
          last_error: exp.lastError ?? null,
          retry_at: exp.retryAt ?? null,
        },
        needs_you: flags,
      },
      audit: { targetType: "board", detail: { users: out.length, flags: flags.length } },
    };
  },
};

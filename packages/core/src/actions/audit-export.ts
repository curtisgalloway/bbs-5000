// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0

/**
 * The audited steps of audit export (design §13, plan M6a), run by `Board`
 * as the `system` actor, each with its own audit row:
 *
 * - `audit_export_begin`: fix the next batch's seq range (`meta`
 *   `audit_export_pending`). A retry writes the same range again, so the
 *   object name and content are the same on every attempt (see the 412 rule
 *   in `gcs-sink.ts`).
 * - `audit_export`: the sink confirmed the batch. Mark its rows exported,
 *   clear the pending range and any failure state, then prune.
 * - `audit_export_failed`: the write failed. Rows stay; retry after
 *   `auditExportIntervalMs`. After `auditExportFailureNoticeMs` of continuous
 *   failure, one line in `#admin-log` and a notice to each human admin, once
 *   per failure spell.
 * - `audit_prune`: delete exported rows older than `auditHotMs` (also run at
 *   the end of `audit_export`), moving `audit_tail_seq` / `audit_tail_hash`
 *   forward so `verifyAudit` still checks the hot rows.
 *
 * These four are "bookkeeping" rows: on their own they never make an export
 * due (they go out with the next batch of other rows), so an idle board does
 * not export its own export records forever.
 */

import { chainValueAfter, GENESIS_HASH, type AuditRow } from "../audit.ts";
import { asParams } from "../params.ts";
import {
  BbsError,
  type ActionDef,
  type AdminNotification,
  type BoardConfig,
  type NotificationWork,
  type Tx,
} from "../types.ts";
import type { Sql } from "../sql.ts";
import { adminLog } from "./admin.ts";
import { humanAdmins } from "./users.ts";

export const EXPORT_BOOKKEEPING_ACTIONS = [
  "audit_export_begin",
  "audit_export",
  "audit_export_failed",
  "audit_prune",
] as const;

/** Most rows one prune deletes; the rest go at the next alarm. */
export const MAX_PRUNE_ROWS = 5_000;

const AUDIT_COLUMNS = `seq, ts, actor, actor_kind, via, session, action, target_type, target_id,
  topic, result, detail, request_id, prev_hash`;

export function getMeta(sql: Sql, key: string): string | undefined {
  return sql.one<{ value: string }>("SELECT value FROM meta WHERE key = ?", key)?.value;
}

function setMeta(sql: Sql, key: string, value: string | number): void {
  sql.exec(
    `INSERT INTO meta (key, value) VALUES (?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
    key,
    String(value),
  );
}

function deleteMeta(sql: Sql, ...keys: string[]): void {
  for (const key of keys) sql.exec("DELETE FROM meta WHERE key = ?", key);
}

/** The export state kept in `meta` (read-only view). */
export interface ExportState {
  /** Every row through this seq is exported (0: none yet). */
  exportedSeq: number;
  pending: { first: number; last: number } | undefined;
  failingSince: number | undefined;
  failures: number;
  retryAt: number | undefined;
  lastError: string | undefined;
  noticeAt: number | undefined;
  /** When the sink last confirmed a batch (G5; unset before the first one). */
  lastOkAt: number | undefined;
}

export function exportState(sql: Sql): ExportState {
  const num = (k: string): number | undefined => {
    const v = getMeta(sql, k);
    return v === undefined ? undefined : Number(v);
  };
  const pendingText = getMeta(sql, "audit_export_pending");
  let pending: ExportState["pending"];
  if (pendingText !== undefined) {
    const p = JSON.parse(pendingText) as { first: number; last: number };
    pending = { first: Number(p.first), last: Number(p.last) };
  }
  return {
    exportedSeq: num("audit_exported_seq") ?? 0,
    pending,
    failingSince: num("audit_export_failing_since"),
    failures: num("audit_export_failures") ?? 0,
    retryAt: num("audit_export_retry_at"),
    lastError: getMeta(sql, "audit_export_last_error"),
    noticeAt: num("audit_export_notice_at"),
    lastOkAt: num("audit_export_last_ok_at"),
  };
}

/**
 * The recorded chain state (review m3): what a verifier checks the archive
 * and the hot rows against. Returned by `bbs_audit` as `chain` so a person
 * can verify without database access.
 */
export interface ChainState {
  board_id: string;
  tail_seq: number;
  tail_hash: string;
  head: string;
  exported_seq: number;
}

export function chainState(sql: Sql): ChainState {
  return {
    board_id: getMeta(sql, "board_id") ?? "",
    tail_seq: Number(getMeta(sql, "audit_tail_seq") ?? 1),
    tail_hash: getMeta(sql, "audit_tail_hash") ?? GENESIS_HASH,
    head: getMeta(sql, "audit_head") ?? GENESIS_HASH,
    exported_seq: Number(getMeta(sql, "audit_exported_seq") ?? 0),
  };
}

export function readAuditRows(sql: Sql, first: number, last: number): AuditRow[] {
  return sql
    .all<AuditRow>(`SELECT ${AUDIT_COLUMNS} FROM audit WHERE seq BETWEEN ? AND ? ORDER BY seq`, first, last)
    .map(normalizeRow);
}

export function normalizeRow(r: AuditRow): AuditRow {
  return {
    seq: Number(r.seq),
    ts: Number(r.ts),
    actor: r.actor,
    actor_kind: r.actor_kind,
    via: r.via,
    session: r.session ?? null,
    action: r.action,
    target_type: r.target_type ?? null,
    target_id: r.target_id ?? null,
    topic: r.topic ?? null,
    result: r.result,
    detail: r.detail,
    request_id: r.request_id ?? null,
    prev_hash: r.prev_hash,
  };
}

function maxSeq(sql: Sql): number {
  const r = sql.one<{ m: number | null }>("SELECT MAX(seq) AS m FROM audit");
  return r?.m === null || r?.m === undefined ? 0 : Number(r.m);
}

const BOOKKEEPING_SQL = EXPORT_BOOKKEEPING_ACTIONS.map(() => "?").join(", ");

/**
 * When the next export is due (ms since the epoch), or null when nothing
 * needs exporting: a pending batch at its retry time (now, after a crash);
 * otherwise `auditExportBatchRows` unexported rows now, or the oldest
 * unexported row that is not bookkeeping plus `auditExportIntervalMs`.
 */
export function exportDue(sql: Sql, config: BoardConfig, now: number): number | null {
  const s = exportState(sql);
  if (s.pending) return s.retryAt ?? now;
  const unexported = maxSeq(sql) - s.exportedSeq;
  if (unexported <= 0) return null;
  if (unexported >= config.auditExportBatchRows) return now;
  const oldest = oldestUnexportedAt(sql, s.exportedSeq);
  return oldest === null ? null : oldest + config.auditExportIntervalMs;
}

/**
 * When the oldest unexported row that is not export bookkeeping was written,
 * or null when none waits: what `exportDue` counts from (G5 admin status).
 */
export function oldestUnexportedAt(sql: Sql, exportedSeq: number): number | null {
  const oldest = sql.one<{ ts: number }>(
    `SELECT ts FROM audit WHERE seq > ? AND action NOT IN (${BOOKKEEPING_SQL}) ORDER BY seq LIMIT 1`,
    exportedSeq,
    ...EXPORT_BOOKKEEPING_ACTIONS,
  );
  return oldest ? Number(oldest.ts) : null;
}

/** When the oldest hot row may be pruned, or null (not exported yet, or none). */
export function pruneDue(sql: Sql, config: BoardConfig): number | null {
  const s = exportState(sql);
  const oldest = sql.one<{ seq: number; ts: number }>("SELECT seq, ts FROM audit ORDER BY seq LIMIT 1");
  if (!oldest || Number(oldest.seq) > s.exportedSeq) return null;
  return Number(oldest.ts) + config.auditHotMs;
}

/** `audit_export_begin`: fix the next batch's range. */
export const auditExportBegin: ActionDef = {
  name: "audit_export_begin",
  kind: "change",
  run(tx) {
    const s = exportState(tx.sql);
    if (s.pending) throw new BbsError("conflict", "an export batch is already pending");
    const top = maxSeq(tx.sql);
    if (top <= s.exportedSeq) throw new BbsError("conflict", "nothing to export");
    const first = s.exportedSeq + 1;
    const last = Math.min(top, s.exportedSeq + tx.config.auditExportBatchRows);
    setMeta(tx.sql, "audit_export_pending", JSON.stringify({ first, last }));
    return {
      value: { first, last },
      audit: { targetType: "audit_batch", targetId: `${first}-${last}`, detail: { first, last } },
    };
  },
};

function checkPending(tx: Tx, p: Record<string, unknown>): { first: number; last: number } {
  const s = exportState(tx.sql);
  const first = Number(p.first);
  const last = Number(p.last);
  if (!s.pending || s.pending.first !== first || s.pending.last !== last) {
    throw new BbsError("conflict", `batch ${first}-${last} is not the pending export batch`);
  }
  return { first, last };
}

/** `audit_export`: the sink confirmed the pending batch. */
export const auditExportConfirm: ActionDef = {
  name: "audit_export",
  kind: "change",
  run(tx, input) {
    const p = asParams(input);
    const { first, last } = checkPending(tx, p);
    const s = exportState(tx.sql);
    tx.sql.exec("UPDATE audit SET exported = 1 WHERE seq BETWEEN ? AND ?", first, last);
    setMeta(tx.sql, "audit_exported_seq", last);
    // When the last batch was confirmed, for `bbs_admin_status` (G5).
    setMeta(tx.sql, "audit_export_last_ok_at", tx.now);
    deleteMeta(
      tx.sql,
      "audit_export_pending",
      "audit_export_failing_since",
      "audit_export_failures",
      "audit_export_retry_at",
      "audit_export_last_error",
      "audit_export_notice_at",
    );
    const notifications: NotificationWork[] = [];
    if (s.noticeAt !== undefined) {
      // Human admins were told it was failing; say it recovered.
      const log = adminLog(tx, `audit export recovered after ${s.failures} failed attempts`);
      notifications.push(log.notification);
    }
    const pruned = prune(tx);
    return {
      value: { first, last, pruned },
      audit: {
        targetType: "audit_batch",
        targetId: `${first}-${last}`,
        detail: {
          first,
          last,
          path: String(p.path),
          chain: String(p.chain),
          already_existed: p.outcome === "exists",
          ...(s.failures > 0 ? { after_failures: s.failures } : {}),
          ...(pruned.rows > 0 ? { pruned } : {}),
        },
      },
      notifications,
    };
  },
};

/** `audit_export_failed`: the write of the pending batch failed. */
export const auditExportFailed: ActionDef = {
  name: "audit_export_failed",
  kind: "change",
  run(tx, input) {
    const p = asParams(input);
    const { first, last } = checkPending(tx, p);
    const s = exportState(tx.sql);
    const since = s.failingSince ?? tx.now;
    const failures = s.failures + 1;
    const error = String(p.error ?? "").slice(0, 300);
    const retryAt = tx.now + tx.config.auditExportIntervalMs;
    setMeta(tx.sql, "audit_export_failing_since", since);
    setMeta(tx.sql, "audit_export_failures", failures);
    setMeta(tx.sql, "audit_export_retry_at", retryAt);
    setMeta(tx.sql, "audit_export_last_error", error);
    const notifications: NotificationWork[] = [];
    let noticed = false;
    if (s.noticeAt === undefined && tx.now - since >= tx.config.auditExportFailureNoticeMs) {
      // Once per failure spell (cleared when an export succeeds).
      setMeta(tx.sql, "audit_export_notice_at", tx.now);
      noticed = true;
      const log = adminLog(
        tx,
        `audit export failing since ${new Date(since).toISOString()} (${failures} attempts); ` +
          `rows are kept and retried. Last error: ${error}`,
      );
      notifications.push(log.notification, ...adminNotices(tx, log.seq));
    }
    return {
      value: { first, last, failures, retry_at: retryAt, noticed },
      audit: {
        targetType: "audit_batch",
        targetId: `${first}-${last}`,
        detail: { first, last, error, failures, failing_since: since, retry_at: retryAt, ...(noticed ? { noticed } : {}) },
      },
      notifications,
    };
  },
};

/** One `audit_export_failing` notice per human admin. */
function adminNotices(tx: Tx, logSeq: number): AdminNotification[] {
  return humanAdmins(tx.sql).map((handle) => ({
    type: "admin" as const,
    reason: "audit_export_failing" as const,
    recipient: handle,
    as: "admin" as const,
    subjects: [],
    logSeq,
    alwaysWake: false as const,
    actor: "system" as const,
  }));
}

/** `audit_prune`: delete exported rows past the hot period. */
export const auditPrune: ActionDef = {
  name: "audit_prune",
  kind: "change",
  run(tx) {
    const pruned = prune(tx);
    if (pruned.rows === 0) throw new BbsError("conflict", "nothing to prune");
    return { value: pruned, audit: { targetType: "audit", detail: { pruned } } };
  },
};

/**
 * Delete the oldest audit rows that are exported and older than the hot
 * period, oldest first and contiguous, at most MAX_PRUNE_ROWS. Moves the
 * recorded tail to the first row kept: `audit_tail_seq` is its seq and
 * `audit_tail_hash` the chain value after the last row deleted.
 */
function prune(tx: Tx): { rows: number; through?: number } {
  const s = exportState(tx.sql);
  const cutoff = tx.now - tx.config.auditHotMs;
  const candidates = tx.sql
    .all<AuditRow>(
      `SELECT ${AUDIT_COLUMNS} FROM audit WHERE seq <= ? ORDER BY seq LIMIT ?`,
      s.exportedSeq,
      MAX_PRUNE_ROWS,
    )
    .map(normalizeRow);
  let lastDeleted: AuditRow | undefined;
  for (const row of candidates) {
    // Stop at the first row still hot: deletion stays a contiguous prefix,
    // even if the clock went backwards between rows.
    if (row.ts > cutoff) break;
    lastDeleted = row;
  }
  if (!lastDeleted) return { rows: 0 };
  const first = candidates[0]?.seq ?? lastDeleted.seq;
  tx.sql.exec("DELETE FROM audit WHERE seq BETWEEN ? AND ?", first, lastDeleted.seq);
  setMeta(tx.sql, "audit_tail_seq", lastDeleted.seq + 1);
  setMeta(tx.sql, "audit_tail_hash", chainValueAfter(lastDeleted, tx.sha256));
  return { rows: lastDeleted.seq - first + 1, through: lastDeleted.seq };
}


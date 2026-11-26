// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0

/**
 * The audit hash chain (design §13 "Tamper evidence", plan decision P3).
 *
 * Each row's `prev_hash` is the chain value before it was written. The chain
 * value after a row is `sha256(canonicalJson(row))`, where the row includes
 * its own `prev_hash` and excludes `exported` (bookkeeping that changes after
 * the row is written). The value before the first row is `GENESIS_HASH`.
 */

export type Sha256 = (data: string) => string;

export const GENESIS_HASH = "0".repeat(64);

export type AuditResult = "ok" | "denied" | "error";

export interface AuditRow {
  seq: number;
  ts: number;
  actor: string;
  actor_kind: string;
  via: string;
  session: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  topic: string | null;
  result: AuditResult;
  detail: string;
  request_id: string | null;
  prev_hash: string;
}

/** The fields covered by the hash, in a fixed order. */
export const AUDIT_FIELDS: readonly (keyof AuditRow)[] = [
  "seq",
  "ts",
  "actor",
  "actor_kind",
  "via",
  "session",
  "action",
  "target_type",
  "target_id",
  "topic",
  "result",
  "detail",
  "request_id",
  "prev_hash",
];

/**
 * Canonical JSON of an audit row: the hashed fields in a fixed order, with
 * numbers as integers and absent values as null. Stable across runtimes
 * because it is built from a fixed key list, not from object key order.
 */
export function canonicalAuditJson(row: AuditRow): string {
  const parts = AUDIT_FIELDS.map((key) => {
    const value = row[key] ?? null;
    if (typeof value === "number" && !Number.isSafeInteger(value)) {
      throw new Error(`audit field ${key} is not a safe integer`);
    }
    return `${JSON.stringify(key)}:${JSON.stringify(value)}`;
  });
  return `{${parts.join(",")}}`;
}

export function chainValueAfter(row: AuditRow, sha256: Sha256): string {
  return sha256(canonicalAuditJson(row));
}

export type ChainCheck =
  | { ok: true; head: string; rows: number }
  | { ok: false; seq: number; reason: string };

/**
 * Verify a run of consecutive audit rows, ordered by `seq`, starting from the
 * chain value `start` (GENESIS_HASH for the first row ever). Detects an
 * edited row (the next row's `prev_hash` no longer matches), a removed row
 * (a gap in `seq` or a mismatch), and a reordered row.
 */
export function verifyChain(
  rows: readonly AuditRow[],
  sha256: Sha256,
  start: string = GENESIS_HASH,
  expectedHead?: string,
): ChainCheck {
  let head = start;
  let prevSeq: number | undefined;
  for (const row of rows) {
    if (prevSeq !== undefined && row.seq !== prevSeq + 1) {
      return { ok: false, seq: row.seq, reason: `gap after seq ${prevSeq}` };
    }
    if (row.prev_hash !== head) {
      return { ok: false, seq: row.seq, reason: "prev_hash does not match" };
    }
    head = chainValueAfter(row, sha256);
    prevSeq = row.seq;
  }
  if (expectedHead !== undefined && head !== expectedHead) {
    const last = rows.at(-1);
    return {
      ok: false,
      seq: last?.seq ?? 0,
      reason: "chain head does not match the recorded head",
    };
  }
  return { ok: true, head, rows: rows.length };
}

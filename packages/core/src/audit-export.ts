// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0

/**
 * Audit export (design §13 "Where it goes", plan M6a): the `AuditSink`
 * interface, the batch file format, the verifier over hot rows plus archived
 * batches, and the async export loop the Board DO runs from its alarm.
 *
 * A batch is a contiguous seq range of audit rows written as one NDJSON
 * object at `audit/dt=YYYY-MM-DD/<board_id>-<first_seq>-<last_seq>.ndjson`,
 * where `dt` is the UTC date of the batch's first row and `board_id` the
 * board's random id (`meta.board_id`; decided by Curtis 2026-11-20, so two
 * boards, or one board after a storage reset, never share an object name).
 * Each line is the row's canonical JSON (the hashed fields,
 * `canonicalAuditJson`) with two more fields at the end: `board_id`, and
 * `chain`, the chain value after that row. So the last line of a batch
 * carries the chain value at the batch's end, and every line has the same
 * shape (one BigQuery schema).
 *
 * Plain TypeScript: no Cloudflare or Node imports.
 */

import {
  AUDIT_FIELDS,
  canonicalAuditJson,
  chainValueAfter,
  GENESIS_HASH,
  verifyChain,
  type AuditRow,
  type Sha256,
} from "./audit.ts";
import type { ActResult } from "./types.ts";

/**
 * Where audit batches go. Create-only: `create` writes a new object and never
 * replaces one. It resolves once the store has confirmed the write
 * (`"created"`), or with `"exists"` when an object of that name is already
 * there (left untouched); it rejects on any other failure.
 */
export interface AuditSink {
  create(path: string, body: string): Promise<"created" | "exists">;
}

/** One batch ready to write. */
export interface AuditBatch {
  first: number;
  last: number;
  path: string;
  body: string;
  /** The chain value after the last row (also on the last line). */
  chain: string;
}

export const AUDIT_PREFIX = "audit/";

/** A board id: 16 lowercase hex characters (`meta.board_id`). */
export const BOARD_ID_RE = /^[0-9a-f]{16}$/;

/** `audit/dt=YYYY-MM-DD/<board_id>-<first>-<last>.ndjson`, dt from `firstTs` in UTC. */
export function batchPath(boardId: string, first: number, last: number, firstTs: number): string {
  if (!BOARD_ID_RE.test(boardId)) throw new Error("board id is not 16 hex characters");
  const dt = new Date(firstTs).toISOString().slice(0, 10);
  return `${AUDIT_PREFIX}dt=${dt}/${boardId}-${first}-${last}.ndjson`;
}

/** One NDJSON line: the canonical row JSON plus `"board_id"` and `"chain"` at the end. */
export function batchLine(row: AuditRow, boardId: string, chain: string): string {
  return `${canonicalAuditJson(row).slice(0, -1)},"board_id":${JSON.stringify(boardId)},"chain":${JSON.stringify(chain)}}`;
}

/**
 * Build the batch for consecutive rows. `start` is the chain value before
 * the first row (its `prev_hash`, when the chain is intact). Throws on an
 * empty or non-contiguous run.
 */
export function buildBatch(rows: readonly AuditRow[], sha256: Sha256, boardId: string): AuditBatch {
  const first = rows[0];
  const lastRow = rows.at(-1);
  if (!first || !lastRow) throw new Error("empty audit batch");
  const lines: string[] = [];
  let chain = "";
  rows.forEach((row, i) => {
    if (row.seq !== first.seq + i) throw new Error(`audit batch not contiguous at seq ${row.seq}`);
    chain = chainValueAfter(row, sha256);
    lines.push(batchLine(row, boardId, chain));
  });
  return {
    first: first.seq,
    last: lastRow.seq,
    path: batchPath(boardId, first.seq, lastRow.seq, first.ts),
    body: `${lines.join("\n")}\n`,
    chain,
  };
}

/** A parsed batch: its rows and the chain value each line claims. */
export interface ParsedBatch {
  path: string;
  boardId: string;
  first: number;
  last: number;
  rows: AuditRow[];
  chains: string[];
}

const PATH_RE = /^audit\/dt=(\d{4}-\d{2}-\d{2})\/([0-9a-f]{16})-(\d+)-(\d+)\.ndjson$/;

/** The board id in a batch name, or undefined when the name is not a batch name. */
export function batchBoardId(path: string): string | undefined {
  return PATH_RE.exec(path)?.[2];
}
const HEX64 = /^[0-9a-f]{64}$/;

/** Parse one batch object; throws an Error naming what is wrong. */
export function parseBatch(path: string, body: string): ParsedBatch {
  const m = PATH_RE.exec(path);
  if (!m) throw new Error("name does not match audit/dt=YYYY-MM-DD/<board_id>-<first>-<last>.ndjson");
  const boardId = m[2]!;
  const first = Number(m[3]);
  const last = Number(m[4]);
  if (!body.endsWith("\n")) throw new Error("does not end with a newline");
  const lines = body.slice(0, -1).split("\n");
  const rows: AuditRow[] = [];
  const chains: string[] = [];
  lines.forEach((line, i) => {
    let v: unknown;
    try {
      v = JSON.parse(line);
    } catch {
      throw new Error(`line ${i + 1} is not JSON`);
    }
    if (typeof v !== "object" || v === null || Array.isArray(v)) {
      throw new Error(`line ${i + 1} is not an object`);
    }
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o);
    const want = [...AUDIT_FIELDS, "board_id", "chain"];
    if (keys.length !== want.length || !want.every((k) => Object.hasOwn(o, k))) {
      throw new Error(`line ${i + 1} does not have the audit fields`);
    }
    if (typeof o.chain !== "string" || !HEX64.test(o.chain)) {
      throw new Error(`line ${i + 1} has no chain value`);
    }
    if (o.board_id !== boardId) throw new Error(`line ${i + 1}: board_id does not match the name`);
    rows.push(toRow(o, i + 1));
    chains.push(o.chain);
  });
  if (rows[0]?.seq !== first || rows.at(-1)?.seq !== last) {
    throw new Error("first and last seq do not match the name");
  }
  if (path !== batchPath(boardId, first, last, rows[0].ts)) {
    throw new Error("dt does not match the first row's date");
  }
  return { path, boardId, first, last, rows, chains };
}

function toRow(o: Record<string, unknown>, line: number): AuditRow {
  const str = (k: string): string => {
    if (typeof o[k] !== "string") throw new Error(`line ${line}: ${k} is not a string`);
    return o[k] as string;
  };
  const optStr = (k: string): string | null => (o[k] === null ? null : str(k));
  const int = (k: string): number => {
    if (typeof o[k] !== "number" || !Number.isSafeInteger(o[k])) {
      throw new Error(`line ${line}: ${k} is not an integer`);
    }
    return o[k] as number;
  };
  const result = str("result");
  if (result !== "ok" && result !== "denied" && result !== "error") {
    throw new Error(`line ${line}: bad result`);
  }
  return {
    seq: int("seq"),
    ts: int("ts"),
    actor: str("actor"),
    actor_kind: str("actor_kind"),
    via: str("via"),
    session: optStr("session"),
    action: str("action"),
    target_type: optStr("target_type"),
    target_id: optStr("target_id"),
    topic: optStr("topic"),
    result,
    detail: str("detail"),
    request_id: optStr("request_id"),
    prev_hash: str("prev_hash"),
  };
}

export type ArchiveCheck =
  | {
      ok: true;
      head: string;
      batches: number;
      archivedRows: number;
      hotRows: number;
      /** Batches of other boards (another board id in the name), skipped. */
      otherBoards: number;
    }
  | { ok: false; seq: number; reason: string; path?: string };

/**
 * Verify the whole audit chain: archived batches from seq 1, then the hot
 * rows still in SQLite. Detects an edited row (in a batch or hot), a line
 * whose chain value is wrong, a missing or overlapping batch, a hot row that
 * differs from its archived copy, a hot window that does not start where the
 * archive and the recorded tail say, and a head that does not match.
 *
 * `tail` is the board's `audit_tail_seq` / `audit_tail_hash` (where the hot
 * rows start), `head` its `audit_head`, `exportedSeq` its
 * `audit_exported_seq`: the archive must cover every row through it (review
 * m1), so a missing batch of exported rows that are still hot is caught.
 * Batches named with another board id are skipped (a shared bucket); a
 * batch whose lines name another board than its name is rejected.
 */
export function verifyAuditArchive(input: {
  boardId: string;
  exportedSeq: number;
  batches: readonly { path: string; body: string }[];
  hot: readonly AuditRow[];
  tail: { seq: number; hash: string };
  head: string;
  sha256: Sha256;
}): ArchiveCheck {
  const parsed: ParsedBatch[] = [];
  let otherBoards = 0;
  for (const b of input.batches) {
    const owner = batchBoardId(b.path);
    if (owner !== undefined && owner !== input.boardId) {
      otherBoards += 1;
      continue;
    }
    try {
      parsed.push(parseBatch(b.path, b.body));
    } catch (err) {
      return { ok: false, seq: 0, path: b.path, reason: (err as Error).message };
    }
  }
  parsed.sort((a, b) => a.first - b.first);
  // Chain value after each archived seq, and each archived row's canonical JSON.
  const chainAfter = new Map<number, string>();
  const archived = new Map<number, string>();
  let prevLast = 0;
  let prevChain = GENESIS_HASH;
  let archivedRows = 0;
  for (const b of parsed) {
    if (b.first <= prevLast) {
      return { ok: false, seq: b.first, path: b.path, reason: `batch overlaps an earlier batch (through seq ${prevLast})` };
    }
    if (b.first !== prevLast + 1) {
      return { ok: false, seq: prevLast + 1, path: b.path, reason: `missing batch: seq ${prevLast + 1}-${b.first - 1}` };
    }
    const c = verifyChain(b.rows, input.sha256, prevChain);
    if (!c.ok) return { ok: false, seq: c.seq, path: b.path, reason: c.reason };
    let chain = prevChain;
    for (const [i, row] of b.rows.entries()) {
      chain = chainValueAfter(row, input.sha256);
      if (b.chains[i] !== chain) {
        return { ok: false, seq: row.seq, path: b.path, reason: "line's chain value does not match" };
      }
      chainAfter.set(row.seq, chain);
      archived.set(row.seq, canonicalAuditJson(row));
    }
    prevLast = b.last;
    prevChain = chain;
    archivedRows += b.rows.length;
  }

  if (prevLast < input.exportedSeq) {
    return { ok: false, seq: prevLast + 1, reason: `missing batch: rows through seq ${input.exportedSeq} are exported, the archive ends at ${prevLast}` };
  }
  // The hot window starts at the recorded tail, and the tail must continue
  // the archive.
  const { tail } = input;
  const before = tail.seq === 1 ? GENESIS_HASH : chainAfter.get(tail.seq - 1);
  if (before === undefined) {
    return { ok: false, seq: tail.seq - 1, reason: `missing batch: archive ends at seq ${prevLast}, hot rows start at ${tail.seq}` };
  }
  if (before !== tail.hash) {
    return { ok: false, seq: tail.seq, reason: "recorded tail does not match the archive's chain value" };
  }
  const firstHot = input.hot[0];
  if (firstHot && firstHot.seq !== tail.seq) {
    return { ok: false, seq: firstHot.seq, reason: `oldest hot row is seq ${firstHot.seq}; expected seq ${tail.seq}` };
  }
  for (const row of input.hot) {
    const copy = archived.get(row.seq);
    if (copy !== undefined && copy !== canonicalAuditJson(row)) {
      return { ok: false, seq: row.seq, reason: "hot row differs from its archived copy" };
    }
  }
  const lastHot = input.hot.at(-1)?.seq ?? tail.seq - 1;
  if (prevLast > lastHot) {
    return { ok: false, seq: prevLast, reason: `archive runs past the newest hot row (seq ${lastHot})` };
  }
  const c = verifyChain(input.hot, input.sha256, tail.hash, input.head);
  if (!c.ok) return c;
  return { ok: true, head: c.head, batches: parsed.length, archivedRows, hotRows: input.hot.length, otherBoards };
}

/** The Board methods the export loop needs (see `Board` in act.ts). */
export interface AuditExporter {
  beginAuditExport(): AuditBatch | null;
  confirmAuditExport(batch: AuditBatch, outcome: "created" | "exists"): ActResult;
  failAuditExport(batch: AuditBatch, error: string): ActResult;
  pruneAudit(): ActResult | null;
}

export interface ExportRun {
  /** Batches the sink confirmed (created or already there). */
  exported: { first: number; last: number; path: string; outcome: "created" | "exists" }[];
  /** The failure that ended the run, if one did. */
  failed?: { first: number; last: number; error: string };
  /** Results of the audited steps, with their notification work. */
  results: ActResult[];
}

/** Most batches one run writes; the rest wait for the next alarm. */
export const MAX_BATCHES_PER_RUN = 10;

/**
 * Write every due batch through `sink`, oldest first, then prune. Rows are
 * marked exported only after the sink confirms; a failed write is recorded
 * (the rows stay, the same batch is retried at the next due time) and ends
 * the run. Each step is its own audited system action in `board`.
 */
export async function exportAudit(
  board: AuditExporter,
  sink: AuditSink,
  maxBatches = MAX_BATCHES_PER_RUN,
): Promise<ExportRun> {
  const run: ExportRun = { exported: [], results: [] };
  for (let i = 0; i < maxBatches; i++) {
    const batch = board.beginAuditExport();
    if (!batch) break;
    let outcome: "created" | "exists";
    try {
      outcome = await sink.create(batch.path, batch.body);
    } catch (err) {
      const error = errorText(err);
      run.failed = { first: batch.first, last: batch.last, error };
      run.results.push(board.failAuditExport(batch, error));
      return run;
    }
    const r = board.confirmAuditExport(batch, outcome);
    run.results.push(r);
    if (!r.ok) {
      const error = `confirm refused: ${r.error.message}`;
      run.failed = { first: batch.first, last: batch.last, error };
      run.results.push(board.failAuditExport(batch, error));
      return run;
    }
    run.exported.push({ first: batch.first, last: batch.last, path: batch.path, outcome });
  }
  const pruned = board.pruneAudit();
  if (pruned) run.results.push(pruned);
  return run;
}

function errorText(err: unknown): string {
  const s = err instanceof Error ? err.message : String(err);
  return s.slice(0, 300);
}

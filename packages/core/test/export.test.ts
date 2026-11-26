// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0

/**
 * M6a: audit export through `AuditSink` (A6.1–A6.4). `LocalDirSink` in a
 * temporary directory; the clock is moved by hand.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalAuditJson, chainValueAfter, GENESIS_HASH, type AuditRow } from "../src/audit.ts";
import {
  batchPath,
  buildBatch,
  exportAudit,
  parseBatch,
  verifyAuditArchive,
  type AuditSink,
} from "../src/audit-export.ts";
import { LocalDirSink } from "../src/local-dir-sink.ts";
import type { BoardConfig } from "../src/types.ts";
import { Board } from "../src/act.ts";
import { MAX_PRUNE_ROWS } from "../src/actions/audit-export.ts";
import { ADMIN, counterBytes, makeBoard, RecordingSql, sha256, type Fixture } from "./helpers.ts";

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempSink(): LocalDirSink {
  const d = mkdtempSync(join(tmpdir(), "bbs-sink-"));
  dirs.push(d);
  return new LocalDirSink(d);
}

/** The test boards' id: the counter's first 8 bytes. */
const BID = "0001020304050607";

function board(
  config: Partial<BoardConfig> = {},
  wrap?: (raw: any) => any,
  randomBytes?: (n: number) => Uint8Array,
): Fixture {
  const f = makeBoard({ config, ...(wrap ? { wrap } : {}), ...(randomBytes ? { randomBytes } : {}) });
  f.addUser("alice");
  f.board.act(f.ctx("alice"), "topic_create", { name: "t" });
  return f;
}

function post(f: Fixture, n: number): void {
  for (let i = 0; i < n; i++) f.board.act(f.ctx("alice"), "post", { topic: "t", body: `m${i}` });
}

function meta(f: Fixture, key: string): string | undefined {
  return f.sql.one<{ value: string }>("SELECT value FROM meta WHERE key = ?", key)?.value;
}

function rows(f: Fixture): { seq: number; action: string; exported: number }[] {
  return f.sql
    .all<{ seq: number; action: string; exported: number }>("SELECT seq, action, exported FROM audit ORDER BY seq")
    .map((r) => ({ seq: Number(r.seq), action: r.action, exported: Number(r.exported) }));
}

/** A sink that fails on demand; otherwise writes to a LocalDirSink. */
class FlakySink implements AuditSink {
  failing = false;
  /** Write the object, then throw (a response lost after the write). */
  loseResponse = false;
  calls: string[] = [];
  constructor(readonly inner: LocalDirSink) {}
  async create(path: string, body: string): Promise<"created" | "exists"> {
    this.calls.push(path);
    if (this.failing) throw new Error("HTTP 503 (backendError)");
    const r = await this.inner.create(path, body);
    if (this.loseResponse) throw new Error("connection reset");
    return r;
  }
}

describe("export through AuditSink (A6.1)", () => {
  it("writes audit/dt=YYYY-MM-DD/<board_id>-<first>-<last>.ndjson with one canonical row per line, the board id and the chain value", async () => {
    const f = board();
    post(f, 3);
    const sink = tempSink();
    const top = Number(f.sql.one<{ m: number }>("SELECT MAX(seq) AS m FROM audit")?.m);
    const headBefore = meta(f, "audit_head");
    // Not due before the interval.
    const oldest = Number(f.sql.one<{ ts: number }>("SELECT ts FROM audit ORDER BY seq LIMIT 1")?.ts);
    expect(f.board.nextAuditExportDue()).toBe(oldest + 15 * MIN);
    expect((await exportAudit(f.board, sink)).exported).toEqual([]);
    f.clock.advance(15 * MIN);
    const run = await exportAudit(f.board, sink);
    expect(run.exported).toEqual([
      { first: 1, last: top, path: `audit/dt=2026-11-20/${BID}-1-${top}.ndjson`, outcome: "created" },
    ]);
    expect(f.board.auditChainState().board_id).toBe(BID);
    const files = sink.readAll();
    expect(files.map((x) => x.path)).toEqual([`audit/dt=2026-11-20/${BID}-1-${top}.ndjson`]);
    const lines = files[0]!.body.trimEnd().split("\n").map((l) => JSON.parse(l));
    expect(lines.map((l) => l.seq)).toEqual(Array.from({ length: top }, (_, i) => i + 1));
    // The last line carries the chain value at the batch's end: the head
    // when the batch was fixed (before the export's own rows).
    expect(lines.at(-1).chain).toBe(headBefore);
    // Every line is the canonical row JSON plus "board_id" and "chain".
    const parsed = parseBatch(files[0]!.path, files[0]!.body);
    parsed.rows.forEach((r, i) => {
      expect(files[0]!.body.split("\n")[i]).toBe(
        `${canonicalAuditJson(r).slice(0, -1)},"board_id":"${BID}","chain":"${parsed.chains[i]}"}`,
      );
    });
    // Rows marked exported only through the batch; the bookkeeping rows after it are not.
    expect(rows(f).filter((r) => r.exported === 1).map((r) => r.seq)).toEqual(lines.map((l) => l.seq));
    expect(rows(f).slice(top).map((r) => r.action)).toEqual(["audit_export_begin", "audit_export"]);
    const confirm = f.sql.one<{ detail: string }>("SELECT detail FROM audit WHERE action = 'audit_export'");
    expect(JSON.parse(confirm!.detail)).toMatchObject({ first: 1, last: top, already_existed: false, chain: headBefore });
  });

  it("dt is the UTC date of the batch's first row", () => {
    expect(batchPath(BID, 7, 9, Date.UTC(2026, 0, 31, 23, 59, 59))).toBe(`audit/dt=2026-01-31/${BID}-7-9.ndjson`);
    expect(batchPath(BID, 7, 9, Date.UTC(2026, 1, 1, 0, 0, 0))).toBe(`audit/dt=2026-02-01/${BID}-7-9.ndjson`);
    expect(() => batchPath("not-an-id", 1, 2, 0)).toThrow(/board id/);
  });

  it("exports at once at auditExportBatchRows unexported rows, in contiguous batches of at most that many", async () => {
    const f = board({ auditExportBatchRows: 10 });
    post(f, 25);
    expect(f.board.nextAuditExportDue()).toBe(f.clock.t);
    const sink = tempSink();
    const run = await exportAudit(f.board, sink);
    const ranges = run.exported.map((b) => [b.first, b.last]);
    // Each batch starts where the last ended; begin/confirm rows go in later batches.
    expect(ranges[0]).toEqual([1, 10]);
    for (let i = 1; i < ranges.length; i++) expect(ranges[i]![0]).toBe(ranges[i - 1]![1]! + 1);
    expect(ranges.every(([a, b]) => b! - a! + 1 <= 10)).toBe(true);
    expect(f.board.verifyAuditWithArchive(sink.readAll())).toMatchObject({ ok: true });
  });

  it("the export's own rows never make an export due on their own", async () => {
    const f = board();
    post(f, 1);
    f.clock.advance(15 * MIN);
    const sink = tempSink();
    await exportAudit(f.board, sink);
    // Only begin + confirm rows are unexported now: nothing due, ever.
    f.clock.advance(10 * DAY);
    expect((await exportAudit(f.board, sink)).exported).toEqual([]);
    // A real row makes them due; they go out with it.
    post(f, 1);
    f.clock.advance(15 * MIN);
    const run = await exportAudit(f.board, sink);
    expect(run.exported).toHaveLength(1);
    expect(sink.readAll()).toHaveLength(2);
  });

  it("is not due before the interval and fixes no batch early", () => {
    const f = board();
    // Rows exist (bootstrap, user, topic): due 15 minutes after the oldest.
    const oldest = Number(f.sql.one<{ ts: number }>("SELECT ts FROM audit ORDER BY seq LIMIT 1")?.ts);
    expect(f.board.nextAuditExportDue()).toBe(oldest + 15 * MIN);
    expect(f.board.beginAuditExport()).toBeNull();
    expect(f.sql.one("SELECT COUNT(*) AS n FROM audit WHERE action = 'audit_export_begin'")).toEqual({ n: 0 });
  });
});

describe("failure, retry and the hot period (A6.2)", () => {
  it("a failed write leaves the rows, retries the same batch after the interval, then confirms", async () => {
    const f = board();
    post(f, 3);
    f.clock.advance(15 * MIN);
    const sink = new FlakySink(tempSink());
    sink.failing = true;
    const r1 = await exportAudit(f.board, sink);
    expect(r1.failed).toMatchObject({ first: 1, error: "HTTP 503 (backendError)" });
    expect(rows(f).every((r) => r.exported === 0)).toBe(true);
    expect(meta(f, "audit_export_retry_at")).toBe(String(f.clock.t + 15 * MIN));
    expect(f.board.nextAuditExportDue()).toBe(f.clock.t + 15 * MIN);
    // Not retried before its time.
    await exportAudit(f.board, sink);
    expect(sink.calls).toHaveLength(1);
    // Rows past the hot period are not deleted while unexported.
    f.clock.advance(31 * DAY);
    await exportAudit(f.board, sink);
    expect(rows(f)[0]!.seq).toBe(1);
    expect(f.board.verifyAudit().ok).toBe(true);
    expect(sink.calls).toHaveLength(2);
    sink.failing = false;
    f.clock.advance(15 * MIN);
    const r3 = await exportAudit(f.board, sink);
    // Same range on every attempt.
    expect(new Set(sink.calls).size).toBe(1);
    expect(r3.exported[0]).toMatchObject({ first: 1, outcome: "created" });
    // Now exported and 31 days old: pruned in the same confirm.
    // Exactly through the batch: the failure rows after it are as old but unexported, so they stay.
    expect(rows(f)[0]!.seq).toBe(r3.exported[0]!.last + 1);
    expect(meta(f, "audit_export_failures")).toBeUndefined();
  });

  it("a write whose response was lost is confirmed by the 412-style 'exists' on retry, never written twice", async () => {
    const f = board();
    post(f, 2);
    f.clock.advance(15 * MIN);
    const local = tempSink();
    const sink = new FlakySink(local);
    sink.loseResponse = true;
    const r1 = await exportAudit(f.board, sink);
    expect(r1.failed?.error).toBe("connection reset");
    expect(local.readAll()).toHaveLength(1);
    const before = local.readAll()[0]!;
    sink.loseResponse = false;
    // More rows arrive meanwhile; the retry still writes the pending range.
    post(f, 5);
    f.clock.advance(15 * MIN);
    const r2 = await exportAudit(f.board, sink);
    expect(r2.exported[0]).toMatchObject({ first: r1.failed!.first, last: r1.failed!.last, outcome: "exists" });
    expect(local.readAll()[0]).toEqual(before);
    const confirm = f.sql.one<{ detail: string }>("SELECT detail FROM audit WHERE action = 'audit_export'");
    expect(JSON.parse(confirm!.detail)).toMatchObject({ already_existed: true, after_failures: 1 });
    expect(f.board.verifyAuditWithArchive(local.readAll())).toMatchObject({ ok: true });
  });

  it("deletes exported rows only past the hot period, keeps verifyAudit working on the hot part", async () => {
    const f = board({ auditHotMs: DAY });
    post(f, 4);
    f.clock.advance(15 * MIN);
    const sink = tempSink();
    await exportAudit(f.board, sink);
    const exportedThrough = Number(meta(f, "audit_exported_seq"));
    expect(rows(f)[0]!.seq).toBe(1);
    // A new row now, exported later; then the first batch passes the hot period.
    f.clock.advance(DAY);
    post(f, 1);
    // The prune is due now (the oldest row is a day old); the new row's export is not.
    expect(f.board.nextAuditExportDue()).toBeLessThanOrEqual(f.clock.t);
    const run = await exportAudit(f.board, sink);
    expect(run.exported).toEqual([]);
    const pruned = run.results.find((r) => r.ok && (r.value as any).through);
    expect(pruned).toBeDefined();
    expect(rows(f)[0]!.seq).toBe(exportedThrough + 1);
    expect(meta(f, "audit_tail_seq")).toBe(String(exportedThrough + 1));
    expect(f.board.verifyAudit()).toMatchObject({ ok: true });
    expect(f.board.verifyAuditWithArchive(sink.readAll())).toMatchObject({ ok: true });
    // The prune is audited.
    expect(f.sql.one("SELECT COUNT(*) AS n FROM audit WHERE action = 'audit_prune'")).toEqual({ n: 1 });
  });

  it("posts one admin notice after a day of continuous failure, and a recovery line", async () => {
    const f = board();
    post(f, 1);
    f.clock.advance(15 * MIN);
    const sink = new FlakySink(tempSink());
    sink.failing = true;
    const notices: unknown[] = [];
    for (let i = 0; i < 4 * 24 + 8; i++) {
      const run = await exportAudit(f.board, sink);
      for (const r of run.results) notices.push(...r.notifications.filter((n) => n.type === "admin"));
      f.clock.advance(15 * MIN);
    }
    expect(notices).toEqual([
      expect.objectContaining({ type: "admin", reason: "audit_export_failing", recipient: ADMIN, as: "admin" }),
    ]);
    // M2 (B23, B47): stored for the admin's bbs_inbox, never rung (people have no doorbell).
    expect(f.sql.all("SELECT handle, kind, reason, wake FROM notices WHERE reason = 'audit_export_failing'")).toEqual([
      { handle: ADMIN, kind: "admin", reason: "audit_export_failing", wake: 0 },
    ]);
    expect(f.sql.all("SELECT handle FROM doorbells")).toEqual([]);
    const lines = f.sql.all<{ body: string }>("SELECT body FROM messages WHERE topic = 'admin-log' AND body LIKE 'audit export%'");
    expect(lines).toHaveLength(1);
    expect(lines[0]!.body).toMatch(/^audit export failing since .* \(97 attempts\); rows are kept and retried\. Last error: HTTP 503/);
    sink.failing = false;
    await exportAudit(f.board, sink);
    const after = f.sql.all<{ body: string }>("SELECT body FROM messages WHERE topic = 'admin-log' AND body LIKE 'audit export%' ORDER BY seq");
    expect(after.at(-1)!.body).toMatch(/^audit export recovered after \d+ failed attempts$/);
    // A new spell of failure starts a new day before another notice.
    post(f, 1);
    f.clock.advance(15 * MIN);
    sink.failing = true;
    await exportAudit(f.board, sink);
    expect(meta(f, "audit_export_notice_at")).toBeUndefined();
  });

  it("confirm and fail refuse a batch that is not the pending one", () => {
    const f = board();
    const fake = { first: 1, last: 2, path: `audit/dt=2026-11-20/${BID}-1-2.ndjson`, body: "", chain: "" };
    const r = f.board.confirmAuditExport(fake, "created");
    expect(r).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(rows(f).every((x) => x.exported === 0)).toBe(true);
    expect(f.board.failAuditExport(fake, "x")).toMatchObject({ ok: false });
  });
});

describe("chain across the hot/archive boundary (A6.4)", () => {
  async function exported(): Promise<{ f: Fixture; sink: LocalDirSink }> {
    const f = board({ auditExportBatchRows: 5, auditHotMs: DAY });
    post(f, 12);
    const sink = tempSink();
    await exportAudit(f.board, sink);
    f.clock.advance(DAY + 1);
    post(f, 2);
    await exportAudit(f.board, sink);
    expect(Number(meta(f, "audit_tail_seq"))).toBeGreaterThan(1);
    return { f, sink };
  }

  it("verifies archived batches plus hot rows", async () => {
    const { f, sink } = await exported();
    const r = f.board.verifyAuditWithArchive(sink.readAll());
    expect(r).toMatchObject({ ok: true });
    if (r.ok) expect(r.batches).toBe(sink.readAll().length);
  });

  it("detects an edited row in an archived batch", async () => {
    const { f, sink } = await exported();
    const files = sink.readAll();
    const b = files[1]!;
    const edited = b.body.replace('"actor":"alice"', '"actor":"mallory"');
    expect(edited).not.toBe(b.body);
    files[1] = { path: b.path, body: edited };
    expect(f.board.verifyAuditWithArchive(files)).toMatchObject({ ok: false, path: b.path });
  });

  it("detects an edited hot row", async () => {
    const { f, sink } = await exported();
    const seq = Number(meta(f, "audit_tail_seq")) + 1;
    f.sql.exec("UPDATE audit SET detail = '{\"x\":1}' WHERE seq = ?", seq);
    expect(f.board.verifyAuditWithArchive(sink.readAll())).toMatchObject({ ok: false });
    expect(f.board.verifyAudit().ok).toBe(false);
  });

  it("detects an exported hot row that differs from its archived copy (last row of a batch)", async () => {
    const { f, sink } = await exported();
    const top = Number(meta(f, "audit_exported_seq"));
    f.sql.exec("UPDATE audit SET result = 'denied' WHERE seq = ?", top);
    expect(f.board.verifyAuditWithArchive(sink.readAll())).toMatchObject({ ok: false });
  });

  it("detects an exported hot row rewritten with a re-chained hot window and head (F mutation M13)", async () => {
    // Someone with write access to SQLite edits an exported row that is still
    // hot and recomputes every later prev_hash and the recorded head: the hot
    // chain alone then verifies, and only the archived copy shows the edit.
    const { f, sink } = await exported();
    const top = Number(meta(f, "audit_exported_seq"));
    expect(top).toBeGreaterThanOrEqual(Number(meta(f, "audit_tail_seq")));
    f.sql.exec("UPDATE audit SET result = 'denied' WHERE seq = ?", top);
    const cols = `seq, ts, actor, actor_kind, via, session, action, target_type, target_id,
                  topic, result, detail, request_id, prev_hash`;
    let prev = f.sql.one<AuditRow>(`SELECT ${cols} FROM audit WHERE seq = ?`, top)!;
    for (const row of f.sql.all<AuditRow>(`SELECT ${cols} FROM audit WHERE seq > ? ORDER BY seq`, top)) {
      const fixed = { ...row, prev_hash: chainValueAfter(prev, sha256) };
      f.sql.exec("UPDATE audit SET prev_hash = ? WHERE seq = ?", fixed.prev_hash, row.seq);
      prev = fixed;
    }
    f.sql.exec("UPDATE meta SET value = ? WHERE key = 'audit_head'", chainValueAfter(prev, sha256));
    expect(f.board.verifyAudit()).toMatchObject({ ok: true });
    expect(f.board.verifyAuditWithArchive(sink.readAll())).toMatchObject({
      ok: false,
      seq: top,
      reason: "hot row differs from its archived copy",
    });
  });

  it("detects a missing batch, a missing first batch and a line whose chain value is wrong", async () => {
    const { f, sink } = await exported();
    const files = sink.readAll();
    const middle = files.filter((_, i) => i !== 1);
    expect(f.board.verifyAuditWithArchive(middle)).toMatchObject({ ok: false, reason: expect.stringMatching(/^missing batch/) });
    expect(f.board.verifyAuditWithArchive(files.slice(1))).toMatchObject({ ok: false, reason: expect.stringMatching(/^missing batch/) });
    // A missing last archived batch before the hot window.
    const archivedBeforeTail = files.filter((x) => parseBatch(x.path, x.body).last < Number(meta(f, "audit_tail_seq")));
    expect(f.board.verifyAuditWithArchive(archivedBeforeTail.slice(0, -1))).toMatchObject({ ok: false });
    const b = files[0]!;
    const lines = b.body.trimEnd().split("\n");
    lines[lines.length - 1] = lines.at(-1)!.replace(/"chain":"[0-9a-f]+"/, `"chain":"${"1".repeat(64)}"`);
    const bad = [{ path: b.path, body: `${lines.join("\n")}\n` }, ...files.slice(1)];
    expect(f.board.verifyAuditWithArchive(bad)).toMatchObject({ ok: false, reason: "line's chain value does not match" });
  });

  it("detects a well-formed overlapping batch (review m2) and a wrong dt", async () => {
    const { f, sink } = await exported();
    const files = sink.readAll();
    // A valid batch (right name, chain and board id) over rows 3..7, overlapping 1..5.
    const byFirst = files.map((x) => parseBatch(x.path, x.body)).sort((x, y) => x.first - y.first);
    const rows15 = [...byFirst[0]!.rows, ...byFirst[1]!.rows];
    const over = buildBatch(rows15.slice(2, 7), sha256, BID);
    expect(over.first).toBe(3);
    const r = f.board.verifyAuditWithArchive([...files, { path: over.path, body: over.body }]);
    expect(r).toMatchObject({ ok: false, seq: 3, reason: expect.stringMatching(/^batch overlaps an earlier batch/) });
    const wrongDt = { path: files[0]!.path.replace("dt=2026-11-20", "dt=2026-11-21"), body: files[0]!.body };
    expect(f.board.verifyAuditWithArchive([wrongDt, ...files.slice(1)])).toMatchObject({
      ok: false,
      reason: "dt does not match the first row's date",
    });
  });

  it("verifyAuditArchive with no archive is the hot chain from genesis", () => {
    const f = board();
    const hot = f.sql.all<AuditRow>("SELECT seq, ts, actor, actor_kind, via, session, action, target_type, target_id, topic, result, detail, request_id, prev_hash FROM audit ORDER BY seq").map((r) => ({ ...r, seq: Number(r.seq), ts: Number(r.ts) }));
    const head = meta(f, "audit_head")!;
    expect(
      verifyAuditArchive({ boardId: BID, exportedSeq: 0, batches: [], hot, tail: { seq: 1, hash: GENESIS_HASH }, head, sha256 }),
    ).toMatchObject({ ok: true });
    expect(chainValueAfter(hot.at(-1)!, sha256)).toBe(head);
  });
});

describe("review fixes (M6a independent review)", () => {
  it("M1: two boards exporting into one place write distinct objects; neither confirms the other's batch", async () => {
    const a = board();
    const other = counterBytes();
    for (let i = 0; i < 16; i++) other(1); // a different first 8 bytes, so a different board id
    const b = board({}, undefined, other);
    const idA = a.board.auditChainState().board_id;
    const idB = b.board.auditChainState().board_id;
    expect(idA).toMatch(/^[0-9a-f]{16}$/);
    expect(idB).toMatch(/^[0-9a-f]{16}$/);
    expect(idB).not.toBe(idA);
    post(a, 2);
    post(b, 2);
    a.clock.advance(15 * MIN);
    b.clock.advance(15 * MIN);
    const sink = tempSink();
    const ra = await exportAudit(a.board, sink);
    const rb = await exportAudit(b.board, sink);
    // Same seq ranges, different names; both created, neither "exists".
    expect(ra.exported[0]).toMatchObject({ first: 1, outcome: "created" });
    expect(rb.exported[0]).toMatchObject({ first: 1, outcome: "created" });
    expect(ra.exported[0]!.path).not.toBe(rb.exported[0]!.path);
    expect(sink.readAll()).toHaveLength(2);
    // Each board's verifier skips the other's batch.
    expect(a.board.verifyAuditWithArchive(sink.readAll())).toMatchObject({ ok: true, batches: 1, otherBoards: 1 });
    expect(b.board.verifyAuditWithArchive(sink.readAll())).toMatchObject({ ok: true, batches: 1, otherBoards: 1 });
    // Board B's batch renamed under board A's id is rejected (its lines name B).
    const fromB = sink.readAll().find((x) => x.path.includes(idB))!;
    const renamed = { path: fromB.path.replace(idB, idA), body: fromB.body };
    const onlyA = sink.readAll().filter((x) => x.path.includes(idA));
    expect(a.board.verifyAuditWithArchive([...onlyA, renamed])).toMatchObject({
      ok: false,
      reason: "line 1: board_id does not match the name",
    });
  });

  it("M1: a board whose storage was reset gets a new id, so its batches never collide with the old ones", async () => {
    const old = board();
    post(old, 2);
    old.clock.advance(15 * MIN);
    const sink = tempSink();
    await exportAudit(old.board, sink);
    // A fresh board (empty storage) with other random bytes: new id, seq starts at 1 again.
    const other = counterBytes();
    for (let i = 0; i < 3; i++) other(1);
    const fresh = board({}, undefined, other);
    post(fresh, 2);
    fresh.clock.advance(15 * MIN);
    const r = await exportAudit(fresh.board, sink);
    expect(r.exported[0]).toMatchObject({ first: 1, outcome: "created" });
    expect(fresh.board.verifyAuditWithArchive(sink.readAll())).toMatchObject({ ok: true, otherBoards: 1 });
  });

  it("existing boards get a board id at their first start with M6a's code", () => {
    const f = board();
    f.sql.exec("DELETE FROM meta WHERE key = 'board_id'");
    const again = new Board({ sql: f.sql, now: f.clock.now, sha256, randomBytes: counterBytes() });
    expect(again.auditChainState().board_id).toBe(BID);
    // And never changes after that.
    const third = new Board({ sql: f.sql, now: f.clock.now, sha256, randomBytes: () => new Uint8Array(8).fill(255) });
    expect(third.auditChainState().board_id).toBe(BID);
  });

  it("m1: a missing batch of exported rows that are still hot is detected", async () => {
    const f = board({ auditExportBatchRows: 5 });
    post(f, 12);
    const sink = tempSink();
    await exportAudit(f.board, sink);
    const files = sink.readAll();
    expect(files.length).toBeGreaterThan(2);
    expect(Number(meta(f, "audit_tail_seq"))).toBe(1); // nothing pruned: every row is hot
    expect(f.board.verifyAuditWithArchive(files)).toMatchObject({ ok: true });
    expect(f.board.verifyAuditWithArchive(files.slice(0, -1))).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/^missing batch: rows through seq \d+ are exported/),
    });
    expect(f.board.verifyAuditWithArchive([])).toMatchObject({ ok: false });
  });

  it("m6: a truncated last batch and reordered lines are detected", async () => {
    const f = board({ auditExportBatchRows: 5 });
    post(f, 12);
    const sink = tempSink();
    await exportAudit(f.board, sink);
    const files = sink.readAll();
    const last = files.at(-1)!;
    const lines = last.body.trimEnd().split("\n");
    const dropLine = [...files.slice(0, -1), { path: last.path, body: `${lines.slice(0, -1).join("\n")}\n` }];
    expect(f.board.verifyAuditWithArchive(dropLine)).toMatchObject({
      ok: false,
      reason: "first and last seq do not match the name",
    });
    const cut = [...files.slice(0, -1), { path: last.path, body: last.body.slice(0, -20) }];
    expect(f.board.verifyAuditWithArchive(cut)).toMatchObject({ ok: false, path: last.path });
    const first = files[0]!;
    const fl = first.body.trimEnd().split("\n");
    [fl[1], fl[2]] = [fl[2]!, fl[1]!];
    const swapped = [{ path: first.path, body: `${fl.join("\n")}\n` }, ...files.slice(1)];
    expect(f.board.verifyAuditWithArchive(swapped)).toMatchObject({ ok: false, path: first.path });
  });

  it(`m6: one prune deletes at most MAX_PRUNE_ROWS (${MAX_PRUNE_ROWS}) rows; the next prune continues`, async () => {
    const f = board({ auditExportBatchRows: 10_000, auditHotMs: DAY });
    post(f, MAX_PRUNE_ROWS + 50);
    f.clock.advance(15 * MIN);
    const sink = tempSink();
    const run = await exportAudit(f.board, sink);
    expect(run.exported).toHaveLength(1);
    const exportedThrough = Number(meta(f, "audit_exported_seq"));
    expect(exportedThrough).toBeGreaterThan(MAX_PRUNE_ROWS);
    f.clock.advance(DAY + 1);
    const p1 = f.board.pruneAudit();
    expect(p1).toMatchObject({ ok: true, value: { rows: MAX_PRUNE_ROWS, through: MAX_PRUNE_ROWS } });
    expect(f.board.verifyAudit().ok).toBe(true);
    // Still due: the next alarm continues.
    expect(f.board.nextAuditExportDue()).toBeLessThanOrEqual(f.clock.t);
    const p2 = f.board.pruneAudit();
    expect(p2).toMatchObject({ ok: true, value: { through: exportedThrough } });
    expect(Number(meta(f, "audit_tail_seq"))).toBe(exportedThrough + 1);
    expect(f.board.verifyAuditWithArchive(sink.readAll())).toMatchObject({ ok: true });
  }, 30_000);

  it("m6: a crash between audit_export_begin and the write retries the same batch on the next start", async () => {
    const f = board();
    post(f, 3);
    f.clock.advance(15 * MIN);
    const begun = f.board.beginAuditExport();
    expect(begun).not.toBeNull();
    // The Durable Object is evicted here: no write, no confirm, no failure row.
    const restarted = new Board({ sql: f.sql, now: f.clock.now, sha256, randomBytes: counterBytes() });
    expect(restarted.nextAuditExportDue()).toBe(f.clock.t);
    const sink = tempSink();
    const run = await exportAudit(restarted, sink);
    expect(run.exported[0]).toMatchObject({ first: begun!.first, last: begun!.last, path: begun!.path, outcome: "created" });
    expect(sink.readAll()[0]!.body).toBe(begun!.body);
    expect(f.sql.one("SELECT COUNT(*) AS n FROM audit WHERE action = 'audit_export_begin'")).toEqual({ n: 1 });
    expect(restarted.verifyAuditWithArchive(sink.readAll())).toMatchObject({ ok: true });
  });

  it("n1: export settings have upper bounds", () => {
    expect(() => makeBoard({ config: { auditExportBatchRows: 10_001 } })).toThrow(/auditExportBatchRows/);
    expect(() => makeBoard({ config: { auditExportIntervalMs: DAY + 1 } })).toThrow(/auditExportIntervalMs/);
    expect(() => makeBoard({ config: { auditHotMs: 367 * DAY } })).toThrow(/auditHotMs/);
    expect(() => makeBoard({ config: { auditExportBatchRows: 10_000, auditExportIntervalMs: DAY, auditHotMs: 366 * DAY } })).not.toThrow();
  });
});

describe("LocalDirSink", () => {
  it("creates only: a second create of the same name reports exists and leaves the first", async () => {
    const sink = tempSink();
    const p = `audit/dt=2026-11-20/${BID}-1-2.ndjson`;
    expect(await sink.create(p, "a\n")).toBe("created");
    expect(await sink.create(p, "b\n")).toBe("exists");
    expect(readFileSync(join(sink.dir, p), "utf8")).toBe("a\n");
    expect(sink.readAll()).toEqual([{ path: p, body: "a\n" }]);
  });

  it("refuses a path outside audit/dt=.../<board_id>-<first>-<last>.ndjson", async () => {
    const sink = tempSink();
    await expect(sink.create("audit/dt=2026-11-20/1-2.ndjson", "")).rejects.toThrow(/not an audit batch path/);
    await expect(sink.create("../x.ndjson", "")).rejects.toThrow(/not an audit batch path/);
    await expect(sink.create("audit/dt=2026-11-20/../../x.ndjson", "")).rejects.toThrow();
    writeFileSync(join(sink.dir, "stray.txt"), "x");
    expect(sink.readAll()).toEqual([]);
  });
});

describe("guard: export steps write only inside act", () => {
  it("every export write is in a transaction with exactly one audit row", async () => {
    let rec: RecordingSql | undefined;
    const f = board({ auditExportBatchRows: 4, auditHotMs: DAY }, (raw) => {
      rec = new RecordingSql(raw);
      return rec;
    });
    post(f, 9);
    const sink = new FlakySink(tempSink());
    sink.failing = true;
    await exportAudit(f.board, sink);
    f.clock.advance(16 * MIN);
    sink.failing = false;
    await exportAudit(f.board, sink);
    f.clock.advance(2 * DAY);
    post(f, 1);
    await exportAudit(f.board, sink);
    // Pruned inside the confirm of the last export.
    expect(f.sql.one("SELECT COUNT(*) AS n FROM audit WHERE action = 'audit_export' AND detail LIKE '%\"pruned\"%'")).toEqual({ n: 1 });
    const writes = rec!.log.filter((s) => s.write);
    expect(writes.filter((s) => !s.inTransaction)).toEqual([]);
    const perTx = new Map<number, number>();
    for (const s of writes) {
      if (/^\s*INSERT INTO audit\b/.test(s.sql)) perTx.set(s.transaction, (perTx.get(s.transaction) ?? 0) + 1);
    }
    const txs = new Set(writes.filter((s) => !s.sql.startsWith("CREATE")).map((s) => s.transaction));
    for (const tx of txs) {
      if (writes.some((s) => s.transaction === tx && s.sql.startsWith("CREATE"))) continue;
      expect(perTx.get(tx), `transaction ${tx}`).toBe(1);
    }
  });
});

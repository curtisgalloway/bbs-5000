// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  canonicalAuditJson,
  chainValueAfter,
  GENESIS_HASH,
  verifyChain,
  type AuditRow,
} from "../src/audit.ts";
import { ADMIN, makeBoard, sha256 } from "./helpers.ts";

function row(seq: number, prev: string, extra: Partial<AuditRow> = {}): AuditRow {
  return {
    seq,
    ts: 1000 + seq,
    actor: "a",
    actor_kind: "agent",
    via: "mcp",
    session: null,
    action: "post",
    target_type: "message",
    target_id: String(seq),
    topic: "t",
    result: "ok",
    detail: "{}",
    request_id: null,
    prev_hash: prev,
    ...extra,
  };
}

function chain(n: number): AuditRow[] {
  const rows: AuditRow[] = [];
  let prev = GENESIS_HASH;
  for (let i = 1; i <= n; i++) {
    const r = row(i, prev);
    rows.push(r);
    prev = chainValueAfter(r, sha256);
  }
  return rows;
}

describe("audit chain", () => {
  it("canonical JSON uses a fixed key order and nulls", () => {
    const a = row(1, GENESIS_HASH);
    const b = { ...a } as Record<string, unknown>;
    // Same fields inserted in another order hash the same.
    const reordered = Object.fromEntries(Object.entries(b).reverse()) as unknown as AuditRow;
    expect(canonicalAuditJson(reordered)).toBe(canonicalAuditJson(a));
    expect(canonicalAuditJson(a)).toMatch(/^\{"seq":1,"ts":1001,"actor":"a",/);
    expect(canonicalAuditJson(a)).toContain('"session":null');
  });

  it("verifies an intact chain and returns its head", () => {
    const rows = chain(5);
    const last = rows.at(-1);
    if (!last) throw new Error("empty");
    const result = verifyChain(rows, sha256);
    expect(result).toEqual({ ok: true, head: chainValueAfter(last, sha256), rows: 5 });
  });

  it("detects an edited row", () => {
    const rows = chain(5);
    rows[2] = { ...rows[2]!, actor: "mallory" };
    expect(verifyChain(rows, sha256)).toEqual({
      ok: false,
      seq: 4,
      reason: "prev_hash does not match",
    });
  });

  it("detects an edit to the last row through the recorded head", () => {
    const rows = chain(3);
    const head = verifyChain(rows, sha256);
    if (!head.ok) throw new Error("setup");
    rows[2] = { ...rows[2]!, result: "denied" };
    expect(verifyChain(rows, sha256, GENESIS_HASH, head.head).ok).toBe(false);
  });

  it("detects a removed row", () => {
    const rows = chain(5);
    rows.splice(2, 1);
    expect(verifyChain(rows, sha256)).toMatchObject({ ok: false, seq: 4 });
  });

  it("chains every row the board writes, and detects a tampered database", () => {
    const f = makeBoard();
    f.addUser("alice");
    f.board.act(f.ctx("alice"), "join", { role: "tester" });
    f.board.act(f.ctx("alice"), "topic_create", { name: "t" });
    f.board.act(f.ctx("alice"), "post", { topic: "t", body: "hello" });
    f.board.act(f.ctx("alice"), "audit", {}); // denied, still chained
    f.board.authenticate("nope", { via: "mcp" });
    const check = f.board.verifyAudit();
    expect(check.ok).toBe(true);
    if (check.ok) expect(check.rows).toBe(f.auditRows().length);

    const first = f.auditRows()[0];
    expect(first?.prev_hash).toBe(GENESIS_HASH);
    expect(first?.actor).toBe("system");
    expect(first?.action).toBe("bootstrap_human");
    expect(first?.target_id).toBe(ADMIN);

    f.sql.exec("UPDATE audit SET actor = 'mallory' WHERE seq = 3");
    expect(f.board.verifyAudit()).toMatchObject({ ok: false, seq: 4 });
  });

  it("detects deletion of the oldest row through the stored tail", () => {
    const f = makeBoard();
    f.addUser("alice");
    f.board.act(f.ctx("alice"), "join", {});
    expect(f.board.verifyAudit().ok).toBe(true);
    f.sql.exec("DELETE FROM audit WHERE seq = 1");
    expect(f.board.verifyAudit()).toEqual({
      ok: false,
      seq: 2,
      reason: "oldest row is seq 2; expected seq 1",
    });
  });

  it("detects a rewritten first row even with a forged prev_hash", () => {
    const f = makeBoard();
    f.addUser("alice");
    f.sql.exec("UPDATE audit SET prev_hash = ? WHERE seq = 1", "f".repeat(64));
    expect(f.board.verifyAudit()).toMatchObject({ ok: false, seq: 1 });
  });

  it("detects deletion of the newest row through the stored head", () => {
    const f = makeBoard();
    f.addUser("alice");
    f.board.act(f.ctx("alice"), "join", {});
    const n = f.auditRows().length;
    f.sql.exec("DELETE FROM audit WHERE seq = ?", n);
    expect(f.board.verifyAudit()).toMatchObject({
      ok: false,
      reason: "chain head does not match the recorded head",
    });
  });
});

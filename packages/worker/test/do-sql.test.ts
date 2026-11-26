// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0

// DoSql against a stand-in for the DO storage API, built on node:sqlite.
// The real API is exercised end to end under wrangler dev (test/e2e).

import { createHash } from "node:crypto";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { Board } from "@bbs-5000/core";
import { DoSql, toBinding, type DoSqlValue, type DoStorageLike } from "../src/do-sql.ts";

function fakeStorage(): DoStorageLike & { db: DatabaseSync; bindings: DoSqlValue[][] } {
  const db = new DatabaseSync(":memory:");
  const bindings: DoSqlValue[][] = [];
  return {
    db,
    bindings,
    sql: {
      exec(query, ...b) {
        bindings.push(b);
        if (/^\s*(BEGIN|COMMIT|ROLLBACK|SAVEPOINT)/i.test(query)) {
          throw new Error("exec cannot run transaction statements");
        }
        const args = b.map((v): SQLInputValue => (v instanceof ArrayBuffer ? new Uint8Array(v) : v));
        const stmt = db.prepare(query);
        const rows = stmt.columns().length > 0 ? stmt.all(...args) : (stmt.run(...args), []);
        return { toArray: () => rows as Record<string, unknown>[] };
      },
    },
    transactionSync(fn) {
      db.exec("BEGIN");
      try {
        const r = fn();
        db.exec("COMMIT");
        return r;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
  };
}

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

describe("DoSql", () => {
  it("runs core: migrate, bootstrap, add a user, join, post", () => {
    const storage = fakeStorage();
    const board = new Board({ sql: new DoSql(storage), now: () => 1000, sha256 });
    expect(board.bootstrapHuman("owner", sha256("h")).ok).toBe(true);
    const add = board.act<{ token: string }>({ handle: "owner", via: "cli" }, "admin_user_add", {
      handle: "alice",
    });
    expect(add.ok).toBe(true);
    expect(board.act({ handle: "alice", via: "api" }, "join", {}).ok).toBe(true);
    expect(board.act({ handle: "alice", via: "api" }, "post", { topic: "Lobby", body: "hi" }).ok).toBe(true);
    expect(board.verifyAudit()).toMatchObject({ ok: true, rows: 4 });
  });

  it("rolls back on throw and refuses nesting", () => {
    const storage = fakeStorage();
    const sql = new DoSql(storage);
    sql.exec("CREATE TABLE t (x INTEGER)");
    expect(() =>
      sql.transaction(() => {
        sql.exec("INSERT INTO t (x) VALUES (?)", 1);
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(sql.all("SELECT * FROM t")).toEqual([]);
    expect(() => sql.transaction(() => sql.transaction(() => 1))).toThrow("nested");
    // The flag is cleared after a failure, so the next transaction runs.
    expect(sql.transaction(() => 7)).toBe(7);
  });

  it("returns the first row or undefined from one()", () => {
    const sql = new DoSql(fakeStorage());
    sql.exec("CREATE TABLE t (x INTEGER)");
    expect(sql.one("SELECT x FROM t")).toBeUndefined();
    sql.exec("INSERT INTO t (x) VALUES (?), (?)", 1, 2);
    expect(sql.one("SELECT x FROM t ORDER BY x")).toEqual({ x: 1 });
  });

  it("converts bindings to what the DO API accepts", () => {
    expect(toBinding(5n)).toBe(5);
    expect(() => toBinding(2n ** 60n)).toThrow(RangeError);
    const bytes = new Uint8Array([1, 2, 3, 4]).subarray(1, 3);
    const buf = toBinding(bytes);
    expect(buf).toBeInstanceOf(ArrayBuffer);
    expect([...new Uint8Array(buf as ArrayBuffer)]).toEqual([2, 3]);
    expect(toBinding("s")).toBe("s");
    expect(toBinding(null)).toBeNull();
  });
});

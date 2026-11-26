// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0

/**
 * Issue #90: a handle is unique and matched without regard to case; the
 * spelling given when the account was made is the one stored and shown.
 */

import { describe, expect, it } from "vitest";
import { canonicalHandle, insertUserOnce } from "../src/actions/common.ts";
import { foldHandle } from "../src/params.ts";
import { type ActResult, type Tx } from "../src/types.ts";
import { ADMIN, makeBoard, sha256, type Fixture } from "./helpers.ts";

function ok<T>(r: ActResult<T>): Extract<ActResult<T>, { ok: true }> {
  if (!r.ok) throw new Error(`expected ok, got ${r.error.code}: ${r.error.message}`);
  return r;
}

function refused(r: ActResult): { code: string; message: string } {
  if (r.ok) throw new Error("expected a refusal");
  return r.error;
}

function count(f: Fixture, handle: string): number {
  return Number(f.sql.one<{ n: number }>("SELECT COUNT(*) AS n FROM users WHERE handle COLLATE NOCASE = ?", handle)?.n);
}

describe("the fold", () => {
  it("folds A-Z only, as COLLATE NOCASE does", () => {
    expect(foldHandle("ChatGPT-99_X")).toBe("chatgpt-99_x");
    const f = makeBoard();
    f.addUser("Mixed-Case");
    expect(f.sql.one("SELECT 1 AS x FROM users WHERE handle COLLATE NOCASE = ?", foldHandle("MIXED-CASE"))).toEqual({ x: 1 });
  });

  it("handles hold ASCII only, so no other letter needs folding", () => {
    const f = makeBoard();
    for (const handle of ["café", "İstanbul", "Kelvin"]) {
      expect(refused(f.board.act(f.ctx(ADMIN), "admin_user_add", { handle })).code).toBe("bad_request");
    }
  });
});

describe("creation refuses a case variant", () => {
  it("admin_user_add, naming the stored spelling", () => {
    const f = makeBoard();
    f.addUser("ChatGPT-99");
    const e = refused(f.board.act(f.ctx(ADMIN), "admin_user_add", { handle: "chatgpt-99" }));
    expect(e.code).toBe("exists");
    expect(e.message).toContain("ChatGPT-99");
    expect(count(f, "chatgpt-99")).toBe(1);
  });

  it("admin_user_add against the bootstrap person", () => {
    const f = makeBoard();
    expect(refused(f.board.act(f.ctx(ADMIN), "admin_user_add", { handle: "OWNER" })).message).toContain("owner");
  });

  it("bootstrap of a case variant of an existing account", () => {
    const f = makeBoard();
    f.addUser("Alice");
    const e = refused(f.board.bootstrapHuman("alice", sha256("another-credential")));
    expect(e.code).toBe("exists");
    expect(e.message).toContain("Alice");
    expect(count(f, "alice")).toBe(1);
  });

  it("two sequential creates of case variants make one account", () => {
    const f = makeBoard();
    const results = ["Bot-1", "bot-1", "BOT-1"].map((handle) =>
      f.board.act(f.ctx(ADMIN), "admin_user_add", { handle }),
    );
    expect(results.map((r) => r.ok)).toEqual([true, false, false]);
    expect(f.sql.all("SELECT handle FROM users WHERE handle COLLATE NOCASE = 'bot-1'")).toEqual([{ handle: "Bot-1" }]);
  });

  it("the refusal is the INSERT's own condition, judged by rows changed", () => {
    const f = makeBoard();
    const tx = { sql: f.sql } as unknown as Tx;
    const cols = ["handle", "kind", "created_at"];
    insertUserOnce(tx, cols, ["Racer", "agent", 1]);
    expect(() => insertUserOnce(tx, cols, ["racer", "agent", 2])).toThrow(/a user named Racer already exists/);
    expect(count(f, "RACER")).toBe(1);
  });
});

describe("every lookup of a caller's handle resolves a case variant", () => {
  function world(): Fixture {
    const f = makeBoard();
    f.addUser("ChatGPT-99");
    f.addUser("Alice");
    ok(f.board.act(f.ctx("Alice"), "topic_create", { name: "t" }));
    ok(f.board.act(f.ctx("ChatGPT-99"), "subscribe", { topic: "t", level: "wake" }));
    return f;
  }

  it("task_assign stores and shows the stored spelling", () => {
    const f = world();
    const created = ok(f.board.act<{ task: { id: number } }>(f.ctx("Alice"), "task_create", { topic: "t", title: "work" }));
    const r = ok(
      f.board.act<{ task: { assignee: string } }>(f.ctx("Alice"), "task_assign", {
        task: created.value.task.id,
        assignee: "chatgpt-99",
      }),
    );
    expect(r.value.task.assignee).toBe("ChatGPT-99");
    expect(f.sql.one("SELECT assignee FROM tasks")).toEqual({ assignee: "ChatGPT-99" });
  });

  it("task_list filters by a case variant, and \"ME\" means the caller", () => {
    const f = world();
    const id = ok(f.board.act<{ task: { id: number } }>(f.ctx("Alice"), "task_create", { topic: "t", title: "w" })).value.task.id;
    ok(f.board.act(f.ctx("Alice"), "task_assign", { task: id, assignee: "ChatGPT-99" }));
    const list = (assignee: string, as = "Alice") =>
      ok(f.board.act<{ tasks: { id: number }[] }>(f.ctx(as), "task_list", { assignee })).value.tasks;
    expect(list("CHATGPT-99")).toHaveLength(1);
    expect(list("ME", "ChatGPT-99")).toHaveLength(1);
  });

  it("role_set for another user, as a coordinator", () => {
    const f = world();
    ok(f.board.act(f.ctx(ADMIN), "admin_coordinator_grant", { handle: "alice" }));
    const r = ok(f.board.act<{ user: string }>(f.ctx("Alice"), "role_set", { user: "chatgpt-99", role: "reviewing" }));
    expect(r.value.user).toBe("ChatGPT-99");
    expect(f.sql.one("SELECT role, role_set_by FROM users WHERE handle = 'ChatGPT-99'")).toEqual({
      role: "reviewing",
      role_set_by: "Alice",
    });
  });

  it("admin actions on a user: the stored spelling is in the audit row and the admin log", () => {
    const f = world();
    ok(f.board.act(f.ctx(ADMIN), "admin_coordinator_grant", { handle: "ALICE" }));
    expect(f.sql.one("SELECT is_coordinator FROM users WHERE handle = 'Alice'")).toEqual({ is_coordinator: 1 });
    const row = f.sql.one<{ target_id: string }>(
      "SELECT target_id FROM audit WHERE action = 'admin_coordinator_grant' ORDER BY seq DESC LIMIT 1",
    );
    expect(row?.target_id).toBe("Alice");
    const log = f.sql.one<{ body: string }>("SELECT body FROM messages WHERE topic = 'admin-log' ORDER BY seq DESC LIMIT 1");
    expect(log?.body).toContain("Alice");
    expect(log?.body).not.toContain("ALICE");
    expect(refused(f.board.act(f.ctx(ADMIN), "admin_coordinator_grant", { handle: "nobody" })).code).toBe("not_found");
  });

  it("admin_reinstate takes a case variant", () => {
    const f = world();
    f.sql.exec("UPDATE users SET status = 'kicked', token_hash = NULL WHERE handle = 'Alice'");
    const r = ok(f.board.act<{ handle: string }>(f.ctx(ADMIN), "admin_reinstate", { handle: "aLiCe" }));
    expect(r.value.handle).toBe("Alice");
  });

  it("join accepts the token owner's handle in any case", () => {
    const f = world();
    ok(f.board.act(f.ctx("ChatGPT-99"), "join", { handle: "chatgpt-99" }));
    expect(refused(f.board.act(f.ctx("ChatGPT-99"), "join", { handle: "alice" })).code).toBe("forbidden");
  });

  it("a mention in other case reaches the stored account, and the stored spelling is what is kept", () => {
    const f = world();
    ok(f.board.act(f.ctx("ChatGPT-99"), "join", {}));
    f.sql.exec("DELETE FROM timers WHERE kind = 'topic_announce'");
    ok(f.board.act(f.ctx("ChatGPT-99"), "inbox", {}));
    const r = ok(
      f.board.act<{ mentions: string[] }>(f.ctx("Alice"), "post", { topic: "t", body: "hello @chatgpt-99 and @CHATGPT-99" }),
    );
    expect(r.value.mentions).toEqual(["ChatGPT-99"]);
    expect(f.sql.all("SELECT handle FROM message_mentions")).toEqual([{ handle: "ChatGPT-99" }]);
    const inbox = ok(f.board.act<{ wake: { seq: number; mentions_you?: boolean }[] }>(f.ctx("ChatGPT-99"), "inbox", {}));
    expect(inbox.value.wake).toHaveLength(1);
    expect(f.sql.one("SELECT mentions FROM messages WHERE author = 'Alice' ORDER BY seq DESC LIMIT 1")).toEqual({
      mentions: JSON.stringify(["ChatGPT-99"]),
    });
    expect(f.sql.one("SELECT COUNT(*) AS n FROM users WHERE handle = 'chatgpt-99'")).toEqual({ n: 0 });
  });
});

describe("a board that already holds two spellings", () => {
  function dup(): Fixture {
    const f = makeBoard();
    f.sql.exec("INSERT INTO users (handle, kind, created_at) VALUES ('Zed', 'agent', 5)");
    f.sql.exec("INSERT INTO users (handle, kind, created_at) VALUES ('zed', 'agent', 9)");
    f.sql.exec("INSERT INTO users (handle, kind, created_at) VALUES ('ZED', 'agent', 7)");
    return f;
  }

  it("the helper prefers the exact-case match, else the oldest account", () => {
    const f = dup();
    expect(canonicalHandle(f.sql, "zed")).toBe("zed");
    expect(canonicalHandle(f.sql, "ZED")).toBe("ZED");
    expect(canonicalHandle(f.sql, "zEd")).toBe("Zed");
    expect(canonicalHandle(f.sql, "nobody")).toBeUndefined();
  });

  it("a mention resolves the same way", () => {
    const f = dup();
    f.addUser("poster");
    ok(f.board.act(f.ctx("poster"), "topic_create", { name: "t" }));
    const mention = (body: string) =>
      ok(f.board.act<{ mentions: string[] }>(f.ctx("poster"), "post", { topic: "t", body })).value.mentions;
    expect(mention("@zEd")).toEqual(["Zed"]);
    expect(mention("@zed")).toEqual(["zed"]);
  });

  it("a new account with that handle is still refused", () => {
    const f = dup();
    expect(refused(f.board.act(f.ctx(ADMIN), "admin_user_add", { handle: "zEd" })).code).toBe("exists");
  });
});

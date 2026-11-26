// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0

/**
 * `bbs_who` shows whether each session can be rung (issue #103): `wake` is
 * `adapter` while an adapter socket is open for the session, else `none`. A
 * connector's join note says the chat gets no doorbell.
 */

import { describe, expect, it } from "vitest";
import { callTool } from "../src/tools.ts";
import type { ActResult, CallContext } from "../src/types.ts";
import { makeBoard, sha256, type Fixture } from "./helpers.ts";

function ok<T>(r: ActResult<unknown>): T {
  if (!r.ok) throw new Error(`expected ok, got ${r.error.message}`);
  return r.value as T;
}

interface WhoSession {
  state: string;
  wake: string;
}

function sessionsOf(f: Fixture, handle: string): WhoSession[] {
  const r = ok<{ users: { handle: string; sessions: WhoSession[] }[] }>(f.board.act(f.ctx("watcher"), "who", {}));
  return r.users.find((u) => u.handle === handle)?.sessions ?? [];
}

function world(): { f: Fixture; session: string } {
  const f = makeBoard();
  f.addUser("watcher");
  f.addUser("worker");
  f.addUser("claude-ai");
  const session = ok<{ session: string }>(f.board.act(f.ctx("worker"), "join", {})).session;
  return { f, session };
}

describe("bbs_who wake", () => {
  it("is none for a joined session with no socket, adapter while one is attached, none after it closes", () => {
    const { f, session } = world();
    expect(sessionsOf(f, "worker").map((s) => s.wake)).toEqual(["none"]);

    const ws = { handle: "worker", via: "ws" as const, session };
    ok(f.board.socketAct({ handle: "worker", via: "ws" }, "socket_open", {}));
    ok(f.board.socketAct(ws, "socket_hello", { harness: "claude-code", state: "idle" }));
    expect(sessionsOf(f, "worker").map((s) => s.wake)).toEqual(["adapter"]);

    ok(f.board.socketAct(ws, "socket_close", { session, code: 1000 }));
    expect(sessionsOf(f, "worker").map((s) => s.wake)).toEqual(["none"]);
  });

  it("never shows a session id or its hash", () => {
    const { f, session } = world();
    ok(f.board.socketAct({ handle: "worker", via: "ws" }, "socket_open", {}));
    ok(f.board.socketAct({ handle: "worker", via: "ws", session }, "socket_hello", { state: "idle" }));
    const text = JSON.stringify(f.board.act(f.ctx("watcher"), "who", {}));
    expect(text).not.toContain(session);
    expect(text).not.toContain(sha256(session));
  });

  it("is on every session of a connector handle, none for each chat", () => {
    const { f } = world();
    const chat = (n: number): CallContext => ({
      handle: "claude-ai",
      via: "mcp",
      oauthGrant: "og_test",
      mcpSession: sha256(`mcp-${n}`),
    });
    ok(f.board.act(chat(1), "join", {}));
    ok(f.board.act(chat(2), "join", {}));
    expect(sessionsOf(f, "claude-ai").map((s) => s.wake)).toEqual(["none", "none"]);
  });
});

describe("bbs_join note", () => {
  it("a connector join says the chat gets no doorbell and still names the session argument", () => {
    const { f } = world();
    const ctx: CallContext = { handle: "claude-ai", via: "mcp", oauthGrant: "og_test" };
    const joined = callTool(f.board, ctx, "bbs_join", {}, "mcp");
    const note = String(joined.structuredContent.note);
    expect(note).toMatch(/`session`/);
    expect(note).toMatch(/no doorbell/);
    expect(note).toMatch(/bbs_inbox/);
  });

  it("a token join has no note, and says its session has no adapter yet", () => {
    const { f } = world();
    const joined = callTool(f.board, f.ctx("worker"), "bbs_join", {}, "api");
    expect(joined.structuredContent.note).toBeUndefined();
    expect(joined.structuredContent.wake).toBe("none");
  });
});

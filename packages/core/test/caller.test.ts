// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0

// B7: `act` checks that `via` fits the actor's kind and that a claimed
// session belongs to the actor.

import { describe, expect, it } from "vitest";
import { MAX_TOKEN_LENGTH } from "../src/act.ts";
import { VIAS_BY_KIND, type Via } from "../src/types.ts";
import { ADMIN, makeBoard } from "./helpers.ts";

const ALL_VIAS: Via[] = ["mcp", "ws", "api", "web", "cli", "app-typed", "app-voice", "system"];

function joinedSession(f: ReturnType<typeof makeBoard>, handle: string): string {
  const r = f.board.act<{ session: string }>(f.ctx(handle), "join", {});
  if (!r.ok) throw new Error(`join ${handle}: ${r.error.message}`);
  return r.value.session;
}

describe("via fits the actor's kind (B7)", () => {
  it.each(ALL_VIAS)("agent via %s", (via) => {
    const f = makeBoard();
    f.addUser("alice");
    const r = f.board.act({ handle: "alice", via }, "topics", {});
    const allowed = VIAS_BY_KIND.agent.includes(via);
    expect(r.ok).toBe(allowed);
    if (!allowed) {
      expect(r).toMatchObject({ result: "denied", error: { code: "forbidden" } });
      expect(f.auditRows().at(-1)).toMatchObject({
        actor: "alice",
        actor_kind: "agent",
        via,
        action: "topics",
        result: "denied",
      });
    }
  });

  it.each(ALL_VIAS)("human via %s", (via) => {
    const f = makeBoard();
    const r = f.board.act({ handle: ADMIN, via }, "topics", {});
    const allowed = VIAS_BY_KIND.human.includes(via);
    expect(r.ok).toBe(allowed);
    if (!allowed) {
      expect(f.auditRows().at(-1)).toMatchObject({
        actor: ADMIN,
        actor_kind: "human",
        via,
        result: "denied",
      });
    }
  });

  it("stores the derived via on a posted message", () => {
    const f = makeBoard();
    f.addUser("alice");
    const r = f.board.act({ handle: "alice", via: "api" }, "post", { topic: "Lobby", body: "x" });
    expect(r.ok).toBe(true);
    expect(f.sql.one("SELECT via, author_kind FROM messages WHERE author = 'alice'")).toEqual({
      via: "api",
      author_kind: "agent",
    });
  });
});

describe("a claimed session must be the actor's own (B7)", () => {
  it("accepts the actor's own session and records it on the audit row", () => {
    const f = makeBoard();
    f.addUser("alice");
    const session = joinedSession(f, "alice");
    const r = f.board.act({ handle: "alice", via: "mcp", session }, "post", {
      topic: "Lobby",
      body: "hello",
    });
    expect(r.ok).toBe(true);
    expect(f.auditRows().at(-1)).toMatchObject({ action: "post", session, result: "ok" });
  });

  it("refuses another handle's session, and an unknown one, as denied", () => {
    const f = makeBoard();
    f.addUser("alice");
    f.addUser("bob");
    const bobs = joinedSession(f, "bob");
    for (const session of [bobs, "s_made_up"]) {
      const before = f.sql.all("SELECT seq FROM messages").length;
      const r = f.board.act({ handle: "alice", via: "mcp", session }, "post", {
        topic: "Lobby",
        body: "spoof",
      });
      expect(r).toMatchObject({ ok: false, result: "denied", error: { code: "forbidden" } });
      expect(f.sql.all("SELECT seq FROM messages")).toHaveLength(before);
      expect(f.auditRows().at(-1)).toMatchObject({
        actor: "alice",
        action: "post",
        result: "denied",
      });
    }
  });
});

describe("authenticate and refuse details (M1b independent review)", () => {
  it("refuses an over-long token instead of truncating it", () => {
    const f = makeBoard();
    const token = f.addUser("alice");
    const padded = token + "x".repeat(MAX_TOKEN_LENGTH);
    expect(f.board.authenticate(padded, { via: "api" })).toMatchObject({
      ok: false,
      reason: "token_too_long",
    });
    expect(f.auditRows().at(-1)).toMatchObject({ actor: "anonymous", result: "denied" });
    expect(String(f.auditRows().at(-1)?.detail)).not.toContain(token);
  });

  it("records extra detail on a refused sign-in", () => {
    const f = makeBoard();
    f.board.authenticate("nope", { via: "api", endpoint: "/api", detail: { client: "cli" } });
    expect(JSON.parse(String(f.auditRows().at(-1)?.detail))).toMatchObject({
      client: "cli",
      endpoint: "/api",
    });
  });

  it("refuse() can carry an error code other than forbidden", () => {
    const f = makeBoard();
    f.addUser("alice");
    const r = f.board.refuse({ handle: "alice", via: "api" }, "api", "invalid JSON", {}, "bad_request");
    expect(r).toMatchObject({ ok: false, result: "denied", error: { code: "bad_request", message: "invalid JSON" } });
  });
});

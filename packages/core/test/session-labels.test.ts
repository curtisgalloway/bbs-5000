// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0

/**
 * Session labels on `bbs_join` (machine, os, model), their display in
 * `bbs_who` and admin status, the connector's default harness, and the
 * documented behavior of a second chat joining under the same handle.
 */

import { describe, expect, it } from "vitest";
import { s256 } from "../src/actions/oauth.ts";
import { callTool } from "../src/tools.ts";
import type { ActResult } from "../src/types.ts";
import { ADMIN, makeBoard, sha256, type Fixture } from "./helpers.ts";

function ok<T>(r: ActResult<unknown>): T {
  if (!r.ok) throw new Error(`expected ok, got ${r.error.message}`);
  return r.value as T;
}

interface WhoUser {
  handle: string;
  harness: string | null;
  session: string;
  machine: string | null;
  os: string | null;
  model: string | null;
}

function who(f: Fixture, as: string): WhoUser[] {
  return ok<{ users: WhoUser[] }>(f.board.act(f.ctx(as), "who", {})).users;
}

function whoOf(f: Fixture, handle: string): WhoUser {
  const u = who(f, handle).find((x) => x.handle === handle);
  if (!u) throw new Error(`no ${handle}`);
  return u;
}

function board(): Fixture {
  const f = makeBoard();
  f.addUser("alice");
  return f;
}

describe("join stores machine, os and model on the session", () => {
  it("stores each label, and bbs_who and the audit-safe join result show them", () => {
    const f = board();
    ok(f.board.act(f.ctx("alice"), "join", { machine: "workstation-1", os: "macOS", model: "claude-opus-5-5" }));
    expect(f.sql.one("SELECT machine, os, model FROM sessions")).toEqual({
      machine: "workstation-1",
      os: "macOS",
      model: "claude-opus-5-5",
    });
    expect(whoOf(f, "alice")).toMatchObject({ machine: "workstation-1", os: "macOS", model: "claude-opus-5-5", session: "idle" });
  });

  it("stores each new label alone, one at a time", () => {
    for (const label of ["os", "model", "machine"] as const) {
      const f = board();
      ok(f.board.act(f.ctx("alice"), "join", { [label]: "x" }));
      const row = f.sql.one<Record<string, string | null>>("SELECT machine, os, model FROM sessions");
      for (const k of ["machine", "os", "model"]) expect(row?.[k], `${label} ${k}`).toBe(k === label ? "x" : null);
    }
  });

  it("a re-join with its own session keeps a label it omits and replaces one it gives", () => {
    const f = board();
    const first = ok<{ session: string }>(
      f.board.act(f.ctx("alice"), "join", { machine: "workstation-1", os: "Linux", model: "gpt-5" }),
    );
    ok(f.board.act({ ...f.ctx("alice"), session: first.session }, "join", { role: "r", os: "Linux 6" }));
    expect(f.sql.one("SELECT machine, os, model FROM sessions")).toEqual({
      machine: "workstation-1",
      os: "Linux 6",
      model: "gpt-5",
    });
  });

  it("a person who is offline shows null labels", () => {
    const f = board();
    expect(whoOf(f, "alice")).toMatchObject({ session: "offline", machine: null, os: null, model: null });
    expect(who(f, ADMIN).find((u) => u.handle === ADMIN)).toMatchObject({ machine: null, os: null, model: null });
  });

  it.each(["os", "model"])("refuses a %s with a control, line-separator or bidirectional character", (key) => {
    const f = board();
    for (const bad of ["a\nb", "a\u0000b", "a b", "a‮b", "a\u007fb"]) {
      expect(f.board.act(f.ctx("alice"), "join", { [key]: bad }), JSON.stringify(bad)).toMatchObject({
        ok: false,
        error: { code: "bad_request" },
      });
    }
    expect(f.sql.one("SELECT COUNT(*) AS n FROM sessions")).toEqual({ n: 0 });
  });

  it.each(["os", "model"])("accepts a %s of 64 characters and refuses 65", (key) => {
    const f = board();
    expect(f.board.act(f.ctx("alice"), "join", { [key]: "a".repeat(65) })).toMatchObject({
      ok: false,
      error: { code: "bad_request" },
    });
    ok(f.board.act(f.ctx("alice"), "join", { [key]: "a".repeat(64) }));
  });

  it("the tool definition offers os and model, and a tool call carries them", () => {
    const f = board();
    callTool(f.board, f.ctx("alice"), "bbs_join", { os: "Windows 11", model: "gpt-5" });
    expect(whoOf(f, "alice")).toMatchObject({ os: "Windows 11", model: "gpt-5" });
  });
});

describe("admin status shows os and model beside machine", () => {
  it("returns the labels of the live session", () => {
    const f = board();
    ok(f.board.act(f.ctx("alice"), "join", { machine: "workstation-1", os: "Linux", model: "m-1" }));
    const s = ok<{ users: { handle: string; session: Record<string, unknown> | null }[] }>(
      f.board.act(f.ctx(ADMIN), "admin_status", {}),
    );
    expect(s.users.find((u) => u.handle === "alice")?.session).toMatchObject({
      machine: "workstation-1",
      os: "Linux",
      model: "m-1",
    });
  });
});

const CLIENT = "https://client.example/oauth/client.json";
const REDIRECT = "https://client.example/callback";
const RESOURCE = "https://api.example/mcp";
const VERIFIER = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ-._~0123";

/** An approved grant for `handle` through the consent calls; returns the grant id. */
function grantFor(f: Fixture, handle: string, clientName = "Claude Test"): string {
  const web = { handle: ADMIN, via: "web" as const, webSession: "ws_test" };
  const c = ok<{ request_id: string }>(
    f.board.oauthRequest(web, {
      response_type: "code",
      client_id: CLIENT,
      redirect_uri: REDIRECT,
      code_challenge: s256(sha256, VERIFIER),
      code_challenge_method: "S256",
      resource: RESOURCE,
      state: "st",
      resource_expected: RESOURCE,
      client_doc: { client_id: CLIENT, client_name: clientName, redirect_uris: [REDIRECT] },
    }),
  );
  return ok<{ grant: string }>(f.board.oauthDecide(web, { request_id: c.request_id, approve: true, handle })).grant;
}

function viaGrant(handle: string, grant: string) {
  return { handle, via: "mcp" as const, oauthGrant: grant };
}

describe("a connector's join defaults harness to the grant's client name", () => {
  it("uses the client name when the caller gives no harness", () => {
    const f = makeBoard();
    const grant = grantFor(f, "claude-ai");
    const r = ok<{ session: string }>(f.board.act(viaGrant("claude-ai", grant), "join", { role: "chat" }));
    expect(r.session).toMatch(/^s_/);
    expect(f.sql.one("SELECT harness FROM users WHERE handle = 'claude-ai'")).toEqual({ harness: "Claude Test" });
    expect(whoOf(f, "claude-ai").harness).toBe("Claude Test");
    expect(f.sql.one("SELECT body FROM messages WHERE is_system = 1 AND body LIKE 'claude-ai joined%'")).toEqual({
      body: 'claude-ai joined (agent, harness: "Claude Test", role: "chat")',
    });
    expect(JSON.parse(String(f.auditRows().filter((x) => x.action === "join").at(-1)?.detail))).toMatchObject({
      harness_default: "oauth_client",
    });
  });

  it("an explicit harness wins", () => {
    const f = makeBoard();
    const grant = grantFor(f, "claude-ai");
    ok(f.board.act(viaGrant("claude-ai", grant), "join", { harness: "claude-ai-web" }));
    expect(whoOf(f, "claude-ai").harness).toBe("claude-ai-web");
  });

  it("a client name that fails the label checks leaves harness null", () => {
    const f = makeBoard();
    const grant = grantFor(f, "claude-ai");
    f.sql.exec("UPDATE oauth_grants SET client_name = ? WHERE id = ?", "Evil‮Name", grant);
    ok(f.board.act(viaGrant("claude-ai", grant), "join", {}));
    expect(whoOf(f, "claude-ai").harness).toBeNull();
    f.sql.exec("UPDATE oauth_grants SET client_name = ? WHERE id = ?", "x".repeat(65), grant);
    ok(f.board.act(viaGrant("claude-ai", grant), "join", {}));
    expect(whoOf(f, "claude-ai").harness).toBeNull();
  });

  it("a join without a grant gets no default", () => {
    const f = makeBoard();
    grantFor(f, "claude-ai");
    ok(f.board.act(f.ctx("claude-ai"), "join", {}));
    expect(whoOf(f, "claude-ai").harness).toBeNull();
  });
});

describe("two chats under one connector handle, with no MCP session id", () => {
  it("the second chat's join adds a session and ends none; calls with no session stay unbound", () => {
    const f = makeBoard();
    const grant = grantFor(f, "claude-ai");
    const chatA = viaGrant("claude-ai", grant);

    const a = ok<{ session: string }>(f.board.act(chatA, "join", { role: "chat A", machine: "phone" }));
    const b = ok<{ session: string }>(f.board.act(chatA, "join", { role: "chat B" }));
    expect(b.session).not.toBe(a.session);
    expect(f.sql.one("SELECT state FROM sessions WHERE id = ?", a.session)).toEqual({ state: "idle" });
    expect(f.sql.one("SELECT state FROM sessions WHERE id = ?", b.session)).toEqual({ state: "idle" });
    const joins = f.auditRows().filter((r) => r.action === "join");
    expect(JSON.parse(String(joins.at(-1)?.detail)).replaced_sessions).toEqual([]);

    expect(f.board.act(chatA, "topics", {}).ok).toBe(true);
    expect(f.board.act(chatA, "inbox", {}).ok).toBe(true);

    expect(f.sql.one("SELECT role FROM users WHERE handle = 'claude-ai'")).toEqual({ role: "chat B" });

    expect(f.board.act({ ...chatA, session: a.session }, "topics", {}).ok).toBe(true);
    expect(f.board.act({ ...chatA, session: b.session }, "topics", {}).ok).toBe(true);
  });
});

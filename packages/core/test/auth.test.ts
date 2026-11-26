// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { ADMIN, ADMIN_TOKEN, makeBoard, sha256 } from "./helpers.ts";

describe("bootstrapHuman", () => {
  it("creates the first human admin once and audits it", () => {
    const f = makeBoard();
    const user = f.sql.one("SELECT handle, kind, is_admin, token_hash FROM users");
    expect(user).toEqual({
      handle: ADMIN,
      kind: "human",
      is_admin: 1,
      token_hash: sha256(ADMIN_TOKEN),
    });
    expect(f.auditRows()).toHaveLength(1);
  });

  it("is a no-op, with no audit row, when nothing changes", () => {
    const f = makeBoard();
    const again = f.board.bootstrapHuman(ADMIN, sha256(ADMIN_TOKEN));
    expect(again).toMatchObject({ ok: true, value: { created: false, changed: false } });
    expect(f.auditRows()).toHaveLength(1);
  });

  it("rotates the credential with an audit row", () => {
    const f = makeBoard();
    const r = f.board.bootstrapHuman(ADMIN, sha256("new-credential"));
    expect(r).toMatchObject({ ok: true, value: { changed: true } });
    const last = f.auditRows().at(-1);
    expect(JSON.parse(String(last?.detail))).toMatchObject({ credential_rotated: true });
    expect(f.board.authenticate(ADMIN_TOKEN, { via: "cli" }).ok).toBe(false);
    expect(f.board.authenticate("new-credential", { via: "cli" })).toMatchObject({
      ok: true,
      handle: ADMIN,
    });
  });

  it("refuses to turn an agent into a human", () => {
    const f = makeBoard();
    f.addUser("bot");
    const r = f.board.bootstrapHuman("bot", sha256("x"));
    expect(r).toMatchObject({ ok: false, result: "denied" });
    expect(f.sql.one("SELECT kind FROM users WHERE handle = 'bot'")).toEqual({
      kind: "agent",
    });
  });

  it("refuses a second admin whose handle differs only in case", () => {
    const f = makeBoard();
    const r = f.board.bootstrapHuman("OWNER", sha256("other-credential"));
    expect(r).toMatchObject({ ok: false, error: { code: "exists" } });
    expect(f.sql.all("SELECT handle FROM users")).toEqual([{ handle: ADMIN }]);
  });

  it("rejects a malformed token hash", () => {
    const f = makeBoard();
    expect(f.board.bootstrapHuman("someone", "not-a-hash")).toMatchObject({
      ok: false,
      error: { code: "bad_request" },
    });
  });
});

describe("authenticate", () => {
  it("resolves a valid token to its user without writing anything", () => {
    const f = makeBoard();
    const token = f.addUser("alice");
    const before = f.auditRows().length;
    expect(f.board.authenticate(token, { via: "mcp" })).toEqual({
      ok: true,
      handle: "alice",
      kind: "agent",
    });
    expect(f.auditRows()).toHaveLength(before);
  });

  it.each([
    ["missing", undefined, "missing_token"],
    ["empty", "", "missing_token"],
    ["unknown", "bbs_not-a-real-token", "unknown_token"],
  ])("denies a %s token and audits it as anonymous", (_label, token, reason) => {
    const f = makeBoard();
    const r = f.board.authenticate(token, { via: "mcp", requestId: "r1", endpoint: "/mcp" });
    expect(r).toMatchObject({ ok: false, reason });
    const last = f.auditRows().at(-1);
    expect(last).toMatchObject({
      actor: "anonymous",
      actor_kind: "anonymous",
      action: "auth",
      result: "denied",
      request_id: "r1",
      via: "mcp",
    });
    expect(JSON.parse(String(last?.detail))).toMatchObject({
      code: "unauthorized",
      endpoint: "/mcp",
    });
  });

  it("denies a kicked user's token and records the handle", () => {
    const f = makeBoard();
    const token = f.addUser("alice");
    f.sql.exec("UPDATE users SET status = 'kicked' WHERE handle = 'alice'");
    expect(f.board.authenticate(token, { via: "ws" })).toMatchObject({
      ok: false,
      reason: "revoked_token",
    });
    expect(f.auditRows().at(-1)).toMatchObject({
      actor: "alice",
      result: "denied",
      action: "auth",
    });
  });

  it("never stores a token, only its hash", () => {
    const f = makeBoard();
    const token = f.addUser("alice");
    f.board.authenticate("bbs_wrong-guess", { via: "mcp" });
    const dump = JSON.stringify(f.sql.all("SELECT * FROM audit"));
    expect(dump).not.toContain(token);
    expect(dump).not.toContain("bbs_wrong-guess");
    expect(dump).not.toContain(ADMIN_TOKEN);
    const stored = f.sql.one("SELECT token_hash FROM users WHERE handle = 'alice'");
    expect(stored).toEqual({ token_hash: sha256(token) });
  });
});

describe("admin_user_add", () => {
  it("lets a human admin create an agent and returns a fresh token", () => {
    const f = makeBoard();
    const r = f.board.act<{ handle: string; kind: string; token: string }>(
      f.ctx(ADMIN, "cli"),
      "admin_user_add",
      { handle: "builder", role: "build agent" },
    );
    if (!r.ok) throw new Error(r.error.message);
    expect(r.value.kind).toBe("agent");
    expect(r.value.token).toMatch(/^bbs_[A-Za-z0-9_-]{43}$/);
    expect(f.auditRows().at(-1)).toMatchObject({
      actor: ADMIN,
      actor_kind: "human",
      action: "admin_user_add",
      target_type: "user",
      target_id: "builder",
      result: "ok",
    });
  });

  it("issues different tokens to different users", () => {
    const f = makeBoard();
    expect(f.addUser("a1")).not.toBe(f.addUser("a2"));
  });

  it("can create a non-admin human", () => {
    const f = makeBoard();
    f.addUser("person", "human");
    expect(f.sql.one("SELECT kind, is_admin FROM users WHERE handle = 'person'")).toEqual({
      kind: "human",
      is_admin: 0,
    });
  });

  it("is denied to agents, coordinators and non-admin humans, and audited", () => {
    const f = makeBoard();
    f.addUser("agent1");
    f.addUser("person", "human");
    f.sql.exec("UPDATE users SET is_coordinator = 1 WHERE handle = 'agent1'");
    for (const who of ["agent1", "person"]) {
      const r = f.board.act(f.ctx(who), "admin_user_add", { handle: "sneaky" });
      expect(r).toMatchObject({ ok: false, result: "denied", error: { code: "forbidden" } });
      expect(f.auditRows().at(-1)).toMatchObject({ actor: who, result: "denied" });
    }
    expect(f.sql.one("SELECT handle FROM users WHERE handle = 'sneaky'")).toBeUndefined();
  });

  it("rejects duplicate (case-insensitive), reserved and malformed handles", () => {
    const f = makeBoard();
    f.addUser("alice");
    for (const handle of ["alice", "ALICE", "system", "anonymous", "me", "Me", "has space", "", "-x"]) {
      const r = f.board.act(f.ctx(ADMIN, "cli"), "admin_user_add", { handle });
      expect(r.ok, handle).toBe(false);
    }
  });
});

// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0

/**
 * The `act` contract: one audit row per change action (A1.4), denied and
 * failed actions audited and rolled back (A1.5), and no write outside
 * `act`'s transaction (the guard test, plan M1a step 5).
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PUBLIC_ACTIONS } from "../src/act.ts";
import { s256 } from "../src/actions/oauth.ts";
import type { SqlValue } from "../src/sql.ts";
import type { CallContext } from "../src/types.ts";
import { ADMIN, isWrite, makeBoard, RecordingSql, sha256, type Fixture } from "./helpers.ts";

const SRC = join(import.meta.dirname, "..", "src");

function sourceFiles(dir = SRC): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? sourceFiles(join(dir, e.name)) : [join(dir, e.name)],
  );
}

/** Every public action once, with expected audit actor/target. */
function scenario(f: Fixture) {
  // M5: a kicked user to reinstate (set up directly; the kick itself is M4a's).
  if (!f.sql.one("SELECT handle FROM users WHERE handle = 'erin'")) {
    f.addUser("erin");
    f.sql.exec("UPDATE users SET status = 'kicked', token_hash = NULL WHERE handle = 'erin'");
  }
  // Issue #98: a session handle to retire (made directly; the join that makes one is its own test).
  if (!f.sql.one("SELECT handle FROM users WHERE handle = 'erin-zz9z'")) {
    f.sql.exec("INSERT INTO users (handle, kind, created_at, parent, harness_session) VALUES ('erin-zz9z', 'agent', 1, 'erin', 'hs-scenario')");
  }
  // Issue #47: a pairing to look up and approve, and a web session to sign out.
  const pairing = f.board.webPairStart({ source: "scenario", label: "Chrome on macOS" });
  if (!pairing.ok) throw new Error("web_pair_start failed");
  const code = pairing.value.code;
  if (!f.sql.one("SELECT id FROM web_sessions WHERE id = 'ws_scenario'")) {
    f.sql.exec(
      `INSERT INTO web_sessions (id, handle, token_hash, label, created_at, renewed_at, expires_at)
       VALUES ('ws_scenario', ?, 'scenario-hash', 'Chrome', 1, 1, ?)`,
      ADMIN,
      f.clock.t + 60_000,
    );
  }
  // Issue #55: a connector approval to list and revoke.
  if (!f.sql.one("SELECT id FROM oauth_grants WHERE id = 'og_scenario'")) {
    f.sql.exec(
      `INSERT INTO oauth_grants (id, client_id, client_name, client_host, handle, approved_by, created_at, renewed_at, expires_at)
       VALUES ('og_scenario', 'https://c.example/id', 'C', 'c.example', ?, ?, 1, 1, ?)`,
      ADMIN,
      ADMIN,
      f.clock.t + 60_000,
    );
  }
  // Issue #54: a passkey to list and remove.
  if (!f.sql.one("SELECT id FROM passkeys WHERE id = 'pk_scenario'")) {
    f.sql.exec(
      `INSERT INTO passkeys (id, handle, credential_id, public_key, alg, sign_count, backup_eligible, backup_state, label, created_at)
       VALUES ('pk_scenario', ?, 'cred-scenario', '{}', 'ES256', 0, 0, 0, 'Key', 1)`,
      ADMIN,
    );
  }
  // Issue #54: an approval request to ask the status of.
  if (!f.sql.one("SELECT id FROM approvals WHERE id = 'ap_scenario'")) {
    f.sql.exec(
      `INSERT INTO approvals (id, id_hash, handle, action, ref, target, scope, nonce, match_code, requested_via, created_at, expires_at)
       VALUES ('ap_scenario', ?, ?, 'passkey_remove', 'pk_other', 'passkey_remove:pk_other', '{}', 'n', 'ABCDEF', 'cli', 1, ?)`,
      sha256("ap-scenario-secret"),
      ADMIN,
      f.clock.t + 60_000,
    );
  }
  const items: {
    as: string;
    action: string;
    params: unknown;
    target: [string, string | null];
    audited: boolean;
    ctx?: CallContext;
  }[] = [
    { as: "alice", action: "join", params: { role: "r" }, target: ["session", null], audited: true },
    { as: "alice", action: "topic_create", params: { name: "t" }, target: ["topic", "t"], audited: true },
    { as: "bob", action: "post", params: { topic: "t", body: "hi" }, target: ["message", null], audited: true },
    { as: "alice", action: "subscribe", params: { topic: "Lobby", level: "wake" }, target: ["subscription", "alice:Lobby"], audited: true },
    { as: "alice", action: "role_set", params: { role: "lead" }, target: ["user", "alice"], audited: true },
    { as: "alice", action: "inbox", params: {}, target: ["user", "alice"], audited: true },
    { as: ADMIN, action: "admin_user_add", params: { handle: "carol" }, target: ["user", "carol"], audited: true },
    { as: "alice", action: "read", params: { topic: "t" }, target: ["topic", "t"], audited: false },
    { as: "alice", action: "topics", params: {}, target: ["topic", null], audited: false },
    { as: "alice", action: "who", params: {}, target: ["topic", null], audited: false },
    { as: "alice", action: "task_create", params: { topic: "t", title: "a" }, target: ["task", "1"], audited: true },
    { as: "alice", action: "task_create", params: { topic: "t", title: "b" }, target: ["task", "2"], audited: true },
    { as: "alice", action: "task_assign", params: { task: 1, assignee: "alice" }, target: ["task", "1"], audited: true },
    { as: "alice", action: "task_claim", params: { task: 2 }, target: ["task", "2"], audited: true },
    { as: "alice", action: "task_update", params: { task: 1, state: "in_progress" }, target: ["task", "1"], audited: true },
    { as: "alice", action: "task_comment", params: { task: 1, body: "x" }, target: ["task", "1"], audited: true },
    { as: "alice", action: "task_block", params: { task: 1, blocked_by: [2] }, target: ["task", "1"], audited: true },
    { as: "alice", action: "task_unblock", params: { task: 1, blocked_by: 2 }, target: ["task", "1"], audited: true },
    { as: "alice", action: "task_list", params: {}, target: ["task", null], audited: false },
    { as: ADMIN, action: "audit", params: {}, target: ["audit", "(none)"], audited: true },
    // M5: human admin powers, and whoami (a read).
    { as: ADMIN, action: "admin_reinstate", params: { handle: "erin" }, target: ["user", "erin"], audited: true },
    { as: ADMIN, action: "admin_session_handle_retire", params: { handle: "erin-zz9z" }, target: ["user", "erin-zz9z"], audited: true },
    { as: ADMIN, action: "admin_coordinator_grant", params: { handle: "carol" }, target: ["user", "carol"], audited: true },
    { as: ADMIN, action: "admin_coordinator_remove", params: { handle: "carol" }, target: ["user", "carol"], audited: true },
    { as: "alice", action: "whoami", params: {}, target: ["user", "alice"], audited: false },
    // G5: the human admin's board-health read.
    { as: ADMIN, action: "admin_status", params: {}, target: ["board", null], audited: false },
    { as: "alice", action: "topic_mark_read", params: { topic: "t", through_seq: 1_000 }, target: ["subscription", "alice:t"], audited: true },
    // M6b: archiving, by the human admin (tasks 1 and 2 are still unfinished, so force).
    { as: ADMIN, action: "topic_keep", params: { topic: "t", on: true }, target: ["topic", "t"], audited: true },
    { as: ADMIN, action: "topic_describe", params: { topic: "t", description: "Repos: a" }, target: ["topic", "t"], audited: true },
    { as: ADMIN, action: "topic_archive", params: { topic: "t", reason: "done", force: true }, target: ["topic", "t"], audited: true },
    { as: ADMIN, action: "topic_unarchive", params: { topic: "t" }, target: ["topic", "t"], audited: true },
    // Issue #47: web sign-in by pairing code (start, claim and renew are not tools).
    { as: ADMIN, action: "web_pairing_show", params: { code }, target: ["web_pairing", null], audited: false },
    { as: ADMIN, action: "web_pairing_approve", params: { code }, target: ["web_pairing", null], audited: true },
    { as: ADMIN, action: "web_sessions", params: {}, target: ["user", ADMIN], audited: false },
    {
      as: ADMIN,
      action: "web_sign_out",
      params: {},
      target: ["web_session", "ws_scenario"],
      audited: true,
      ctx: { handle: ADMIN, via: "web", webSession: "ws_scenario" },
    },
    { as: ADMIN, action: "web_session_revoke", params: { all: true }, target: ["user", ADMIN], audited: true },
    // Issue #54: an approval's status (a read; a request is made by the gated actions).
    { as: ADMIN, action: "approval_status", params: { approval: "ap-scenario-secret" }, target: ["approval", "ap_scenario"], audited: false },
    // Issue #54: passkeys (registration and sign-in are not tools).
    { as: ADMIN, action: "passkeys", params: {}, target: ["user", ADMIN], audited: false },
    { as: ADMIN, action: "passkey_remove", params: { id: "pk_scenario" }, target: ["passkey", "pk_scenario"], audited: true },
    // Issue #55: connector approvals (the request, decision and token calls are not tools).
    { as: ADMIN, action: "oauth_grants", params: {}, target: ["user", ADMIN], audited: false },
    { as: ADMIN, action: "oauth_grant_revoke", params: { id: "og_scenario" }, target: ["oauth_grant", "og_scenario"], audited: true },
  ];
  return items.map((s) => ({ ...s, ctx: s.ctx ?? f.ctx(s.as) }));
}

describe("act", () => {
  it("covers every public action in the scenario", () => {
    const f = makeBoard();
    expect([...new Set(scenario(f).map((s) => s.action))].sort()).toEqual(
      Object.keys(PUBLIC_ACTIONS).sort(),
    );
  });

  it("writes exactly one audit row per change action, with actor and target (A1.4)", () => {
    const f = makeBoard();
    f.addUser("alice");
    f.addUser("bob");
    ok(f.board.act(f.ctx("bob"), "join", {}));
    for (const s of scenario(f)) {
      const before = f.auditRows().length;
      const r = f.board.act(s.ctx, s.action, s.params);
      expect(r.ok, `${s.action}: ${r.ok ? "" : r.error.message}`).toBe(true);
      const rows = f.auditRows().slice(before);
      expect(rows, s.action).toHaveLength(s.audited ? 1 : 0);
      if (!s.audited) continue;
      const row = rows[0];
      expect(row).toMatchObject({
        actor: s.as,
        action: s.action,
        result: "ok",
        target_type: s.target[0],
      });
      if (s.target[1] === "(none)") expect(row?.target_id).toBeNull();
      else if (s.target[1] !== null) expect(row?.target_id).toBe(s.target[1]);
      else expect(row?.target_id).not.toBeNull();
      expect(r.auditSeq).toBe(row?.seq);
    }
  });

  it("audits reads when the debug flag names the user or the topic (design §13)", () => {
    for (const config of [
      { debugAuditReads: { handles: ["alice"], topics: [] } },
      { debugAuditReads: { handles: [], topics: ["t"] } },
    ]) {
      const f = makeBoard({ config });
      f.addUser("alice");
      ok(f.board.act(f.ctx("alice"), "topic_create", { name: "t" }));
      const before = f.auditRows().length;
      ok(f.board.act(f.ctx("alice"), "read", { topic: "t" }));
      expect(f.auditRows().slice(before)).toEqual([
        expect.objectContaining({ action: "read", topic: "t", result: "ok" }),
      ]);
    }
  });

  it("rolls back a failed action and audits it with the reason (A1.5)", () => {
    const f = makeBoard();
    f.addUser("alice");
    const joined = f.board.act<{ session: string }>(f.ctx("alice"), "join", {});
    if (!joined.ok) throw new Error("join failed");
    const session = joined.value.session;
    const messages = f.sql.all("SELECT * FROM messages");
    const before = f.auditRows().length;
    const r = f.board.act(
      { handle: "alice", via: "mcp", session, requestId: "req-1" },
      "post",
      { topic: "missing", body: "x" },
    );
    expect(r).toMatchObject({ ok: false, result: "error", error: { code: "not_found" } });
    expect(f.sql.all("SELECT * FROM messages")).toEqual(messages);
    const rows = f.auditRows().slice(before);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actor: "alice",
      actor_kind: "agent",
      action: "post",
      result: "error",
      session,
      request_id: "req-1",
    });
    expect(JSON.parse(String(rows[0]?.detail))).toEqual({
      code: "not_found",
      reason: "no topic named #missing",
    });
  });

  it("rolls back writes made before a fault partway through an action", () => {
    let armed = false;
    const f = makeBoard({
      wrap: (raw) =>
        new (class extends RecordingSql {
          override exec(sql: string, ...params: SqlValue[]): void {
            if (armed && sql.includes("INSERT INTO subscriptions")) {
              throw new Error("disk on fire");
            }
            super.exec(sql, ...params);
          }
        })(raw),
    });
    f.addUser("alice");
    armed = true;
    const r = f.board.act(f.ctx("alice"), "topic_create", { name: "t" });
    armed = false;
    expect(r).toMatchObject({
      ok: false,
      result: "error",
      error: { code: "internal", message: "internal error" },
    });
    expect(f.sql.one("SELECT name FROM topics WHERE name = 't'")).toBeUndefined();
    const row = f.auditRows().at(-1);
    expect(row).toMatchObject({ action: "topic_create", result: "error", actor: "alice" });
    expect(JSON.parse(String(row?.detail))).toMatchObject({
      code: "internal",
      internal: "disk on fire",
    });
    expect(f.board.verifyAudit().ok).toBe(true);
  });

  it("audits an unknown action as an error and an internal fault without leaking it", () => {
    const f = makeBoard();
    f.addUser("alice");
    expect(f.board.act(f.ctx("alice"), "drop_tables", {})).toMatchObject({
      ok: false,
      error: { code: "unknown_action" },
    });
    expect(f.board.act(f.ctx("alice"), "toString", {})).toMatchObject({
      ok: false,
      error: { code: "unknown_action" },
    });
    expect(f.board.act(f.ctx("alice"), "bootstrap_human", {})).toMatchObject({
      ok: false,
      error: { code: "unknown_action" },
    });
    expect(f.auditRows().at(-1)).toMatchObject({ action: "bootstrap_human", result: "error" });
  });

  it("returns notification work for posts and joins, and none for reads", () => {
    const f = makeBoard();
    f.addUser("alice");
    const j = f.board.act(f.ctx("alice"), "join", {});
    expect(j.ok && j.notifications).toEqual([
      expect.objectContaining({ type: "message", topic: "Lobby", author: "system", isSystem: true }),
    ]);
    ok(f.board.act(f.ctx("alice"), "topic_create", { name: "t" }));
    const p = f.board.act(f.ctx("alice"), "post", { topic: "t", body: "hi @alice" });
    expect(p.ok && p.notifications).toEqual([
      { type: "message", topic: "t", seq: expect.any(Number), author: "alice", mentions: ["alice"], isSystem: false },
    ]);
    const r = f.board.act(f.ctx("alice"), "read", { topic: "t" });
    expect(r.ok && r.notifications).toEqual([]);
  });

  it("creates the Lobby in the migration, before any action", () => {
    const f = makeBoard();
    expect(f.sql.one("SELECT name, created_by FROM topics")).toEqual({
      name: "Lobby",
      created_by: "system",
    });
  });

  it("records a kicked user's real kind on the denied audit row", () => {
    const f = makeBoard();
    f.addUser("alice");
    f.sql.exec("UPDATE users SET status = 'kicked' WHERE handle = 'alice'");
    expect(f.board.act(f.ctx("alice"), "topics", {})).toMatchObject({
      ok: false,
      result: "denied",
      error: { code: "unauthorized" },
    });
    expect(f.auditRows().at(-1)).toMatchObject({
      actor: "alice",
      actor_kind: "agent",
      action: "topics",
      result: "denied",
    });
  });

  it("refuse() audits a refused action as denied without running it", () => {
    const f = makeBoard();
    const r = f.board.refuse(f.ctx(ADMIN), "admin_user_add", "not offered on mcp", {
      surface: "mcp",
    });
    expect(r).toMatchObject({ ok: false, result: "denied", error: { code: "forbidden" } });
    expect(f.auditRows().at(-1)).toMatchObject({
      actor: ADMIN,
      actor_kind: "human",
      action: "admin_user_add",
      result: "denied",
    });
    expect(JSON.parse(String(f.auditRows().at(-1)?.detail))).toMatchObject({ surface: "mcp" });
  });

  it("updates last_seen for the actor", () => {
    const f = makeBoard();
    f.addUser("alice");
    f.clock.advance(5000);
    ok(f.board.act(f.ctx("alice"), "topics", {}));
    expect(f.sql.one("SELECT last_seen FROM users WHERE handle = 'alice'")).toEqual({
      last_seen: f.clock.t,
    });
  });
});

describe("guard: no table is written outside act", () => {
  it("every write statement runs inside a transaction", () => {
    let rec: RecordingSql | undefined;
    const f = makeBoard({
      wrap: (raw) => {
        rec = new RecordingSql(raw);
        return rec;
      },
    });
    if (!rec) throw new Error("no recorder");
    f.addUser("alice");
    f.addUser("bob");
    for (const s of scenario(f)) f.board.act(s.ctx, s.action, s.params);
    // Failures and denials too.
    f.board.act(f.ctx("alice"), "post", { topic: "missing", body: "x" });
    f.board.act(f.ctx("alice"), "audit", {});
    f.board.act(f.ctx("ghost"), "join", {});
    f.board.authenticate("bad", { via: "mcp" });
    f.board.authenticate(f.tokens.get("alice"), { via: "mcp" });
    f.board.bootstrapHuman(ADMIN, "0".repeat(64));
    // M4a: a Lobby flood (refusal + follow-up), a mute, its timer, a kick,
    // and a circuit breaker trip (post + follow-up).
    for (let round = 0; round < 3; round++) {
      for (let i = 0; i < 7; i++) f.board.act(f.ctx("bob"), "post", { topic: "Lobby", body: `b${round}-${i}` });
      f.clock.advance(61 * 60_000);
      f.board.runDueTimers();
      f.clock.advance(-50 * 60_000);
    }
    expect(f.sql.one("SELECT status FROM users WHERE handle = 'bob'")).toEqual({ status: "kicked" });
    f.addUser("dave");
    f.board.act(f.ctx("alice"), "subscribe", { topic: "t", level: "wake" });
    for (let i = 0; i < 12; i++) f.board.act(f.ctx(i % 2 ? "dave" : "alice"), "post", { topic: "t", body: "x" });
    expect(f.sql.one("SELECT COUNT(*) AS n FROM audit WHERE action = 'circuit_breaker'")).toEqual({ n: 1 });
    for (let i = 0; i < 25; i++) f.board.authenticate(`bad-${i}`, { via: "mcp", source: "s" });
    // M5: reinstate the kicked agent; then a new BBS_HUMAN_HANDLE retires the old admin (B17).
    f.board.act(f.ctx(ADMIN), "admin_reinstate", { handle: "bob", coordinator: true });
    f.board.bootstrapHuman("owner2", sha256("another credential"));
    f.board.bootstrapHuman("owner2", sha256("another credential"));
    // Issue #47: the web sign-in paths (pairing, claim, session use and renewal, refusals, pruning).
    const pair = f.board.webPairStart({ source: "guard", label: "Chrome" });
    if (!pair.ok) throw new Error("web_pair_start failed");
    f.board.webPairClaim({ pollSecret: pair.value.poll_secret, source: "guard" });
    f.board.act(f.ctx("owner2", "cli"), "web_pairing_approve", { code: pair.value.code });
    f.board.act(f.ctx("owner2", "cli"), "web_pairing_approve", { code: "ZZZZ-ZZZZ" });
    f.board.webPairClaim({ pollSecret: pair.value.poll_secret, source: "guard" });
    f.board.webPairClaim({ pollSecret: "nope", source: "guard" });
    const web = f.board.webPairClaim({ pollSecret: pair.value.poll_secret, source: "guard" });
    expect(web.ok).toBe(false);
    for (let i = 0; i < 6; i++) f.board.webPairStart({ source: "guard-flood" });
    f.board.authenticateWebSession("not a session", { source: "guard" });
    // Issue #55: the OAuth paths (request, refused and approved decisions, exchange, a replayed code,
    // refresh, a replayed refresh token, use of an access token, revoke, refusals and pruning).
    oauthGuardFlow(f);
    f.clock.advance(2 * 24 * 60 * 60_000);
    f.board.runDueTimers();

    const writes = rec.log.filter((s) => s.write);
    expect(writes.length).toBeGreaterThan(20);
    expect(writes.filter((s) => !s.inTransaction)).toEqual([]);
    // Every transaction after migration wrote exactly one audit row, or none
    // (an unaudited read).
    const perTx = new Map<number, number>();
    for (const s of writes) {
      if (/^\s*INSERT INTO audit\b/.test(s.sql)) {
        perTx.set(s.transaction, (perTx.get(s.transaction) ?? 0) + 1);
      }
    }
    expect([...perTx.values()].every((n) => n === 1)).toBe(true);
    // A transaction with no audit row (an unaudited read) may write only the
    // actor's last_seen and renew the actor's task leases (design §8: any
    // call from the assignee). The migration transaction (DDL) is the exception.
    const housekeeping = [
      "UPDATE users SET last_seen = ? WHERE handle = ?",
      "UPDATE tasks SET lease_expires_at = ? WHERE assignee = ? AND state = 'in_progress'",
      // A call made with a connector's access token marks its grant used (issue #55).
      "UPDATE oauth_grants SET last_used_at = ? WHERE id = ?",
    ];
    const byTx = new Map<number, string[]>();
    for (const s of writes) byTx.set(s.transaction, [...(byTx.get(s.transaction) ?? []), s.sql]);
    let unaudited = 0;
    for (const [tx, stmts] of byTx) {
      if (perTx.has(tx) || stmts.some((q) => q.startsWith("CREATE TABLE"))) continue;
      unaudited += 1;
      expect(stmts.filter((q) => !housekeeping.includes(q)), `transaction ${tx}`).toEqual([]);
    }
    expect(unaudited).toBeGreaterThan(0);
  });

  it("classifies CTE-led writes as writes", () => {
    expect(isWrite("WITH x AS (SELECT 1) INSERT INTO users SELECT * FROM x")).toBe(true);
    expect(isWrite("  with x as (select 1) delete from audit")).toBe(true);
    expect(isWrite("WITH x AS (SELECT 1) SELECT * FROM x")).toBe(false);
    expect(isWrite("SELECT * FROM users")).toBe(false);
  });

  it("only act.ts and the migration open transactions", () => {
    const openers = sourceFiles()
      .filter((p) => /\.transaction\(/.test(readFileSync(p, "utf8")))
      .map((p) => p.slice(SRC.length + 1))
      .sort();
    expect(openers).toEqual(["act.ts", "schema.ts"]);
  });

  it("actions never call act or open their own transaction", () => {
    for (const p of sourceFiles(join(SRC, "actions"))) {
      const text = readFileSync(p, "utf8");
      expect(text, p).not.toMatch(/\.transaction\(|\.act\(/);
    }
  });

  it("core imports nothing from Cloudflare, wrangler, or Node outside its two Node entry points", () => {
    for (const p of sourceFiles()) {
      const text = readFileSync(p, "utf8");
      expect(text, p).not.toMatch(/from\s+["'](cloudflare:|wrangler|@cloudflare\/)/);
      if (!p.endsWith("node-sqlite.ts") && !p.endsWith("local-dir-sink.ts")) {
        expect(text, p).not.toMatch(/from\s+["']node:/);
      }
    }
  });
});

/** Drive every OAuth write path once as the human admin `owner2`, for the write guard. */
function oauthGuardFlow(f: Fixture): void {
  const client = "https://client.example/id.json";
  const redirect = "https://client.example/cb";
  const resource = "https://api.example/mcp";
  const verifier = "v".repeat(43);
  const web = { handle: "owner2", via: "web" as const };
  const authorize = (over: Record<string, unknown> = {}) =>
    f.board.oauthRequest(web, {
      response_type: "code",
      client_id: client,
      redirect_uri: redirect,
      code_challenge: s256(sha256, verifier),
      code_challenge_method: "S256",
      resource,
      resource_expected: resource,
      client_doc: { client_id: client, client_name: "C", redirect_uris: [redirect] },
      ...over,
    });
  const signIn = (handle: string) => {
    const req = authorize();
    if (!req.ok) throw new Error("oauth_request failed");
    const decided = f.board.oauthDecide(web, { request_id: (req.value as { request_id: string }).request_id, approve: true, handle });
    if (!decided.ok) throw new Error("oauth_decide failed");
    return decided.value as { code: string; grant: string };
  };
  const exchange = (code: string) =>
    f.board.oauthToken({
      params: { grant_type: "authorization_code", code, code_verifier: verifier, client_id: client, redirect_uri: redirect, resource },
      resource,
      source: "guard",
    });
  // A denied request, a refused one, a request that goes back to the client with an error.
  const denied = authorize();
  if (denied.ok) f.board.oauthDecide(web, { request_id: (denied.value as { request_id: string }).request_id, approve: false });
  authorize({ redirect_uri: "https://elsewhere.example/cb" });
  authorize({ code_challenge_method: "plain" });
  f.board.oauthDecide(web, { request_id: "unknown", approve: true, handle: "conn" });
  // Exchange, a replayed code (the grant ends), refused exchanges.
  const first = signIn("conn");
  const tokens = exchange(first.code);
  if (!tokens.ok) throw new Error("oauth exchange failed");
  exchange(first.code);
  exchange("unknown");
  // A second grant: use, refresh, a replayed refresh token, the client's revoke.
  const second = signIn("conn");
  const pair = exchange(second.code);
  if (!pair.ok) throw new Error("oauth exchange failed");
  f.board.authenticate(pair.value.access_token, { via: "mcp", source: "guard", accessToken: true });
  f.board.act({ handle: "conn", via: "mcp", oauthGrant: second.grant }, "topics", {});
  const r1 = f.board.oauthToken({
    params: { grant_type: "refresh_token", refresh_token: pair.value.refresh_token, client_id: client, resource },
    resource,
    source: "guard",
  });
  if (!r1.ok) throw new Error("oauth refresh failed");
  f.board.act({ handle: "conn", via: "mcp", oauthGrant: second.grant }, "post", { topic: "Lobby", body: "hello" });
  f.board.oauthToken({
    params: { grant_type: "refresh_token", refresh_token: pair.value.refresh_token, client_id: client, resource },
    resource,
    source: "guard",
  });
  f.board.oauthRevoke({ token: "unknown", clientId: client, source: "guard" });
  const third = signIn("conn");
  const last = exchange(third.code);
  if (!last.ok) throw new Error("oauth exchange failed");
  f.board.oauthRevoke({ token: last.value.refresh_token, clientId: client, source: "guard" });
  signIn("conn");
}

function ok(r: { ok: boolean; error?: { message: string } }): void {
  if (!r.ok) throw new Error(`expected ok, got ${r.error?.message}`);
}

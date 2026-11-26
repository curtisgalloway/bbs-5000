// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0

// M5: human accounts. Bootstrap rotation (B17), `kind` fixed at creation,
// the human admin's powers (reinstate with B33/B35, coordinator grant and
// remove) refused for every agent including a coordinator, `via` per kind,
// whoami, and `read` with `tail`.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PUBLIC_ACTIONS } from "../src/act.ts";
import { callTool, TOOLS } from "../src/tools.ts";
import type { ActResult } from "../src/types.ts";
import { ADMIN, ADMIN_TOKEN, makeBoard, sha256, type Fixture } from "./helpers.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;

function ok<T>(r: ActResult<T>): Extract<ActResult<T>, { ok: true }> {
  if (!r.ok) throw new Error(`expected ok, got ${r.error.code}: ${r.error.message}`);
  return r;
}

function fail(r: ActResult): Extract<ActResult, { ok: false }> {
  if (r.ok) throw new Error("expected a refusal");
  return r;
}

function user(f: Fixture, h: string): Record<string, unknown> | undefined {
  return f.sql.one("SELECT handle, kind, is_admin, is_coordinator, status, token_hash FROM users WHERE handle = ?", h);
}

/** Kick an agent the way M4a does: three Lobby floods within 24 hours. */
function kick(f: Fixture, h: string): void {
  const flood = (): void => {
    for (let i = 0; i < 50; i++) {
      if (!f.board.act(f.ctx(h), "post", { topic: "Lobby", body: `m${i}` }).ok) return;
    }
    throw new Error("never refused");
  };
  flood();
  f.clock.advance(11 * MIN);
  flood();
  f.clock.advance(HOUR + MIN);
  f.board.runDueTimers();
  flood();
  expect(user(f, h)?.status).toBe("kicked");
}

describe("bootstrap rotation (B17)", () => {
  it("a new BBS_HUMAN_HANDLE retires the earlier admin: flag cleared, credential revoked, audited", () => {
    const f = makeBoard();
    const before = f.auditRows().length;
    const r = ok(f.board.bootstrapHuman("owner2", sha256("second credential")));
    expect(r.value).toMatchObject({ handle: "owner2", created: true, retired: [ADMIN] });
    expect(user(f, ADMIN)).toMatchObject({ kind: "human", is_admin: 0, token_hash: null });
    expect(user(f, "owner2")).toMatchObject({ kind: "human", is_admin: 1 });
    const rows = f.auditRows().slice(before);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor: "system", action: "bootstrap_human", target_id: "owner2", result: "ok" });
    expect(JSON.parse(String(rows[0]?.detail))).toMatchObject({ created: true, retired: [ADMIN] });

    // The old credential is refused as revoked, and audited under the old handle.
    const auth = f.board.authenticate(ADMIN_TOKEN, { via: "cli" });
    expect(auth).toMatchObject({ ok: false, reason: "revoked_token" });
    expect(f.auditRows().at(-1)).toMatchObject({ actor: ADMIN, action: "auth", result: "denied" });
    // Even a call that skipped sign-in would have no admin power left.
    expect(fail(f.board.act(f.ctx(ADMIN, "cli"), "admin_user_add", { handle: "x" })).error.code).toBe("forbidden");
    expect(f.board.authenticate("second credential", { via: "cli" })).toMatchObject({ ok: true, handle: "owner2" });
  });

  it("is a no-op once current, and switching back restores the first handle and retires the second", () => {
    const f = makeBoard();
    ok(f.board.bootstrapHuman("owner2", sha256("second credential")));
    const n = f.auditRows().length;
    const again = ok(f.board.bootstrapHuman("owner2", sha256("second credential")));
    expect(again.value).toMatchObject({ changed: false });
    expect(f.auditRows()).toHaveLength(n);

    ok(f.board.bootstrapHuman(ADMIN, sha256(ADMIN_TOKEN)));
    expect(user(f, ADMIN)).toMatchObject({ is_admin: 1 });
    expect(user(f, "owner2")).toMatchObject({ is_admin: 0, token_hash: null });
    expect(f.board.authenticate(ADMIN_TOKEN, { via: "cli" })).toMatchObject({ ok: true, handle: ADMIN });
    expect(f.board.authenticate("second credential", { via: "cli" })).toMatchObject({ ok: false, reason: "revoked_token" });
  });

  it("a rotated credential for the same handle is revoked, not just forgotten", () => {
    const f = makeBoard();
    const r = ok(f.board.bootstrapHuman(ADMIN, sha256("new credential")));
    expect(r.value).toMatchObject({ created: false, changed: true, retired: [] });
    expect(f.board.authenticate(ADMIN_TOKEN, { via: "cli" })).toMatchObject({ ok: false, reason: "revoked_token" });
    expect(f.board.authenticate("new credential", { via: "cli" })).toMatchObject({ ok: true });
  });

  it("a new handle with the same credential moves the admin to the new handle", () => {
    const f = makeBoard();
    const r = ok(f.board.bootstrapHuman("owner2", sha256(ADMIN_TOKEN)));
    expect(r.value).toMatchObject({ created: true, retired: [ADMIN] });
    expect(user(f, ADMIN)).toMatchObject({ is_admin: 0, token_hash: null });
    expect(f.board.authenticate(ADMIN_TOKEN, { via: "cli" })).toMatchObject({ ok: true, handle: "owner2" });
  });

  it("still refuses a credential that belongs to an agent or a non-admin person", () => {
    const f = makeBoard();
    const agent = f.addUser("alice");
    const pat = f.addUser("pat", "human");
    expect(fail(f.board.bootstrapHuman("owner2", sha256(agent))).error.code).toBe("exists");
    expect(fail(f.board.bootstrapHuman("owner2", sha256(pat))).error.code).toBe("exists");
    expect(user(f, ADMIN)).toMatchObject({ is_admin: 1 });
  });

  it("only bootstrap ever sets the admin flag (so any other admin came from an earlier handle)", () => {
    const src = join(import.meta.dirname, "..", "src");
    const hits: string[] = [];
    for (const name of readdirSync(join(src, "actions"))) {
      const text = readFileSync(join(src, "actions", name), "utf8");
      for (const m of text.matchAll(/is_admin\s*=\s*1|is_admin, token_hash, created_at|"is_admin", "token_hash", "created_at"/g)) {
        const line = text.slice(0, m.index).split("\n").length;
        hits.push(`${name}:${line}`);
      }
    }
    // users.ts: bootstrap's insertUserOnce and UPDATE, and the read-only lookups of other admins.
    expect(hits.every((h) => h.startsWith("users.ts:"))).toBe(true);
    const users = readFileSync(join(src, "actions", "users.ts"), "utf8");
    const writes = [...users.matchAll(/(insertUserOnce\([^;]*"is_admin"|UPDATE users SET is_admin = 1)/g)];
    expect(writes).toHaveLength(2);
  });

  it("retiring also clears coordinator and marks the retired admin's unfinished tasks stale (review m6)", () => {
    const f = makeBoard();
    f.addUser("lead");
    ok(f.board.act(f.ctx(ADMIN), "admin_coordinator_grant", { handle: "lead" }));
    ok(f.board.act(f.ctx(ADMIN), "admin_coordinator_grant", { handle: ADMIN }));
    ok(f.board.act(f.ctx(ADMIN), "topic_create", { name: "t" }));
    const id = (title: string) =>
      ok(f.board.act<{ task: { id: number } }>(f.ctx(ADMIN), "task_create", { topic: "t", title })).value.task.id;
    const [a, b, c] = [id("a"), id("b"), id("c")];
    for (const t of [a, b, c]) ok(f.board.act(f.ctx(ADMIN), "task_claim", { task: t }));
    ok(f.board.act(f.ctx(ADMIN), "task_update", { task: c, state: "in_progress" }));
    ok(f.board.act(f.ctx(ADMIN), "task_update", { task: c, state: "in_review" }));
    ok(f.board.act(f.ctx(ADMIN), "task_update", { task: c, state: "done" }));
    f.sql.exec("UPDATE tasks SET is_stale = 1 WHERE id = ?", b); // already stale: not told again

    const r = ok(f.board.bootstrapHuman("owner2", sha256("second credential")));
    expect(user(f, ADMIN)).toMatchObject({ is_admin: 0, is_coordinator: 0, status: "active" });
    const stale = f.sql.all<{ id: number; is_stale: number }>("SELECT id, is_stale FROM tasks ORDER BY id");
    expect(stale.map((t) => [Number(t.id), Number(t.is_stale)])).toEqual([[a, 1], [b, 1], [c, 0]]);
    expect(r.notifications).toEqual([
      // M4b (B48): the retired credential's sockets are closed by the shell.
      { type: "disconnect", handle: ADMIN, reason: "credential_revoked" },
      expect.objectContaining({ type: "task", reason: "assignee_retired", recipient: "lead", as: "coordinator", task: a }),
    ]);
    const row = f.auditRows().at(-1);
    expect(JSON.parse(String(row?.detail))).toMatchObject({ retired: [ADMIN], stale_tasks: [a] });
    // M2 (B23, B47): the coordinator's notice is stored for bbs_inbox and
    // rings the coordinator's doorbell (decided by Curtis 2026-11-20).
    const notices = f.sql.all<{ handle: string; kind: string; reason: string; wake: number }>(
      "SELECT handle, kind, reason, wake FROM notices",
    );
    expect(notices.map((n) => [n.handle, n.kind, n.reason, Number(n.wake)])).toEqual([
      ["lead", "task", "assignee_retired", 1],
    ]);
    expect(f.sql.all("SELECT handle FROM doorbells WHERE handle = 'lead'")).toEqual([{ handle: "lead" }]);
  });

  it("a revoked credential is audited with why: retired for a person, kicked or replaced for an agent (review n5)", () => {
    const f = makeBoard();
    const old = f.addUser("alice");
    ok(f.board.act(f.ctx("alice"), "join", {}));
    kick(f, "alice");
    const detail = () => JSON.parse(String(f.auditRows().at(-1)?.detail));
    f.board.authenticate(old, { via: "mcp" });
    expect(detail()).toMatchObject({ revoked: "kicked" });
    ok(f.board.act(f.ctx(ADMIN), "admin_reinstate", { handle: "alice" }));
    f.board.authenticate(old, { via: "mcp" });
    expect(detail()).toMatchObject({ revoked: "replaced" });

    ok(f.board.bootstrapHuman(ADMIN, sha256("rotated")));
    f.board.authenticate(ADMIN_TOKEN, { via: "cli" });
    expect(detail()).toMatchObject({ revoked: "replaced" });
    ok(f.board.bootstrapHuman("owner2", sha256("second credential")));
    f.board.authenticate("rotated", { via: "cli" });
    expect(f.auditRows().at(-1)).toMatchObject({ actor: ADMIN, actor_kind: "human", action: "auth", result: "denied" });
    expect(detail()).toMatchObject({ revoked: "retired" });
    expect(JSON.stringify(f.auditRows().filter((a) => a.actor === ADMIN && a.action === "auth"))).not.toContain("kicked");
  });

  it("leaves people who are not admins alone", () => {
    const f = makeBoard();
    const token = f.addUser("pat", "human");
    ok(f.board.bootstrapHuman("owner2", sha256("second credential")));
    expect(user(f, "pat")).toMatchObject({ kind: "human", is_admin: 0 });
    expect(f.board.authenticate(token, { via: "cli" })).toMatchObject({ ok: true, handle: "pat" });
  });
});

describe("kind is fixed at account creation", () => {
  it("no source file updates users.kind", () => {
    const src = join(import.meta.dirname, "..", "src");
    const files = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)],
      );
    for (const file of files(src)) {
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(/UPDATE\s+users\s+SET([^;`"]*)/gi)) {
        expect(m[1], file).not.toMatch(/\bkind\s*=/i);
      }
    }
  });

  it("no tool takes a kind except account creation", () => {
    const withKind = TOOLS.filter((t) => "kind" in t.inputSchema.properties).map((t) => t.action);
    expect(withKind).toEqual(["admin_user_add"]);
  });

  it("an agent handle cannot be made human by bootstrap, and a handle cannot be created twice", () => {
    const f = makeBoard();
    f.addUser("alice");
    const r = fail(f.board.bootstrapHuman("alice", sha256("x")));
    expect(r.error.message).toMatch(/cannot become human/);
    expect(user(f, "alice")).toMatchObject({ kind: "agent", is_admin: 0 });
    expect(fail(f.board.act(f.ctx(ADMIN), "admin_user_add", { handle: "alice", kind: "human" })).error.code).toBe("exists");
    // join ignores a claimed kind (unknown fields are not read).
    ok(f.board.act(f.ctx("alice"), "join", {}));
    expect(user(f, "alice")?.kind).toBe("agent");
  });
});

const ADMIN_ACTIONS: { action: string; params: (target: string) => Record<string, unknown> }[] = [
  { action: "admin_reinstate", params: (h) => ({ handle: h }) },
  { action: "admin_coordinator_grant", params: (h) => ({ handle: h }) },
  { action: "admin_coordinator_remove", params: (h) => ({ handle: h }) },
  { action: "admin_user_add", params: () => ({ handle: "newbie" }) },
];

describe("admin actions are for the human admin only (A5.3)", () => {
  it("every agent is refused, a coordinator included, and so is a person without the flag", () => {
    const f = makeBoard();
    f.addUser("alice");
    f.addUser("lead");
    f.addUser("pat", "human");
    f.addUser("victim");
    ok(f.board.act(f.ctx(ADMIN), "admin_coordinator_grant", { handle: "lead" }));
    f.sql.exec("UPDATE users SET status = 'kicked', token_hash = NULL WHERE handle = 'victim'");
    for (const who of ["alice", "lead", "pat"]) {
      for (const { action, params } of ADMIN_ACTIONS) {
        const n = f.auditRows().length;
        const r = fail(f.board.act(f.ctx(who), action, params("victim")));
        expect(r.error.code, `${who} ${action}`).toBe("forbidden");
        expect(r.result).toBe("denied");
        expect(f.auditRows().slice(n)).toEqual([
          expect.objectContaining({ actor: who, action, result: "denied" }),
        ]);
      }
    }
    // Nothing changed.
    expect(user(f, "victim")).toMatchObject({ status: "kicked", is_coordinator: 0 });
    expect(user(f, "lead")).toMatchObject({ is_coordinator: 1 });
    // The human admin succeeds.
    for (const { action, params } of ADMIN_ACTIONS) ok(f.board.act(f.ctx(ADMIN), action, params("victim")));
  });

  it("admin tools are not offered on /mcp: a call there is refused and audited", () => {
    const f = makeBoard();
    f.addUser("lead");
    ok(f.board.act(f.ctx(ADMIN), "admin_coordinator_grant", { handle: "lead" }));
    for (const name of ["bbs_admin_reinstate", "bbs_admin_coordinator_grant", "bbs_admin_coordinator_remove"]) {
      const tool = TOOLS.find((t) => t.name === name);
      expect(tool?.surfaces).toEqual(["api", "cli"]);
      const r = callTool(f.board, f.ctx("lead"), name, { handle: "lead" }, "mcp");
      expect(r.isError).toBe(true);
      expect(r.content[0]?.text).toMatch(/not offered on mcp/);
    }
  });
});

describe("reinstate (B33, B35)", () => {
  it("issues a new token shown once; the old token stays revoked; the coordinator flag is cleared", () => {
    const f = makeBoard();
    const old = f.addUser("alice");
    ok(f.board.act(f.ctx(ADMIN), "admin_coordinator_grant", { handle: "alice" }));
    ok(f.board.act(f.ctx("alice"), "join", {}));
    kick(f, "alice");
    expect(user(f, "alice")?.is_coordinator).toBe(1);

    const r = ok(f.board.act<{ token: string; coordinator: boolean; offenses_cleared: number }>(
      f.ctx(ADMIN),
      "admin_reinstate",
      { handle: "alice" },
    ));
    expect(r.value.token).toMatch(/^bbs_/);
    expect(r.value.token).not.toBe(old);
    expect(r.value).toMatchObject({ coordinator: false, offenses_cleared: 3 });
    expect(user(f, "alice")).toMatchObject({ status: "active", is_coordinator: 0, token_hash: sha256(r.value.token) });
    // The token is not in the audit row; only facts about it.
    const row = f.auditRows().find((a) => a.action === "admin_reinstate");
    expect(String(row?.detail)).not.toContain(r.value.token);
    expect(JSON.parse(String(row?.detail))).toMatchObject({
      before: { status: "kicked", coordinator: true },
      after: { status: "active", coordinator: false },
      new_token: true,
    });
    expect(f.board.authenticate(old, { via: "mcp" })).toMatchObject({ ok: false, reason: "revoked_token" });
    expect(f.board.authenticate(r.value.token, { via: "mcp" })).toMatchObject({ ok: true, handle: "alice" });
    const log = f.sql.all<{ body: string }>("SELECT body FROM messages WHERE topic = 'admin-log' ORDER BY seq");
    expect(log.at(-1)?.body).toBe(`reinstate: alice reinstated by ${ADMIN} (new token issued; coordinator flag cleared)`);
    // Offenses were cleared: the next flood is a warning, not a kick.
    for (let i = 0; i < 6; i++) f.board.act(f.ctx("alice"), "post", { topic: "Lobby", body: `again ${i}` });
    expect(user(f, "alice")?.status).toBe("active");
  });

  it("keeps the coordinator flag only when the admin says so", () => {
    const f = makeBoard();
    f.addUser("alice");
    ok(f.board.act(f.ctx("alice"), "join", {}));
    kick(f, "alice");
    const r = ok(f.board.act(f.ctx(ADMIN), "admin_reinstate", { handle: "alice", coordinator: true }));
    expect(r.value).toMatchObject({ coordinator: true });
    expect(user(f, "alice")?.is_coordinator).toBe(1);
  });

  it("refuses a user who is not kicked, and an unknown handle", () => {
    const f = makeBoard();
    f.addUser("alice");
    expect(fail(f.board.act(f.ctx(ADMIN), "admin_reinstate", { handle: "alice" })).error.code).toBe("conflict");
    expect(fail(f.board.act(f.ctx(ADMIN), "admin_reinstate", { handle: "nobody" })).error.code).toBe("not_found");
  });
});

describe("coordinator grant and remove", () => {
  it("sets and clears the flag with an admin-log line; repeating is a recorded no-op", () => {
    const f = makeBoard();
    f.addUser("alice");
    f.addUser("pat", "human");
    expect(ok(f.board.act(f.ctx(ADMIN), "admin_coordinator_grant", { handle: "alice" })).value).toMatchObject({
      coordinator: true,
      changed: true,
    });
    expect(user(f, "alice")?.is_coordinator).toBe(1);
    expect(ok(f.board.act(f.ctx(ADMIN), "admin_coordinator_grant", { handle: "alice" })).value).toMatchObject({
      changed: false,
    });
    // A person can hold the flag too (design §4).
    ok(f.board.act(f.ctx(ADMIN), "admin_coordinator_grant", { handle: "pat" }));
    expect(user(f, "pat")?.is_coordinator).toBe(1);
    ok(f.board.act(f.ctx(ADMIN), "admin_coordinator_remove", { handle: "alice" }));
    expect(user(f, "alice")?.is_coordinator).toBe(0);
    const log = f.sql.all<{ body: string }>("SELECT body FROM messages WHERE topic = 'admin-log' ORDER BY seq");
    expect(log.map((m) => m.body)).toEqual([
      `coordinator: alice granted by ${ADMIN}`,
      `coordinator: pat granted by ${ADMIN}`,
      `coordinator: alice removed by ${ADMIN}`,
    ]);
    // A coordinator can now read the audit log; after removal it cannot.
    expect(fail(f.board.act(f.ctx("alice"), "audit", {})).error.code).toBe("forbidden");
  });

  it("will not grant to a kicked user (reinstate with coordinator instead)", () => {
    const f = makeBoard();
    f.addUser("alice");
    f.sql.exec("UPDATE users SET status = 'kicked', token_hash = NULL WHERE handle = 'alice'");
    expect(fail(f.board.act(f.ctx(ADMIN), "admin_coordinator_grant", { handle: "alice" })).error.code).toBe("conflict");
    ok(f.board.act(f.ctx(ADMIN), "admin_coordinator_remove", { handle: "alice" }));
  });
});

describe("author kind and via (A5.2, B22)", () => {
  it("a person's post via web is human; an agent's 'human says' is agent; an agent cannot use via web", () => {
    const f = makeBoard();
    f.addUser("alice");
    ok(f.board.act(f.ctx(ADMIN, "web"), "topic_create", { name: "t" }));
    ok(f.board.act(f.ctx(ADMIN, "web"), "post", { topic: "t", body: "ship it" }));
    ok(f.board.act(f.ctx("alice", "mcp"), "post", { topic: "t", body: "human says: ship it" }));
    const refused = fail(f.board.act(f.ctx("alice", "web"), "post", { topic: "t", body: "human says: ship it" }));
    expect(refused.error.message).toMatch(/agent users cannot act via web/);
    const rows = f.sql.all("SELECT author, author_kind, via, body FROM messages WHERE topic = 't' ORDER BY seq");
    expect(rows).toEqual([
      { author: ADMIN, author_kind: "human", via: "web", body: "ship it" },
      { author: "alice", author_kind: "agent", via: "mcp", body: "human says: ship it" },
    ]);
  });
});

describe("whoami", () => {
  it("returns the caller's handle, kind and flags, unaudited", () => {
    const f = makeBoard();
    f.addUser("alice");
    const n = f.auditRows().length;
    expect(ok(f.board.act(f.ctx("alice"), "whoami", {})).value).toEqual({
      handle: "alice",
      kind: "agent",
      admin: false,
      coordinator: false,
      status: "active",
      via: "mcp",
    });
    expect(ok(f.board.act(f.ctx(ADMIN, "web"), "whoami", {})).value).toMatchObject({ kind: "human", admin: true, via: "web" });
    expect(f.auditRows()).toHaveLength(n);
    expect(Object.hasOwn(PUBLIC_ACTIONS, "whoami")).toBe(true);
  });

  const serverOf = (f: Fixture): unknown => (ok(f.board.act(f.ctx(ADMIN), "whoami", {})).value as { server?: unknown }).server;
  const BUILD = "0123456789abcdef";
  const COMMIT = "0123456789abcdef0123456789abcdef01234567";

  it("reports the server's build and commit when the shell gives them, unaudited", () => {
    const f = makeBoard({ server: { build: BUILD, commit: `${COMMIT}-dirty` } });
    const n = f.auditRows().length;
    expect(serverOf(f)).toEqual({ build: BUILD, commit: `${COMMIT}-dirty` });
    expect(f.auditRows()).toHaveLength(n);
    expect(serverOf(makeBoard({ server: { build: BUILD } }))).toEqual({ build: BUILD });
  });

  it("omits `server` with no build id, and drops a malformed value instead of refusing", () => {
    const bare = makeBoard();
    expect(Object.hasOwn(ok(bare.board.act(bare.ctx(ADMIN), "whoami", {})).value as object, "server")).toBe(false);
    expect(serverOf(makeBoard({ server: { commit: COMMIT } }))).toBeUndefined();
    expect(serverOf(makeBoard({ server: { build: BUILD, commit: "not a commit" } }))).toEqual({ build: BUILD });
    expect(serverOf(makeBoard({ server: { build: BUILD, commit: "a".repeat(65) } }))).toEqual({ build: BUILD });
    expect(serverOf(makeBoard({ server: { build: "abc123; drop", commit: COMMIT } }))).toBeUndefined();
  });
});

describe("audit with tail", () => {
  it("returns the newest matching rows, in seq order", () => {
    const f = makeBoard();
    f.addUser("alice");
    for (let i = 0; i < 4; i++) ok(f.board.act(f.ctx("alice"), "topic_create", { name: `t${i}` }));
    const r = ok(f.board.act<{ events: { seq: number; target_id: string }[] }>(f.ctx(ADMIN), "audit", {
      actor: "alice",
      tail: true,
      limit: 2,
    }));
    expect(r.value.events.map((e) => e.target_id)).toEqual(["t2", "t3"]);
    expect(r.value.events[0]!.seq).toBeLessThan(r.value.events[1]!.seq);
  });
});

describe("read with tail (review m3)", () => {
  type Page = { messages: { body: string; seq: number }[]; more?: boolean; next_since?: number; more_before?: boolean };

  it("returns the newest messages in seq order, with more_before and no forward-paging fields", () => {
    const f = makeBoard();
    f.addUser("alice");
    ok(f.board.act(f.ctx("alice"), "topic_create", { name: "t" }));
    for (let i = 0; i < 5; i++) ok(f.board.act(f.ctx("alice"), "post", { topic: "t", body: `m${i}` }));
    const r = ok(f.board.act<Page>(f.ctx("alice"), "read", { topic: "t", tail: true, limit: 2 }));
    expect(r.value.messages.map((m) => m.body)).toEqual(["m3", "m4"]);
    expect(r.value.more_before).toBe(true);
    expect(r.value).not.toHaveProperty("more");
    expect(r.value).not.toHaveProperty("next_since");
    const all = ok(f.board.act<Page>(f.ctx("alice"), "read", { topic: "t", tail: true }));
    expect(all.value.messages).toHaveLength(5);
    expect(all.value.more_before).toBe(false);
  });

  it("a client paging forward is not misled: forward pages still carry next_since and more", () => {
    const f = makeBoard();
    f.addUser("alice");
    ok(f.board.act(f.ctx("alice"), "topic_create", { name: "t" }));
    for (let i = 0; i < 5; i++) ok(f.board.act(f.ctx("alice"), "post", { topic: "t", body: `m${i}` }));
    // A pager that follows next_since while `more` is true sees every message once, in order.
    const seen: string[] = [];
    let since = 0;
    for (;;) {
      const page = ok(f.board.act<Page>(f.ctx("alice"), "read", { topic: "t", since, limit: 2 })).value;
      seen.push(...page.messages.map((m) => m.body));
      expect(page).not.toHaveProperty("more_before");
      if (!page.more) break;
      since = page.next_since as number;
    }
    expect(seen).toEqual(["m0", "m1", "m2", "m3", "m4"]);
    // Following a tail page's (absent) next_since would stop the pager at once rather than skip.
    const tail = ok(f.board.act<Page>(f.ctx("alice"), "read", { topic: "t", tail: true, limit: 2 })).value;
    expect(tail.more === true).toBe(false);
    expect(tail.next_since).toBeUndefined();
  });
});

describe("activity: the web view's reads do not count (B38, decided by Curtis)", () => {
  function setup() {
    const f = makeBoard();
    f.addUser("alice");
    ok(f.board.act(f.ctx(ADMIN, "web"), "topic_create", { name: "t" }));
    ok(f.board.act(f.ctx("alice"), "subscribe", { topic: "t", level: "wake" }));
    const task = ok(f.board.act<{ task: { id: number } }>(f.ctx(ADMIN, "web"), "task_create", { topic: "t", title: "x" }))
      .value.task.id;
    ok(f.board.act(f.ctx(ADMIN, "web"), "task_claim", { task }));
    ok(f.board.act(f.ctx(ADMIN, "web"), "task_update", { task, state: "in_progress" }));
    return { f, task };
  }
  const state = (f: Fixture, task: number) => ({
    lastSeen: Number(f.sql.one<{ v: number }>("SELECT last_seen AS v FROM users WHERE handle = ?", ADMIN)?.v),
    lease: Number(f.sql.one<{ v: number }>("SELECT lease_expires_at AS v FROM tasks WHERE id = ?", task)?.v),
  });

  it("reads and passive changes by a person via web leave last_seen and leases alone", () => {
    const { f, task } = setup();
    const before = state(f, task);
    f.clock.advance(MIN);
    ok(f.board.act(f.ctx(ADMIN, "web"), "read", { topic: "t" }));
    ok(f.board.act(f.ctx(ADMIN, "web"), "topics", {}));
    ok(f.board.act(f.ctx(ADMIN, "web"), "who", {}));
    ok(f.board.act(f.ctx(ADMIN, "web"), "task_list", {}));
    ok(f.board.act(f.ctx(ADMIN, "web"), "audit", {}));
    ok(f.board.act(f.ctx(ADMIN, "web"), "topic_mark_read", { topic: "t", through_seq: 1_000 }));
    expect(state(f, task)).toEqual(before);
  });

  it("posts and task changes by a person via web still count", () => {
    const { f, task } = setup();
    const before = state(f, task);
    f.clock.advance(MIN);
    ok(f.board.act(f.ctx(ADMIN, "web"), "post", { topic: "t", body: "hi" }));
    expect(state(f, task)).toEqual({ lastSeen: before.lastSeen + MIN, lease: before.lease + MIN });
    f.clock.advance(MIN);
    ok(f.board.act(f.ctx(ADMIN, "web"), "task_comment", { task, body: "progress" }));
    expect(state(f, task).lease).toBe(before.lease + 2 * MIN);
  });

  it("the same reads through the CLI, and an agent's reads, still count", () => {
    const { f, task } = setup();
    const before = state(f, task);
    f.clock.advance(MIN);
    ok(f.board.act(f.ctx(ADMIN, "cli"), "read", { topic: "t" }));
    expect(state(f, task)).toEqual({ lastSeen: before.lastSeen + MIN, lease: before.lease + MIN });
    const seen = () => f.sql.one<{ v: number }>("SELECT last_seen AS v FROM users WHERE handle = 'alice'")?.v;
    f.clock.advance(MIN);
    ok(f.board.act(f.ctx("alice", "api"), "read", { topic: "t" }));
    expect(seen()).toBe(f.clock.t);
  });
});

describe("topic_mark_read (review M1)", () => {
  it("advances the read mark monotonically so the unread count clears; audited", () => {
    const f = makeBoard();
    f.addUser("alice");
    ok(f.board.act(f.ctx(ADMIN, "web"), "topic_create", { name: "t" }));
    const seqs: number[] = [];
    for (let i = 0; i < 3; i++) {
      seqs.push(ok(f.board.act<{ seq: number }>(f.ctx("alice"), "post", { topic: "t", body: `m${i}` })).value.seq);
    }
    const unread = () =>
      ok(f.board.act<{ topics: { name: string; unread: number | null }[] }>(f.ctx(ADMIN, "web"), "topics", {}))
        .value.topics.find((t) => t.name === "t")?.unread;
    expect(unread()).toBe(3);
    const n = f.auditRows().length;
    const r = ok(f.board.act(f.ctx(ADMIN, "web"), "topic_mark_read", { topic: "t", through_seq: seqs[1] }));
    expect(r.value).toMatchObject({ last_read_seq: seqs[1], changed: true });
    expect(unread()).toBe(1);
    expect(f.auditRows().slice(n)).toEqual([
      expect.objectContaining({ actor: ADMIN, via: "web", action: "topic_mark_read", result: "ok" }),
    ]);
    // Never backwards; never past the topic's newest message.
    expect(ok(f.board.act(f.ctx(ADMIN, "web"), "topic_mark_read", { topic: "t", through_seq: seqs[0] })).value)
      .toMatchObject({ last_read_seq: seqs[1], changed: false });
    expect(ok(f.board.act(f.ctx(ADMIN, "web"), "topic_mark_read", { topic: "t", through_seq: 1_000_000 })).value)
      .toMatchObject({ last_read_seq: seqs[2], changed: true });
    expect(unread()).toBe(0);
  });

  it("changes nothing for a topic the caller is not in, and is offered on /api only", () => {
    const f = makeBoard();
    f.addUser("alice");
    ok(f.board.act(f.ctx("alice"), "topic_create", { name: "t" }));
    ok(f.board.act(f.ctx("alice"), "post", { topic: "t", body: "x" }));
    expect(ok(f.board.act(f.ctx(ADMIN, "web"), "topic_mark_read", { topic: "t", through_seq: 99 })).value)
      .toMatchObject({ last_read_seq: null, changed: false });
    expect(TOOLS.find((t) => t.action === "topic_mark_read")?.surfaces).toEqual(["api"]);
  });
});

// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0

/**
 * Web sign-in by pairing code (issue #47): the pairing, the approval from the
 * CLI, the claim that makes a session, the session's use and renewal, and the
 * ways to end it.
 */

import { describe, expect, it } from "vitest";
import { callTool } from "../src/tools.ts";
import type { BoardConfig, CallContext } from "../src/types.ts";
import { ADMIN, makeBoard, sha256, type Fixture } from "./helpers.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

interface Started {
  code: string;
  poll_secret: string;
  expires_in_ms: number;
}

function start(f: Fixture, source = "ip:1.1.1.1"): Started {
  const r = f.board.webPairStart({ source, label: "Chrome on macOS" });
  if (!r.ok) throw new Error(`start refused: ${r.error.message}`);
  return r.value;
}

function approve(f: Fixture, code: string, as = ADMIN) {
  return f.board.act(f.ctx(as, "cli"), "web_pairing_approve", { code });
}

interface Claimed {
  status: string;
  session?: string;
  id?: string;
  handle?: string;
  expires_at?: number;
}

function claim(f: Fixture, pollSecret: string, source = "ip:1.1.1.1") {
  return f.board.webPairClaim({ pollSecret, source });
}

/** Run a whole pairing and return the cookie value and the session id. */
function signIn(f: Fixture, as = ADMIN): { cookie: string; id: string } {
  const p = start(f);
  const a = approve(f, p.code, as);
  if (!a.ok) throw new Error(`approve refused: ${a.error.message}`);
  const c = claim(f, p.poll_secret);
  if (!c.ok) throw new Error(`claim refused: ${c.error.message}`);
  const v = c.value as unknown as Claimed;
  return { cookie: v.session as string, id: v.id as string };
}

const webCtx = (handle: string, id: string): CallContext => ({ handle, via: "web", webSession: id });

function rowsOf(f: Fixture, action: string) {
  return f.auditRows().filter((r) => r.action === action);
}

function makeFixture(config: Partial<BoardConfig> = {}): Fixture {
  return makeBoard({ config });
}

describe("pairing, approval and claim", () => {
  it("runs end to end: a code, an approval from the CLI, a claim that makes a session, a call through it", () => {
    const f = makeFixture();
    const p = start(f);
    expect(p.code).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    expect(p.code).not.toMatch(/[01IOL]/);
    expect(p.expires_in_ms).toBe(5 * MIN);
    expect(p.poll_secret).toMatch(/^[A-Za-z0-9_-]{43}$/);

    expect(claim(f, p.poll_secret)).toMatchObject({ ok: true, value: { status: "pending" } });
    const shown = f.board.act(f.ctx(ADMIN, "cli"), "web_pairing_show", { code: p.code });
    expect(shown).toMatchObject({ ok: true, value: { label: "Chrome on macOS", age_ms: 0, expires_in_ms: 5 * MIN } });
    expect(approve(f, p.code)).toMatchObject({ ok: true, value: { approved: true } });

    const c = claim(f, p.poll_secret);
    expect(c).toMatchObject({ ok: true, value: { status: "approved", handle: ADMIN } });
    const v = (c as unknown as { value: Claimed }).value;
    expect(v.session).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const auth = f.board.authenticateWebSession(v.session, { source: "ip:1.1.1.1" });
    expect(auth).toEqual({ ok: true, handle: ADMIN, kind: "human", webSession: v.id });
    const who = f.board.act({ handle: ADMIN, via: "web", webSession: v.id }, "whoami", {});
    expect(who).toMatchObject({ ok: true, value: { handle: ADMIN, kind: "human", via: "web" } });
  });

  it("stores only hashes, and no secret reaches an audit row", () => {
    const f = makeFixture();
    const p = start(f);
    approve(f, p.code);
    const c = claim(f, p.poll_secret) as unknown as { ok: true; value: Claimed };
    const code = p.code.replace("-", "");
    expect(f.sql.one("SELECT code_hash, poll_hash FROM web_pairings")).toEqual({
      code_hash: sha256(code),
      poll_hash: sha256(p.poll_secret),
    });
    expect(f.sql.one("SELECT token_hash FROM web_sessions")).toEqual({ token_hash: sha256(c.value.session as string) });
    const everything = JSON.stringify(f.auditRows()) + JSON.stringify(f.sql.all("SELECT * FROM web_pairings"));
    for (const secret of [code, p.code, p.poll_secret, c.value.session as string]) {
      expect(everything).not.toContain(secret);
    }
    expect(rowsOf(f, "web_pair_start")[0]).toMatchObject({ actor: "anonymous", actor_kind: "anonymous", via: "web", result: "ok" });
    expect(rowsOf(f, "web_pairing_approve")[0]).toMatchObject({ actor: ADMIN, via: "cli" });
    expect(rowsOf(f, "web_pair_claim")[0]).toMatchObject({ actor: ADMIN, via: "web", target_type: "web_session" });
  });

  it("takes the code in any case, with or without the hyphen, and ignoring spaces", () => {
    for (const mangle of [(c: string) => c.toLowerCase(), (c: string) => c.replace("-", ""), (c: string) => ` ${c.slice(0, 4)} ${c.slice(5)} `]) {
      const f = makeFixture();
      const p = start(f);
      expect(approve(f, mangle(p.code)).ok).toBe(true);
    }
  });

  it("refuses an expired code everywhere, and the claim says expired", () => {
    const f = makeFixture();
    const p = start(f);
    f.clock.advance(5 * MIN);
    expect(f.board.act(f.ctx(ADMIN, "cli"), "web_pairing_show", { code: p.code })).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(approve(f, p.code)).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(claim(f, p.poll_secret)).toMatchObject({ ok: true, value: { status: "expired" } });
    // An approved but unclaimed pairing runs out too.
    const q = start(f);
    approve(f, q.code);
    f.clock.advance(5 * MIN);
    expect(claim(f, q.poll_secret)).toMatchObject({ ok: true, value: { status: "expired" } });
    expect(f.sql.one("SELECT COUNT(*) AS n FROM web_sessions")).toEqual({ n: 0 });
  });

  it("is single use: a code is approved once and a pairing is claimed once", () => {
    const f = makeFixture();
    const p = start(f);
    expect(approve(f, p.code).ok).toBe(true);
    expect(approve(f, p.code)).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(f.board.act(f.ctx(ADMIN, "cli"), "web_pairing_show", { code: p.code })).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(claim(f, p.poll_secret)).toMatchObject({ ok: true, value: { status: "approved" } });
    expect(claim(f, p.poll_secret)).toMatchObject({ ok: false, error: { code: "unauthorized" } });
    expect(f.sql.one("SELECT COUNT(*) AS n FROM web_sessions")).toEqual({ n: 1 });
  });

  it("two claims of one approved pairing at once make exactly one session", async () => {
    const f = makeFixture();
    const p = start(f);
    approve(f, p.code);
    const results = await Promise.all([claim(f, p.poll_secret), Promise.resolve().then(() => claim(f, p.poll_secret))]);
    expect(results.filter((r) => r.ok && (r.value as unknown as Claimed).status === "approved")).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toHaveLength(1);
    expect(f.sql.one("SELECT COUNT(*) AS n FROM web_sessions")).toEqual({ n: 1 });
    expect(rowsOf(f, "web_pair_claim").filter((r) => r.result === "ok")).toHaveLength(1);
  });

  it("refuses an unknown poll secret and counts it as a failed sign-in for its source", () => {
    const f = makeFixture({ authFailureLimit: 2 });
    start(f);
    const r1 = claim(f, "wrong-secret");
    expect(r1).toMatchObject({ ok: false, error: { code: "unauthorized" } });
    expect(rowsOf(f, "auth")[0]).toMatchObject({ result: "denied", actor: "anonymous", via: "web" });
    expect(JSON.parse(String(rowsOf(f, "auth")[0]?.detail))).toMatchObject({ reason: "authentication failed: unknown_poll_secret", source: "ip:1.1.1.1" });
    claim(f, "wrong-secret-2");
    // Past the per-source limit the answer is rate_limited, the same guard as a bad token.
    expect(claim(f, "wrong-secret-3")).toMatchObject({ ok: false, error: { code: "rate_limited" } });
    expect(claim(f, "")).toMatchObject({ ok: false });
  });

  it("an agent, a web session and a person on the wrong surface cannot approve or look up", () => {
    const f = makeFixture();
    f.addUser("alice");
    f.addUser("pat", "human");
    const { id } = signIn(f);
    const p = start(f);
    for (const action of ["web_pairing_approve", "web_pairing_show"]) {
      for (const ctx of [
        { handle: "alice", via: "mcp" as const },
        { handle: "alice", via: "api" as const },
        webCtx(ADMIN, id),
        { handle: ADMIN, via: "api" as const },
        { handle: "pat", via: "web" as const },
      ]) {
        const r = f.board.act(ctx, action, { code: p.code });
        expect(r, `${action} as ${ctx.handle} via ${ctx.via}`).toMatchObject({ ok: false, result: "denied" });
      }
    }
    expect(f.sql.one("SELECT state FROM web_pairings WHERE id = 2")).toEqual({ state: "pending" });
    // The people who may approve: any person, from the CLI.
    expect(approve(f, p.code, "pat").ok).toBe(true);
    const c = claim(f, p.poll_secret) as unknown as { ok: true; value: Claimed };
    expect(c.value.handle).toBe("pat");
  });

  it("approve is refused on /mcp, even for the right caller", () => {
    const f = makeFixture();
    const p = start(f);
    const r = callTool(f.board, f.ctx(ADMIN, "cli"), "bbs_web_pairing_approve", { code: p.code }, "mcp");
    expect(r.isError).toBe(true);
    expect(f.sql.one("SELECT state FROM web_pairings")).toEqual({ state: "pending" });
    expect(rowsOf(f, "web_pairing_approve")[0]).toMatchObject({ result: "denied" });
    // No web-session tool is offered on /mcp either.
    for (const name of ["bbs_web_pairing_show", "bbs_web_sessions", "bbs_web_session_revoke", "bbs_web_sign_out"]) {
      expect(callTool(f.board, f.ctx(ADMIN, "cli"), name, {}, "mcp").isError, name).toBe(true);
    }
  });

  it("limits wrong codes, so show and approve cannot be used to guess a live code", () => {
    const f = makeFixture({ webPairingGuessLimit: 3 });
    const p = start(f);
    for (let i = 0; i < 3; i++) {
      expect(f.board.act(f.ctx(ADMIN, "cli"), "web_pairing_show", { code: "AAAA-AAAA" })).toMatchObject({ ok: false, error: { code: "not_found" } });
    }
    // Even the right code is refused now, by show and by approve.
    expect(approve(f, p.code)).toMatchObject({ ok: false, error: { code: "rate_limited" } });
    expect(f.board.act(f.ctx(ADMIN, "cli"), "web_pairing_show", { code: p.code })).toMatchObject({ ok: false, error: { code: "rate_limited" } });
    f.clock.advance(11 * MIN);
    const q = start(f);
    expect(approve(f, q.code).ok).toBe(true);
  });

  it("refuses starts past the board's live pairings and past one source's, without a row per refusal", () => {
    const f = makeFixture({ webPairingMaxPending: 4, webPairingMaxPerSource: 2 });
    start(f, "ip:a");
    start(f, "ip:a");
    expect(f.board.webPairStart({ source: "ip:a" })).toMatchObject({ ok: false, error: { code: "rate_limited" } });
    start(f, "ip:b");
    start(f, "ip:c");
    expect(f.board.webPairStart({ source: "ip:d" })).toMatchObject({ ok: false, error: { code: "rate_limited" } });
    expect(rowsOf(f, "web_pair_start").filter((r) => r.result === "ok")).toHaveLength(4);
    // A flood of refused starts writes bounded audit rows, never one per request.
    const before = f.auditRows().length;
    for (let i = 0; i < 200; i++) f.board.webPairStart({ source: "ip:d" });
    expect(f.auditRows().length - before).toBeLessThanOrEqual(f.board.config.authFailureLimit + 2);
    expect(rowsOf(f, "web_pair_start").filter((r) => r.result !== "ok")).toEqual([]);
    // Consumed and expired pairings free their places.
    f.clock.advance(5 * MIN);
    expect(f.board.webPairStart({ source: "ip:d" }).ok).toBe(true);
  });

  it("enforces the pending cap inside the write, not on a count read first", () => {
    const f = makeFixture({ webPairingMaxPending: 1 });
    start(f, "ip:a");
    // The action itself refuses when its INSERT's condition fails, even when the Board's early read is bypassed.
    const raw = f.sql.all<{ id: number }>(
      `INSERT INTO web_pairings (code_hash, poll_hash, label, source, created_at, expires_at)
       SELECT 'c', 'p', 'l', 's', 0, ?
       WHERE (SELECT COUNT(*) FROM web_pairings WHERE state <> 'consumed' AND expires_at > ?) < ?
       RETURNING id`,
      f.clock.t + MIN,
      f.clock.t,
      1,
    );
    expect(raw).toEqual([]);
  });
});

describe("the session cookie", () => {
  it("stays valid through use, and slides at most once a day with one audit row", () => {
    const f = makeFixture();
    const { cookie, id } = signIn(f);
    const created = f.clock.t;
    f.clock.advance(12 * HOUR);
    for (let i = 0; i < 5; i++) expect(f.board.authenticateWebSession(cookie, {}).ok).toBe(true);
    expect(rowsOf(f, "web_session_renew")).toHaveLength(0);
    expect(f.sql.one("SELECT expires_at FROM web_sessions")).toEqual({ expires_at: created + 30 * DAY });

    f.clock.advance(13 * HOUR);
    // Only the call that slid the expiry says so, with the lifetime from the config (the Worker re-sends the cookie).
    const first = f.board.authenticateWebSession(cookie, {});
    expect(first).toMatchObject({ ok: true, renewed: true, maxAgeMs: 30 * DAY });
    for (let i = 0; i < 4; i++) {
      const again = f.board.authenticateWebSession(cookie, {});
      expect(again.ok && "renewed" in again).toBe(false);
    }
    const renewals = rowsOf(f, "web_session_renew");
    expect(renewals).toHaveLength(1);
    expect(renewals[0]).toMatchObject({ actor: ADMIN, via: "web", target_id: id, result: "ok" });
    expect(f.sql.one("SELECT renewed_at, expires_at FROM web_sessions")).toEqual({
      renewed_at: f.clock.t,
      expires_at: f.clock.t + 30 * DAY,
    });
    // The renewal is passive: it does not count as the person's activity (last_seen is still the approval's).
    expect(f.sql.one("SELECT last_seen FROM users WHERE handle = ?", ADMIN)).toEqual({ last_seen: created });

    f.clock.advance(25 * HOUR);
    f.board.authenticateWebSession(cookie, {});
    f.board.authenticateWebSession(cookie, {});
    expect(rowsOf(f, "web_session_renew")).toHaveLength(2);
  });

  it("expires 30 days after its last renewal, and is then refused", () => {
    const f = makeFixture();
    const { cookie } = signIn(f);
    f.clock.advance(30 * DAY - MIN);
    expect(f.board.authenticateWebSession(cookie, {}).ok).toBe(true);
    f.clock.advance(30 * DAY - MIN);
    expect(f.board.authenticateWebSession(cookie, {}).ok).toBe(true);
    f.clock.advance(30 * DAY + MIN);
    expect(f.board.authenticateWebSession(cookie, {})).toMatchObject({ ok: false, reason: "expired_session" });
  });

  it("refuses an unknown or missing cookie as a failed sign-in", () => {
    const f = makeFixture();
    expect(f.board.authenticateWebSession("nope", { source: "ip:9" })).toMatchObject({ ok: false, reason: "unknown_session" });
    expect(f.board.authenticateWebSession(undefined, { source: "ip:9" })).toMatchObject({ ok: false, reason: "missing_session" });
    expect(f.board.authenticateWebSession("x".repeat(600), { source: "ip:9" })).toMatchObject({ ok: false, reason: "session_too_long" });
    expect(rowsOf(f, "auth")).toHaveLength(3);
  });

  it("stops working for a user who is not active, and a retired credential's sessions are revoked", () => {
    const f = makeFixture();
    const { cookie } = signIn(f);
    f.sql.exec("UPDATE users SET status = 'kicked' WHERE handle = ?", ADMIN);
    expect(f.board.authenticateWebSession(cookie, {})).toMatchObject({ ok: false, reason: "revoked_session" });
    f.sql.exec("UPDATE users SET status = 'active' WHERE handle = ?", ADMIN);
    expect(f.board.authenticateWebSession(cookie, {}).ok).toBe(true);

    // A new BBS_HUMAN_HANDLE retires the old admin and its sessions with it.
    f.board.bootstrapHuman("owner2", sha256("another credential"));
    expect(f.sql.one("SELECT COUNT(*) AS n FROM web_sessions")).toEqual({ n: 0 });
    expect(f.board.authenticateWebSession(cookie, {})).toMatchObject({ ok: false, reason: "unknown_session" });
  });

  it("a kick revokes the user's sessions, and reinstating brings none back", () => {
    const f = makeFixture();
    f.addUser("bob");
    // Agents have no pairing; a session row is set up directly to watch the kick take it.
    f.sql.exec(
      `INSERT INTO web_sessions (id, handle, token_hash, label, created_at, renewed_at, expires_at)
       VALUES ('ws_bob', 'bob', 'h', 'l', 1, 1, ?)`,
      f.clock.t + DAY,
    );
    f.board.act(f.ctx("bob"), "join", {});
    for (let round = 0; round < 3; round++) {
      for (let i = 0; i < 7; i++) f.board.act(f.ctx("bob"), "post", { topic: "Lobby", body: `b${round}-${i}` });
      f.clock.advance(61 * MIN);
      f.board.runDueTimers();
      f.clock.advance(-50 * MIN);
    }
    expect(f.sql.one("SELECT status FROM users WHERE handle = 'bob'")).toEqual({ status: "kicked" });
    expect(f.sql.one("SELECT COUNT(*) AS n FROM web_sessions")).toEqual({ n: 0 });
    f.board.act(f.ctx(ADMIN, "cli"), "admin_reinstate", { handle: "bob" });
    expect(f.sql.one("SELECT COUNT(*) AS n FROM web_sessions")).toEqual({ n: 0 });
  });

  it("past the per-user cap the oldest session is revoked", () => {
    const f = makeFixture({ webSessionMaxPerUser: 3 });
    const made: { cookie: string; id: string }[] = [];
    for (let i = 0; i < 4; i++) {
      made.push(signIn(f));
      f.clock.advance(MIN);
    }
    expect(f.sql.one("SELECT COUNT(*) AS n FROM web_sessions")).toEqual({ n: 3 });
    expect(f.board.authenticateWebSession((made[0] as { cookie: string }).cookie, {}).ok).toBe(false);
    for (const m of made.slice(1)) expect(f.board.authenticateWebSession(m.cookie, {}).ok).toBe(true);
    const last = rowsOf(f, "web_pair_claim").at(-1);
    expect(JSON.parse(String(last?.detail)).revoked_for_cap).toEqual([(made[0] as { id: string }).id]);
    // Another person's sessions are not counted against this one's cap.
    f.addUser("pat", "human");
    signIn(f, "pat");
    expect(f.sql.one("SELECT COUNT(*) AS n FROM web_sessions")).toEqual({ n: 4 });
  });

  it("lists the caller's sessions without secrets and marks the current one", () => {
    const f = makeFixture();
    f.addUser("pat", "human");
    const a = signIn(f);
    f.clock.advance(MIN);
    const b = signIn(f);
    signIn(f, "pat");
    const fromWeb = f.board.act<{ sessions: Record<string, unknown>[] }>(webCtx(ADMIN, b.id), "web_sessions", {});
    expect(fromWeb.ok && fromWeb.value.sessions.map((s) => [s.id, s.current])).toEqual([
      [a.id, false],
      [b.id, true],
    ]);
    const fromCli = f.board.act<{ sessions: Record<string, unknown>[] }>(f.ctx(ADMIN, "cli"), "web_sessions", {});
    expect(fromCli.ok && fromCli.value.sessions.every((s) => s.current === false)).toBe(true);
    const text = JSON.stringify(fromWeb);
    for (const secret of [a.cookie, b.cookie, sha256(a.cookie), sha256(b.cookie)]) expect(text).not.toContain(secret);
    expect(Object.keys((fromWeb as { value: { sessions: object[] } }).value.sessions[0] as object).sort()).toEqual([
      "created_at", "current", "expires_at", "id", "label", "renewed_at",
    ]);
    expect(f.board.act(f.ctx("pat", "cli"), "web_sessions", {})).toMatchObject({ ok: true });
    // An agent has none to list.
    f.addUser("alice");
    expect(f.board.act(f.ctx("alice", "mcp"), "web_sessions", {})).toMatchObject({ ok: false, result: "denied" });
  });

  it("revokes one session by id, or all of one's own, from the CLI only", () => {
    const f = makeFixture();
    f.addUser("pat", "human");
    const a = signIn(f);
    const b = signIn(f);
    const c = signIn(f, "pat");
    // Not from a web session, and not someone else's.
    expect(f.board.act(webCtx(ADMIN, a.id), "web_session_revoke", { id: b.id })).toMatchObject({ ok: false, result: "denied" });
    expect(f.board.act(f.ctx(ADMIN, "cli"), "web_session_revoke", { id: c.id })).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(f.board.act(f.ctx(ADMIN, "cli"), "web_session_revoke", {})).toMatchObject({ ok: false, error: { code: "bad_request" } });
    expect(f.board.act(f.ctx(ADMIN, "cli"), "web_session_revoke", { id: a.id, all: true })).toMatchObject({ ok: false, error: { code: "bad_request" } });
    expect(f.board.act(f.ctx(ADMIN, "cli"), "web_session_revoke", { id: a.id })).toMatchObject({ ok: true, value: { revoked: [a.id] } });
    expect(f.board.authenticateWebSession(a.cookie, {}).ok).toBe(false);
    expect(f.board.authenticateWebSession(b.cookie, {}).ok).toBe(true);
    expect(f.board.act(f.ctx(ADMIN, "cli"), "web_session_revoke", { all: true })).toMatchObject({ ok: true, value: { revoked: [b.id] } });
    expect(f.board.authenticateWebSession(b.cookie, {}).ok).toBe(false);
    expect(f.board.authenticateWebSession(c.cookie, {}).ok).toBe(true);
    expect(rowsOf(f, "web_session_revoke").filter((r) => r.result === "ok")).toHaveLength(2);
  });

  it("signs out only the calling session, and only from a web session", () => {
    const f = makeFixture();
    const a = signIn(f);
    const b = signIn(f);
    expect(f.board.act(f.ctx(ADMIN, "cli"), "web_sign_out", {})).toMatchObject({ ok: false, result: "denied" });
    expect(f.board.act({ handle: ADMIN, via: "web" }, "web_sign_out", {})).toMatchObject({ ok: false, result: "denied" });
    expect(f.board.act(webCtx(ADMIN, a.id), "web_sign_out", {})).toMatchObject({ ok: true, value: { signed_out: true } });
    expect(f.board.authenticateWebSession(a.cookie, {}).ok).toBe(false);
    expect(f.board.authenticateWebSession(b.cookie, {}).ok).toBe(true);
    expect(rowsOf(f, "web_sign_out").filter((r) => r.result === "ok")).toHaveLength(1);
  });

  it("a person on the web cannot read or write what a bearer-less call may not (agents never get a session)", () => {
    const f = makeFixture();
    f.addUser("alice");
    // An agent's credentials never reach the claim: a pairing approved by an agent is refused above, and a
    // session row for an agent (not made by any action) is refused at sign-in.
    f.sql.exec(
      `INSERT INTO web_sessions (id, handle, token_hash, label, created_at, renewed_at, expires_at)
       VALUES ('ws_a', 'alice', ?, 'l', 1, 1, ?)`,
      sha256("agent-cookie"),
      f.clock.t + DAY,
    );
    expect(f.board.authenticateWebSession("agent-cookie", {})).toMatchObject({ ok: false, reason: "revoked_session" });
  });
});

describe("pruning", () => {
  it("deletes expired pairings and sessions on the timer, audited, and stops when nothing is left", () => {
    const f = makeFixture({ webSessionTtlMs: 2 * DAY });
    const done = signIn(f);
    start(f, "ip:other");
    expect(f.board.nextTimerDue()).not.toBeNull();
    expect(f.sql.one("SELECT COUNT(*) AS n FROM timers WHERE kind = 'web_prune'")).toEqual({ n: 1 });
    // Day 1: the pairings are long expired and go; the session (2 days) stays; the timer runs again.
    f.clock.advance(DAY);
    const r1 = f.board.runDueTimers();
    expect(r1).toHaveLength(1);
    expect(rowsOf(f, "web_prune")[0]).toMatchObject({ actor: "system", result: "ok" });
    expect(JSON.parse(String(rowsOf(f, "web_prune")[0]?.detail))).toEqual({ pairings: 2, sessions: 0, challenges: 0, rearmed: true });
    expect(f.sql.one("SELECT COUNT(*) AS n FROM web_sessions")).toEqual({ n: 1 });
    // Day 2 (the session is renewed by use on day 1.5 only if used; it is not): it expires and goes.
    f.clock.advance(DAY);
    f.board.runDueTimers();
    expect(JSON.parse(String(rowsOf(f, "web_prune")[1]?.detail))).toEqual({ pairings: 0, sessions: 1, challenges: 0, rearmed: false });
    expect(f.sql.one("SELECT COUNT(*) AS n FROM timers WHERE kind = 'web_prune'")).toEqual({ n: 0 });
    expect(f.board.authenticateWebSession(done.cookie, {}).ok).toBe(false);
  });
});

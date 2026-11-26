// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0

/**
 * Passkeys as approvers (issue #54, design §12 "Approving with a passkey"):
 * the three gated actions asking for an approval and running only when a
 * passkey signs their exact scope, who may sign, every check refused by a
 * tampered input, scope binding, single use under concurrency, the limits, the
 * fail-closed rule, the pairing poll, and what is never written down.
 *
 * Passkeys are registered on a board with approval off, then a second board
 * over the same database starts with approval required: the order the deploy
 * docs give.
 */

import { describe, expect, it } from "vitest";
import { Board } from "../src/act.ts";
import { mcpTools } from "../src/tools.ts";
import { DEFAULT_CONFIG, validateConfig, type ActResult, type BoardConfig, type CallContext } from "../src/types.ts";
import { SoftwareAuthenticator, type CeremonyOptions } from "./authenticator.ts";
import { ADMIN, makeBoard, sha256, type Fixture } from "./helpers.ts";

const MIN = 60_000;
const RP = "board.example";
const ORIGIN = "https://board.example";
const SOURCE = "ip:1.1.1.1";
const CLIENT = "https://client.example/oauth/client.json";
const REDIRECT = "https://client.example/callback";
const RESOURCE = "https://api.example/mcp";
const VERIFIER = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ-._~0123";

interface Required {
  approval: string;
  match_code: string;
  status: "approval_required";
  expires_at: number;
}

interface World {
  f: Fixture;
  /** The board with approval required (a second Board over the first one's database). */
  b: Board;
  /** The person's device-bound passkey. */
  auth: SoftwareAuthenticator;
}

/** A web session made by a pairing code, on the board with approval off. */
function pairingSession(f: Fixture, as = ADMIN): CallContext {
  const p = f.board.webPairStart({ source: SOURCE, label: "Chrome on macOS" });
  if (!p.ok) throw new Error("pair start refused");
  if (!f.board.act(f.ctx(as, "cli"), "web_pairing_approve", { code: p.value.code }).ok) throw new Error("approve refused");
  const c = f.board.webPairClaim({ pollSecret: p.value.poll_secret, source: SOURCE });
  if (!c.ok) throw new Error("claim refused");
  return { handle: as, via: "web", webSession: (c.value as { id: string }).id };
}

/** Register a new software passkey for `as` on the board with approval off. */
async function register(f: Fixture, as = ADMIN, o: { backupEligible?: boolean; label?: string } = {}): Promise<SoftwareAuthenticator> {
  const ctx = pairingSession(f, as);
  const started = f.board.passkeyRegisterStart(ctx, { rpId: RP, origin: ORIGIN, source: SOURCE });
  if (!started.ok) throw new Error(`register start refused: ${started.error.message}`);
  const auth = await SoftwareAuthenticator.create("ES256", { backupEligible: o.backupEligible ?? false });
  const credential = auth.register({ challenge: (started.value as { challenge: string }).challenge, rpId: RP, origin: ORIGIN });
  const done = await f.board.passkeyRegisterFinish(ctx, { rpId: RP, origin: ORIGIN, credential, label: o.label ?? "Security key" });
  if (!done.ok) throw new Error(`register refused: ${done.error.message}`);
  return auth;
}

/** A board over the same database with approval settings (and any config) on. */
function restart(f: Fixture, approval: { required?: boolean; allowSynced?: boolean } = { required: true }, config: Partial<BoardConfig> = {}): Board {
  return new Board({ sql: f.sql, now: f.clock.now, sha256, approval, config });
}

async function world(o: { approval?: { required?: boolean; allowSynced?: boolean }; config?: Partial<BoardConfig> } = {}): Promise<World> {
  const f = makeBoard();
  const auth = await register(f);
  return { f, b: restart(f, o.approval, o.config), auth };
}

const cli = (as = ADMIN): CallContext => ({ handle: as, via: "cli" });
const web = (as = ADMIN): CallContext => ({ handle: as, via: "web" });

function required(r: ActResult): Required {
  if (!r.ok) throw new Error(`refused: ${r.error.message}`);
  const v = r.value as Required;
  if (v.status !== "approval_required") throw new Error(`not an approval request: ${JSON.stringify(v)}`);
  return v;
}

/** A pairing, and the approval the CLI's approve call asks for. */
function pairing(w: World, as = ADMIN) {
  const p = w.b.webPairStart({ source: SOURCE, label: "Chrome on macOS" });
  if (!p.ok) throw new Error("pair start refused");
  const ask = w.b.act(cli(as), "web_pairing_approve", { code: p.value.code });
  return { code: p.value.code, poll: p.value.poll_secret, ask };
}

function startOf(b: Board, secret: string) {
  const r = b.approvalStart({ approval: secret, rpId: RP, origin: ORIGIN, source: SOURCE });
  if (!r.ok) throw new Error(`start refused: ${r.error.message}`);
  return r.value as {
    action: string;
    scope: Record<string, unknown>;
    match_code: string;
    expires_at: number;
    publicKey: { challenge: string; rpId: string; userVerification: string; allowCredentials: { type: string; id: string }[]; timeout: number };
  };
}

/** The assertion for the request's challenge (as the page would get from the board), and the finish call. */
async function finish(
  b: Board,
  auth: SoftwareAuthenticator,
  secret: string,
  tamper: Partial<CeremonyOptions> = {},
  o: { origin?: string; rpId?: string; challengeOf?: string } = {},
) {
  const challenge = startOf(b, o.challengeOf ?? secret).publicKey.challenge;
  const credential = await auth.assert({ challenge, rpId: RP, origin: ORIGIN, ...tamper });
  return b.approvalFinish({ approval: secret, rpId: o.rpId ?? RP, origin: o.origin ?? ORIGIN, credential, source: SOURCE });
}

function rowsOf(f: Fixture, action: string) {
  return f.auditRows().filter((r) => r.action === action);
}

/** The audit rows of a gated action that ran under an approval (the earlier, unapproved uses of the action are left out). */
function approvedRows(f: Fixture, action: string) {
  return rowsOf(f, action).filter((r) => String(r.detail).includes('"approval"'));
}

/** A pairing's state, by the code the person typed. */
function pairingState(f: Fixture, code: string): unknown {
  return f.sql.one("SELECT state FROM web_pairings WHERE code_hash = ?", sha256(code.replace("-", "")));
}

function why(r: ActResult): string {
  return r.ok ? "ok" : r.error.message;
}

function oauthRequest(b: Board, over: Record<string, unknown> = {}) {
  const r = b.oauthRequest(web(), {
    response_type: "code",
    client_id: CLIENT,
    redirect_uri: REDIRECT,
    code_challenge: Buffer.from(sha256(VERIFIER), "hex").toString("base64url"),
    code_challenge_method: "S256",
    resource: RESOURCE,
    state: "st-1",
    resource_expected: RESOURCE,
    client_doc: { client_id: CLIENT, client_name: "Claude Test", redirect_uris: [REDIRECT] },
    ...over,
  });
  if (!r.ok) throw new Error(`oauth request refused: ${r.error.message}`);
  return r.value as { request_id: string };
}

describe("with approval off, the three actions behave as before", () => {
  it("approves a pairing, decides a connector and removes a passkey with no approval", async () => {
    const f = makeBoard();
    const auth = await register(f);
    const p = f.board.webPairStart({ source: SOURCE, label: "Chrome on macOS" });
    if (!p.ok) throw new Error("start refused");
    expect(f.board.act(cli(), "web_pairing_approve", { code: p.value.code })).toMatchObject({ ok: true, value: { approved: true, label: "Chrome on macOS" } });
    const c = oauthRequest(f.board);
    expect(f.board.oauthDecide(web(), { request_id: c.request_id, approve: true, handle: "claude-ai" })).toMatchObject({ ok: true, value: { approved: true, handle: "claude-ai" } });
    const id = (f.board.act(cli(), "passkeys", {}) as unknown as { value: { passkeys: { id: string }[] } }).value.passkeys[0]?.id as string;
    expect(f.board.act(cli(), "passkey_remove", { id })).toMatchObject({ ok: true, value: { removed: id } });
    expect(f.sql.one("SELECT COUNT(*) AS n FROM approvals")).toEqual({ n: 0 });
    expect(rowsOf(f, "approval_request")).toEqual([]);
    void auth;
  });

  it("whoami and passkeys say approval is off, and which passkeys could approve", async () => {
    const f = makeBoard();
    await register(f, ADMIN, { backupEligible: false, label: "Key" });
    await register(f, ADMIN, { backupEligible: true, label: "Phone" });
    expect(f.board.act(cli(), "whoami", {})).toMatchObject({ ok: true, value: { approval: { required: false, allow_synced: false } } });
    const listed = f.board.act(cli(), "passkeys", {}) as unknown as {
      value: { passkeys: { label: string; synced: boolean; can_approve: boolean }[]; approval: unknown };
    };
    expect(listed.value.passkeys.map((p) => [p.label, p.synced, p.can_approve])).toEqual([
      ["Key", false, true],
      ["Phone", true, false],
    ]);
    expect(listed.value.approval).toEqual({ required: false, allow_synced: false, approvers: 1 });
  });

  it("whoami reports no approval block for an agent", () => {
    const f = makeBoard();
    f.addUser("alice");
    expect(f.board.act(f.ctx("alice"), "whoami", {})).toMatchObject({ ok: true });
    expect((f.board.act(f.ctx("alice"), "whoami", {}) as unknown as { value: object }).value).not.toHaveProperty("approval");
  });
});

describe("approving a pairing", () => {
  it("asks for an approval and leaves the pairing pending", async () => {
    const w = await world();
    const { code, ask } = pairing(w);
    const req = required(ask);
    expect(req.match_code).toMatch(/^[A-HJKMNP-Z2-9]{6}$/);
    expect(req.approval).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(req.expires_at).toBe(w.f.clock.t + 5 * MIN);
    expect(pairingState(w.f, code)).toEqual({ state: "pending" });
    expect(w.f.sql.one("SELECT COUNT(*) AS n FROM approvals WHERE state = 'pending'")).toEqual({ n: 1 });
  });

  it("still validates the code first: a wrong code is refused as before, with no approval made", async () => {
    const w = await world();
    const r = w.b.act(cli(), "web_pairing_approve", { code: "ZZZZ-ZZZZ" });
    expect(r).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(w.f.sql.one("SELECT COUNT(*) AS n FROM approvals")).toEqual({ n: 0 });
  });

  it("the start gives the scope, match code and request options for the person's approving passkeys", async () => {
    const w = await world();
    const { ask } = pairing(w);
    const req = required(ask);
    const s = startOf(w.b, req.approval);
    expect(s.action).toBe("web_pairing_approve");
    expect(s.scope).toMatchObject({ action: "web_pairing_approve", handle: ADMIN, label: "Chrome on macOS" });
    expect(Object.keys(s.scope)).toEqual(["action", "handle", "pairing", "label"]);
    expect(s.match_code).toBe(req.match_code);
    expect(s.publicKey).toMatchObject({ rpId: RP, userVerification: "required" });
    expect(s.publicKey.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(s.publicKey.allowCredentials).toHaveLength(1);
    // Asking again gives the same challenge: it comes from the stored row, so a page reload works.
    expect(startOf(w.b, req.approval).publicKey.challenge).toBe(s.publicKey.challenge);
  });

  it("a signature approves it: the pairing is approved, the browser's claim makes the session, and the audit says who and how", async () => {
    const w = await world();
    const { poll, ask } = pairing(w);
    const req = required(ask);
    const r = await finish(w.b, w.auth, req.approval);
    expect(r).toMatchObject({ ok: true, value: { status: "approved", action: "web_pairing_approve", result: { approved: true, label: "Chrome on macOS" } } });
    const claimed = w.b.webPairClaim({ pollSecret: poll, source: SOURCE });
    expect(claimed).toMatchObject({ ok: true, value: { status: "approved", handle: ADMIN } });
    const rows = approvedRows(w.f, "web_pairing_approve");
    expect(rows).toHaveLength(1);
    const detail = JSON.parse(String(rows[0]?.detail)) as Record<string, unknown>;
    expect(rows[0]).toMatchObject({ actor: ADMIN, via: "web", result: "ok", target_type: "web_pairing" });
    expect(detail).toMatchObject({ label: "Chrome on macOS", approval: expect.stringMatching(/^ap_/), passkey: expect.stringMatching(/^pk_/) });
    expect(w.f.sql.one("SELECT state, decided_at, passkey FROM approvals")).toMatchObject({ state: "approved" });
  });

  it("the browser's poll hands out the approval, and that id finishes it too", async () => {
    const w = await world();
    const p = w.b.webPairStart({ source: SOURCE, label: "Chrome on macOS" });
    if (!p.ok) throw new Error("start refused");
    const poll = p.value.poll_secret;
    const before = w.b.webPairClaim({ pollSecret: poll, source: SOURCE });
    expect(before).toMatchObject({ ok: true, value: { status: "pending" } });
    expect((before as unknown as { value: object }).value).not.toHaveProperty("approval");
    const req = required(w.b.act(cli(), "web_pairing_approve", { code: p.value.code }));
    const polled = w.b.webPairClaim({ pollSecret: poll, source: SOURCE });
    const v = (polled as unknown as { value: { status: string; approval: string; match_code: string; approval_expires_in_ms: number } }).value;
    expect(v).toMatchObject({ status: "pending", match_code: req.match_code, approval_expires_in_ms: 5 * MIN });
    // The poll's id is not the CLI's id, and is the same on every poll.
    expect(v.approval).not.toBe(req.approval);
    expect((w.b.webPairClaim({ pollSecret: poll, source: SOURCE }) as unknown as { value: { approval: string } }).value.approval).toBe(v.approval);
    expect(startOf(w.b, v.approval).publicKey.challenge).toBe(startOf(w.b, req.approval).publicKey.challenge);
    expect((await finish(w.b, w.auth, v.approval)).ok).toBe(true);
    expect(w.b.webPairClaim({ pollSecret: poll, source: SOURCE })).toMatchObject({ ok: true, value: { status: "approved" } });
  });

  it("nothing stored opens an approval: neither id appears in the database", async () => {
    const w = await world();
    const { poll, ask } = pairing(w);
    const req = required(ask);
    const polled = (w.b.webPairClaim({ pollSecret: poll, source: SOURCE }) as unknown as { value: { approval: string } }).value.approval;
    const dump = JSON.stringify([
      w.f.sql.all("SELECT * FROM approvals"),
      w.f.sql.all("SELECT * FROM web_pairings"),
      w.f.auditRows(),
    ]);
    for (const secret of [req.approval, polled, poll]) expect(dump).not.toContain(secret);
  });

  it("another pairing's poll secret cannot open this approval, and a made-up id opens nothing", async () => {
    const w = await world();
    const { ask } = pairing(w);
    required(ask);
    const other = pairing(w);
    // Make the second request pending too, then show the first poll id does not open the second's approval.
    required(other.ask);
    const a = (w.b.webPairClaim({ pollSecret: other.poll, source: SOURCE }) as unknown as { value: { approval: string } }).value.approval;
    expect(startOf(w.b, a).scope).toMatchObject({ action: "web_pairing_approve" });
    const bad = w.b.approvalStart({ approval: "not-an-approval", rpId: RP, origin: ORIGIN, source: SOURCE });
    expect(bad).toMatchObject({ ok: false, error: { code: "not_found" } });
  });
});

describe("who may approve", () => {
  it("a passkey that can sync is refused by default, and accepted with the stopgap on", async () => {
    const f = makeBoard();
    const synced = await register(f, ADMIN, { backupEligible: true, label: "Phone" });
    await register(f, ADMIN, { label: "Key" });
    const strict = restart(f);
    const lenient = restart(f, { required: true, allowSynced: true });
    for (const [b, ok] of [
      [strict, false],
      [lenient, true],
    ] as const) {
      const p = b.webPairStart({ source: SOURCE, label: "Chrome" });
      if (!p.ok) throw new Error("start refused");
      const req = required(b.act(cli(), "web_pairing_approve", { code: p.value.code }));
      const started = startOf(b, req.approval);
      // Only the device-bound passkey is offered to the browser when the stopgap is off.
      expect(started.publicKey.allowCredentials).toHaveLength(ok ? 2 : 1);
      const assertion = await synced.assert({ challenge: started.publicKey.challenge, rpId: RP, origin: ORIGIN });
      const r = await b.approvalFinish({ approval: req.approval, rpId: RP, origin: ORIGIN, credential: assertion, source: SOURCE });
      expect(r.ok, why(r)).toBe(ok);
      if (!ok) expect(r).toMatchObject({ ok: false, error: { code: "forbidden" } });
    }
  });

  it("a device-bound credential that now says it may sync is not trusted either", async () => {
    const w = await world();
    const { ask } = pairing(w);
    const req = required(ask);
    w.auth.backupEligible = true;
    const r = await finish(w.b, w.auth, req.approval);
    expect(r).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(w.f.sql.one("SELECT state FROM approvals")).toEqual({ state: "pending" });
  });

  it("another person's passkey is refused, and nothing is spent", async () => {
    const f = makeBoard();
    f.addUser("carol", "human");
    const mine = await register(f);
    const hers = await register(f, "carol");
    const w = { f, b: restart(f), auth: mine };
    const { ask } = pairing(w);
    const req = required(ask);
    const r = await finish(w.b, hers, req.approval);
    expect(r).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(f.sql.one("SELECT state FROM approvals")).toEqual({ state: "pending" });
    expect((await finish(w.b, mine, req.approval)).ok).toBe(true);
  });

  it("a person whose account is no longer an active human cannot approve", async () => {
    const w = await world();
    const { ask } = pairing(w);
    const req = required(ask);
    w.f.sql.exec("UPDATE users SET status = 'kicked' WHERE handle = ?", ADMIN);
    expect((await finish(w.b, w.auth, req.approval)).ok).toBe(false);
  });

  it("fails closed: with no passkey that can approve, the gated action is refused and names the two ways out", async () => {
    for (const make of [
      async () => makeBoard(),
      async () => {
        const f = makeBoard();
        await register(f, ADMIN, { backupEligible: true });
        return f;
      },
    ]) {
      const f = await make();
      const b = restart(f);
      const p = b.webPairStart({ source: SOURCE, label: "Chrome" });
      if (!p.ok) throw new Error("start refused");
      const r = b.act(cli(), "web_pairing_approve", { code: p.value.code });
      expect(r).toMatchObject({ ok: false, result: "denied", error: { code: "forbidden" } });
      const message = why(r);
      expect(message).toContain("no passkey that can approve");
      expect(message).toContain("register a device-bound passkey");
      expect(message).toContain("redeploy the board without --require-approval");
      expect(pairingState(f, p.value.code)).toEqual({ state: "pending" });
      expect(f.sql.one("SELECT COUNT(*) AS n FROM approvals")).toEqual({ n: 0 });
    }
  });
});

describe("what the signature is bound to", () => {
  it("refuses a wrong origin, a wrong relying party, a wrong challenge, a wrong type and a bad signature", async () => {
    const w = await world();
    const { ask, code } = pairing(w);
    const req = required(ask);
    const cases: [string, Partial<CeremonyOptions>, { origin?: string; rpId?: string }][] = [
      ["page claims another origin", { clientOrigin: "https://evil.example" }, {}],
      ["board expects another origin", {}, { origin: "https://other.example" }],
      ["authenticator signed another rp id", { signedRpId: "evil.example" }, {}],
      ["board expects another rp id", {}, { rpId: "other.example" }],
      ["wrong challenge", { challenge: "A".repeat(43) }, {}],
      ["wrong ceremony type", { type: "webauthn.create" }, {}],
      ["user not present", { userPresent: false }, {}],
      ["user not verified", { userVerified: false }, {}],
      ["bad signature", { corruptSignature: true }, {}],
    ];
    for (const [name, tamper, o] of cases) {
      const r = await finish(w.b, w.auth, req.approval, tamper, o);
      expect(r.ok, name).toBe(false);
    }
    expect(w.f.sql.one("SELECT state FROM approvals")).toEqual({ state: "pending" });
    expect(pairingState(w.f, code)).toEqual({ state: "pending" });
    // The untouched assertion still works afterwards.
    expect((await finish(w.b, w.auth, req.approval)).ok).toBe(true);
  });

  it("an assertion made for approval A cannot finish approval B", async () => {
    const w = await world();
    const a = required(pairing(w).ask);
    const b = required(pairing(w).ask);
    const forA = await w.auth.assert({ challenge: startOf(w.b, a.approval).publicKey.challenge, rpId: RP, origin: ORIGIN });
    const r = await w.b.approvalFinish({ approval: b.approval, rpId: RP, origin: ORIGIN, credential: forA, source: SOURCE });
    expect(r).toMatchObject({ ok: false });
    expect(w.f.sql.all("SELECT state FROM approvals ORDER BY created_at, rowid")).toEqual([{ state: "pending" }, { state: "pending" }]);
    // The same assertion still finishes A.
    const again = await finish(w.b, w.auth, a.approval);
    expect(again.ok).toBe(true);
  });

  it("the scope covers what the action acts on: the same pairing label with another pairing has another challenge", async () => {
    const w = await world();
    const a = required(pairing(w).ask);
    const b = required(pairing(w).ask);
    expect(startOf(w.b, a.approval).publicKey.challenge).not.toBe(startOf(w.b, b.approval).publicKey.challenge);
    expect(startOf(w.b, a.approval).scope.pairing).not.toBe(startOf(w.b, b.approval).scope.pairing);
  });

  it("an expired request is refused and changes nothing", async () => {
    const w = await world();
    const { ask, code } = pairing(w);
    const req = required(ask);
    const credential = await w.auth.assert({ challenge: startOf(w.b, req.approval).publicKey.challenge, rpId: RP, origin: ORIGIN });
    w.f.clock.advance(5 * MIN + 1);
    const r = await w.b.approvalFinish({ approval: req.approval, rpId: RP, origin: ORIGIN, credential, source: SOURCE });
    expect(r).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(w.b.approvalStart({ approval: req.approval, rpId: RP, origin: ORIGIN, source: SOURCE })).toMatchObject({ ok: false });
    expect(pairingState(w.f, code)).toEqual({ state: "pending" });
  });

  it("two finishes of one request make exactly one success", async () => {
    const w = await world();
    const { ask } = pairing(w);
    const req = required(ask);
    const challenge = startOf(w.b, req.approval).publicKey.challenge;
    const answers = [
      await w.auth.assert({ challenge, rpId: RP, origin: ORIGIN }),
      await w.auth.assert({ challenge, rpId: RP, origin: ORIGIN }),
    ];
    const results = await Promise.all(
      answers.map((credential) => w.b.approvalFinish({ approval: req.approval, rpId: RP, origin: ORIGIN, credential, source: SOURCE })),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(approvedRows(w.f, "web_pairing_approve")).toHaveLength(1);
  });

  it("a sign count that does not increase fails the whole finish, so nothing is spent", async () => {
    const w = await world();
    const { ask, code } = pairing(w);
    const req = required(ask);
    // The stored count is 1 (registration); presenting 1 again is a regression.
    const r = await finish(w.b, w.auth, req.approval, { signCount: 1 });
    expect(r.ok).toBe(false);
    expect(w.f.sql.one("SELECT state FROM approvals")).toEqual({ state: "pending" });
    expect(pairingState(w.f, code)).toEqual({ state: "pending" });
    expect((await finish(w.b, w.auth, req.approval, { signCount: 7 })).ok).toBe(true);
    expect(w.f.sql.one("SELECT sign_count FROM passkeys")).toEqual({ sign_count: 7 });
  });

  it("when the action can no longer run, the whole transaction fails and the request is not spent", async () => {
    const w = await world();
    const { ask, code } = pairing(w);
    const req = required(ask);
    // The pairing runs out between the request and the signature (the request's own time cap is the pairing's).
    w.f.sql.exec("UPDATE web_pairings SET state = 'consumed' WHERE code_hash = ?", sha256(code.replace("-", "")));
    const r = await finish(w.b, w.auth, req.approval);
    expect(r).toMatchObject({ ok: false });
    expect(w.f.sql.one("SELECT state FROM approvals")).toEqual({ state: "pending" });
  });
});

describe("limits", () => {
  it("at most approvalsMaxPending requests per person, a condition of the INSERT", async () => {
    const w = await world({ config: { approvalsMaxPending: 2 } });
    required(pairing(w).ask);
    required(pairing(w).ask);
    const third = pairing(w).ask;
    expect(third).toMatchObject({ ok: false, result: "denied", error: { code: "rate_limited" } });
    expect(w.f.sql.one("SELECT COUNT(*) AS n FROM approvals")).toEqual({ n: 2 });
    // One expires, and there is room again.
    w.f.clock.advance(5 * MIN + 1);
    expect(pairing(w).ask.ok).toBe(true);
  });

  it("a new request for the same target replaces the person's older pending one", async () => {
    const w = await world();
    const p = w.b.webPairStart({ source: SOURCE, label: "Chrome" });
    if (!p.ok) throw new Error("start refused");
    const first = required(w.b.act(cli(), "web_pairing_approve", { code: p.value.code }));
    const second = required(w.b.act(cli(), "web_pairing_approve", { code: p.value.code }));
    expect(second.approval).not.toBe(first.approval);
    expect(w.f.sql.one("SELECT COUNT(*) AS n FROM approvals")).toEqual({ n: 1 });
    expect(w.b.approvalStart({ approval: first.approval, rpId: RP, origin: ORIGIN, source: SOURCE })).toMatchObject({ ok: false });
    expect(w.b.act(cli(), "approval_status", { approval: first.approval })).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect((await finish(w.b, w.auth, second.approval)).ok).toBe(true);
  });

  it("the request never outlives the pairing it approves", async () => {
    const w = await world();
    const p = w.b.webPairStart({ source: SOURCE, label: "Chrome" });
    if (!p.ok) throw new Error("start refused");
    w.f.clock.advance(4 * MIN);
    const req = required(w.b.act(cli(), "web_pairing_approve", { code: p.value.code }));
    expect(req.expires_at).toBe(w.f.clock.t + MIN);
  });

  it("the approval limits are validated", () => {
    expect(validateConfig({ ...DEFAULT_CONFIG, approvalTtlMs: 61 * MIN })).toMatch(/approvalTtlMs/);
    expect(validateConfig({ ...DEFAULT_CONFIG, approvalsMaxPending: 21 })).toMatch(/approvalsMaxPending/);
    expect(validateConfig({ ...DEFAULT_CONFIG, approvalsMaxPending: 0 })).toMatch(/approvalsMaxPending/);
    expect(validateConfig({ ...DEFAULT_CONFIG })).toBeUndefined();
  });

  it("the prune timer deletes expired requests", async () => {
    const w = await world();
    required(pairing(w).ask);
    w.f.clock.advance(25 * 60 * MIN);
    w.b.runDueTimers();
    expect(w.f.sql.one("SELECT COUNT(*) AS n FROM approvals")).toEqual({ n: 0 });
    expect(JSON.parse(String(rowsOf(w.f, "web_prune").at(-1)?.detail))).toMatchObject({ approvals: 1 });
  });

  it("retiring a person's passkeys deletes their waiting requests", async () => {
    const f = makeBoard();
    const auth = await register(f);
    const w = { f, b: restart(f), auth };
    required(pairing(w).ask);
    f.sql.exec("DELETE FROM approvals WHERE 0");
    w.b.bootstrapHuman("owner2", sha256("another credential"));
    expect(f.sql.one("SELECT COUNT(*) AS n FROM approvals")).toEqual({ n: 0 });
  });
});

describe("approving a connector", () => {
  it("an approve asks for an approval and leaves the request pending; the signature grants the connector", async () => {
    const w = await world();
    const c = oauthRequest(w.b);
    const asked = required(w.b.oauthDecide(web(), { request_id: c.request_id, approve: true, handle: "claude-ai" }));
    expect(w.f.sql.one("SELECT consumed_at FROM oauth_requests")).toEqual({ consumed_at: null });
    expect(w.f.sql.one("SELECT COUNT(*) AS n FROM oauth_grants")).toEqual({ n: 0 });
    const s = startOf(w.b, asked.approval);
    expect(s.scope).toMatchObject({
      action: "oauth_decide",
      handle: ADMIN,
      client: CLIENT,
      client_name: "Claude Test",
      agent: "claude-ai",
      redirect_origin: "https://client.example",
    });
    expect(Object.keys(s.scope)).toEqual(["action", "handle", "request", "client", "client_name", "agent", "redirect_origin"]);
    const r = await finish(w.b, w.auth, asked.approval);
    expect(r).toMatchObject({
      ok: true,
      value: { status: "approved", action: "oauth_decide", result: { approved: true, handle: "claude-ai", redirect_uri: REDIRECT, state: "st-1", created: true } },
    });
    const code = ((r as unknown as { value: { result: { code: string } } }).value.result).code;
    expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(w.f.sql.one("SELECT COUNT(*) AS n FROM oauth_grants")).toEqual({ n: 1 });
    const row = rowsOf(w.f, "oauth_decide").at(-1);
    expect(row).toMatchObject({ actor: ADMIN, via: "web", result: "ok", target_type: "oauth_grant" });
    expect(JSON.parse(String(row?.detail))).toMatchObject({ handle: "claude-ai", approval: expect.stringMatching(/^ap_/), passkey: expect.stringMatching(/^pk_/) });
    expect(String(row?.detail)).not.toContain(code);
  });

  it("a deny is not gated", async () => {
    const w = await world();
    const c = oauthRequest(w.b);
    expect(w.b.oauthDecide(web(), { request_id: c.request_id, approve: false })).toMatchObject({ ok: true, value: { approved: false } });
    expect(w.f.sql.one("SELECT COUNT(*) AS n FROM approvals")).toEqual({ n: 0 });
  });

  it("validates what decide always did before it asks: unknown request, a person's handle, a removed agent", async () => {
    const w = await world();
    expect(w.b.oauthDecide(web(), { request_id: "nope", approve: true, handle: "claude-ai" })).toMatchObject({ ok: false, error: { code: "not_found" } });
    const c = oauthRequest(w.b);
    expect(w.b.oauthDecide(web(), { request_id: c.request_id, approve: true, handle: ADMIN })).toMatchObject({ ok: false });
    expect(w.f.sql.one("SELECT COUNT(*) AS n FROM approvals")).toEqual({ n: 0 });
  });

  it("the request decided in between makes the finish fail and the approval stays unspent", async () => {
    const w = await world();
    const c = oauthRequest(w.b);
    const asked = required(w.b.oauthDecide(web(), { request_id: c.request_id, approve: true, handle: "claude-ai" }));
    w.f.sql.exec("UPDATE oauth_requests SET consumed_at = 1");
    expect((await finish(w.b, w.auth, asked.approval)).ok).toBe(false);
    expect(w.f.sql.one("SELECT state FROM approvals")).toEqual({ state: "pending" });
    expect(w.f.sql.one("SELECT COUNT(*) AS n FROM oauth_grants")).toEqual({ n: 0 });
  });
});

describe("removing a passkey", () => {
  it("removing a passkey that can approve is gated; one that cannot keeps today's rules", async () => {
    const f = makeBoard();
    const key = await register(f, ADMIN, { label: "Key" });
    await register(f, ADMIN, { backupEligible: true, label: "Phone" });
    const b = restart(f);
    const listed = () => (b.act(cli(), "passkeys", {}) as unknown as { value: { passkeys: { id: string; label: string }[] } }).value.passkeys;
    const [keyId, phoneId] = [listed()[0]?.id as string, listed()[1]?.id as string];
    // The synced phone cannot approve: removed at once.
    expect(b.act(cli(), "passkey_remove", { id: phoneId })).toMatchObject({ ok: true, value: { removed: phoneId } });
    expect(f.sql.one("SELECT COUNT(*) AS n FROM approvals")).toEqual({ n: 0 });
    // The key can: it asks.
    const asked = required(b.act(cli(), "passkey_remove", { id: keyId }));
    expect(f.sql.one("SELECT COUNT(*) AS n FROM passkeys")).toEqual({ n: 1 });
    const s = startOf(b, asked.approval);
    expect(s.scope).toEqual({ action: "passkey_remove", handle: ADMIN, passkey: keyId, label: "Key" });
    // The passkey being removed may sign its own removal.
    const r = await finish(b, key, asked.approval);
    expect(r).toMatchObject({ ok: true, value: { status: "approved", action: "passkey_remove", result: { removed: keyId } } });
    expect(f.sql.one("SELECT COUNT(*) AS n FROM passkeys")).toEqual({ n: 0 });
    const row = rowsOf(f, "passkey_remove").at(-1);
    expect(row).toMatchObject({ actor: ADMIN, via: "web", result: "ok" });
    expect(JSON.parse(String(row?.detail))).toMatchObject({ label: "Key", approval: expect.stringMatching(/^ap_/), passkey: keyId });
  });

  it("any approver passkey of the person may sign the removal of another", async () => {
    const f = makeBoard();
    const one = await register(f, ADMIN, { label: "One" });
    await register(f, ADMIN, { label: "Two" });
    const b = restart(f);
    const ids = (b.act(cli(), "passkeys", {}) as unknown as { value: { passkeys: { id: string }[] } }).value.passkeys.map((p) => p.id);
    const asked = required(b.act(cli(), "passkey_remove", { id: ids[1] }));
    expect((await finish(b, one, asked.approval)).ok).toBe(true);
    expect(f.sql.all("SELECT id FROM passkeys")).toEqual([{ id: ids[0] }]);
  });

  it("a missing passkey is not_found as before", async () => {
    const w = await world();
    expect(w.b.act(cli(), "passkey_remove", { id: "pk_missing" })).toMatchObject({ ok: false, error: { code: "not_found" } });
  });

  it("the last-passkey rule of the surface that asked still holds: from the web view it is refused when the finish runs", async () => {
    const w = await world();
    const id = (w.b.act(cli(), "passkeys", {}) as unknown as { value: { passkeys: { id: string }[] } }).value.passkeys[0]?.id as string;
    const asked = required(w.b.act(web(), "passkey_remove", { id }));
    const r = await finish(w.b, w.auth, asked.approval);
    expect(r).toMatchObject({ ok: false });
    expect(why(r)).toContain("only available from the bbs CLI");
    expect(w.f.sql.one("SELECT COUNT(*) AS n FROM passkeys")).toEqual({ n: 1 });
    expect(w.f.sql.one("SELECT state FROM approvals")).toEqual({ state: "pending" });
  });
});

describe("bbs_approval_status", () => {
  it("reports pending, approved and expired with the action, match code and expiry, never the result", async () => {
    const w = await world();
    const req = required(pairing(w).ask);
    const status = (secret = req.approval) => w.b.act(cli(), "approval_status", { approval: secret }) as unknown as { ok: boolean; value: Record<string, unknown>; auditSeq?: number };
    expect(status()).toMatchObject({ ok: true, value: { status: "pending", action: "web_pairing_approve", match_code: req.match_code, expires_at: req.expires_at } });
    expect(status().auditSeq).toBeUndefined();
    expect((await finish(w.b, w.auth, req.approval)).ok).toBe(true);
    expect(status().value).toEqual({ status: "approved", action: "web_pairing_approve", match_code: req.match_code, expires_at: req.expires_at });
    const other = required(pairing(w).ask);
    w.f.clock.advance(5 * MIN + 1);
    expect(status(other.approval).value).toMatchObject({ status: "expired" });
  });

  it("is for the person the request was made for, from the CLI or the web view only", async () => {
    const f = makeBoard();
    f.addUser("carol", "human");
    f.addUser("alice");
    const auth = await register(f);
    const w = { f, b: restart(f), auth };
    const req = required(pairing(w).ask);
    expect(w.b.act(cli("carol"), "approval_status", { approval: req.approval })).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(w.b.act(f.ctx("alice"), "approval_status", { approval: req.approval })).toMatchObject({ ok: false, result: "denied" });
    expect(w.b.act({ handle: ADMIN, via: "api" }, "approval_status", { approval: req.approval })).toMatchObject({ ok: false });
    expect(w.b.act(web(), "approval_status", { approval: req.approval }).ok).toBe(true);
  });

  it("is not offered on /mcp", () => {
    expect(mcpTools().map((t) => t.name)).not.toContain("bbs_approval_status");
  });
});

describe("what is audited, and what is never", () => {
  it("a request is one approval_request row with the scope; no secret id, nonce or challenge anywhere in the audit", async () => {
    const w = await world();
    const { ask } = pairing(w);
    const req = required(ask);
    const s = startOf(w.b, req.approval);
    const nonce = (w.f.sql.one("SELECT nonce FROM approvals") as { nonce: string }).nonce;
    await finish(w.b, w.auth, req.approval);
    const rows = rowsOf(w.f, "approval_request");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor: ADMIN, via: "cli", result: "ok", target_type: "approval" });
    const detail = JSON.parse(String(rows[0]?.detail)) as { action: string; scope: Record<string, unknown> };
    expect(detail.action).toBe("web_pairing_approve");
    expect(detail.scope).toEqual(s.scope);
    expect(rows[0]?.target_id).toMatch(/^ap_/);
    // The request is not audited under the gated action's name; only the approved change is.
    expect(approvedRows(w.f, "web_pairing_approve")).toHaveLength(1);
    const everything = JSON.stringify(w.f.auditRows());
    for (const secret of [req.approval, nonce, s.publicKey.challenge]) expect(everything).not.toContain(secret);
  });

  it("refusals at the two unauthenticated endpoints go through the failed sign-in guards, not a row per request", async () => {
    const w = await world();
    const req = required(pairing(w).ask);
    const before = w.f.auditRows().length;
    for (let i = 0; i < 60; i++) {
      const r = w.b.approvalStart({ approval: `unknown-${i}`, rpId: RP, origin: ORIGIN, source: "flood" });
      expect(r.ok).toBe(false);
    }
    const wrong = await finish(w.b, w.auth, req.approval, { corruptSignature: true });
    expect(wrong.ok).toBe(false);
    const rows = w.f.auditRows().slice(before);
    // Rows are the guards' own: the first few `auth` rows, one `sign_in_limited`; never one per request.
    expect(rows.length).toBeLessThan(30);
    expect(new Set(rows.map((r) => r.action))).toEqual(new Set(["auth", "sign_in_limited"]));
    const reasons = rows.filter((r) => r.action === "auth").map((r) => (JSON.parse(String(r.detail)) as { reason: string }).reason);
    expect(reasons.some((r) => r.endsWith("approval_not_pending"))).toBe(true);
  });

  it("the refusal reasons are recorded: not pending, bad signature and a synced passkey", async () => {
    const f = makeBoard();
    const synced = await register(f, ADMIN, { backupEligible: true });
    const key = await register(f);
    const b = restart(f);
    const p = b.webPairStart({ source: SOURCE, label: "Chrome" });
    if (!p.ok) throw new Error("start refused");
    const req = required(b.act(cli(), "web_pairing_approve", { code: p.value.code }));
    await finish(b, key, req.approval, { corruptSignature: true });
    const assertion = await synced.assert({ challenge: startOf(b, req.approval).publicKey.challenge, rpId: RP, origin: ORIGIN });
    await b.approvalFinish({ approval: req.approval, rpId: RP, origin: ORIGIN, credential: assertion, source: SOURCE });
    b.approvalStart({ approval: "gone", rpId: RP, origin: ORIGIN, source: SOURCE });
    const reasons = f
      .auditRows()
      .filter((r) => r.action === "auth")
      .map((r) => (JSON.parse(String(r.detail)) as { reason: string }).reason);
    expect(reasons.map((r) => r.replace("authentication failed: ", ""))).toEqual(["approval_bad_signature", "approval_passkey_synced", "approval_not_pending"]);
  });
});

/** Register a software passkey on the board `b` (approval required there), from a web session made on the off board. */
async function registerOn(f: Fixture, b: Board, label = "Late key"): Promise<{ auth: SoftwareAuthenticator; result: ActResult }> {
  const ctx = pairingSession(f);
  const started = b.passkeyRegisterStart(ctx, { rpId: RP, origin: ORIGIN, source: SOURCE });
  if (!started.ok) throw new Error(`register start refused: ${started.error.message}`);
  const auth = await SoftwareAuthenticator.create("ES256", { backupEligible: false });
  const credential = auth.register({ challenge: (started.value as { challenge: string }).challenge, rpId: RP, origin: ORIGIN });
  return { auth, result: await b.passkeyRegisterFinish(ctx, { rpId: RP, origin: ORIGIN, credential, label }) };
}

describe("a passkey registered while approval is required can never approve", () => {
  it("is registered as unable to approve, says so, and does not count as an approver", async () => {
    const w = await world();
    const { result } = await registerOn(w.f, w.b);
    expect(result).toMatchObject({ ok: true, value: { label: "Late key", synced: false, can_approve: false } });
    const row = rowsOf(w.f, "passkey_register").at(-1);
    expect(JSON.parse(String(row?.detail))).toMatchObject({ can_approve: false });
    expect(w.f.sql.all("SELECT label, approver_barred FROM passkeys ORDER BY created_at, rowid")).toEqual([
      { label: "Security key", approver_barred: 0 },
      { label: "Late key", approver_barred: 1 },
    ]);
    const listed = w.b.act(cli(), "passkeys", {}) as unknown as { value: { passkeys: { label: string; can_approve: boolean }[]; approval: { approvers: number } } };
    expect(listed.value.passkeys.map((p) => [p.label, p.can_approve])).toEqual([
      ["Security key", true],
      ["Late key", false],
    ]);
    expect(listed.value.approval.approvers).toBe(1);
  });

  it("is refused at finish in both modes, and is not offered in allowCredentials", async () => {
    for (const approval of [{ required: true }, { required: true, allowSynced: true }]) {
      const f = makeBoard();
      await register(f);
      const b = restart(f, approval);
      const { auth: late } = await registerOn(f, b);
      const w = { f, b, auth: late };
      const req = required(pairing(w).ask);
      const started = startOf(b, req.approval);
      expect(started.publicKey.allowCredentials).toHaveLength(1);
      const r = await finish(b, late, req.approval);
      expect(r).toMatchObject({ ok: false, error: { code: "forbidden" } });
      expect(why(r)).toBe("that passkey was registered while approval was required, so it cannot approve; register it again while approval is off");
      expect(f.sql.one("SELECT state FROM approvals")).toEqual({ state: "pending" });
      const reasons = f.auditRows().filter((x) => x.action === "auth").map((x) => String(x.detail));
      expect(reasons.some((d) => d.includes("approval_passkey_barred"))).toBe(true);
    }
  });

  it("with only such keys the board fails closed, and removing one is not gated", async () => {
    const f = makeBoard();
    const b = restart(f);
    await registerOn(f, b);
    const p = b.webPairStart({ source: SOURCE, label: "Chrome" });
    if (!p.ok) throw new Error("start refused");
    expect(b.act(cli(), "web_pairing_approve", { code: p.value.code })).toMatchObject({ ok: false, result: "denied" });
    const id = (b.act(cli(), "passkeys", {}) as unknown as { value: { passkeys: { id: string }[] } }).value.passkeys[0]?.id as string;
    expect(b.act(cli(), "passkey_remove", { id })).toMatchObject({ ok: true, value: { removed: id } });
    expect(f.sql.one("SELECT COUNT(*) AS n FROM approvals")).toEqual({ n: 0 });
  });

  it("the finish write re-checks: a key barred after the check cannot sign", async () => {
    const w = await world();
    const req = required(pairing(w).ask);
    const credential = await w.auth.assert({ challenge: startOf(w.b, req.approval).publicKey.challenge, rpId: RP, origin: ORIGIN });
    w.f.sql.exec("UPDATE passkeys SET approver_barred = 1");
    const r = await w.b.approvalFinish({ approval: req.approval, rpId: RP, origin: ORIGIN, credential, source: SOURCE });
    expect(r.ok).toBe(false);
    expect(w.f.sql.one("SELECT state FROM approvals")).toEqual({ state: "pending" });
  });
});

describe("refusal messages and the connector's name", () => {
  it("another person's passkey and an unknown one get the same message", async () => {
    const f = makeBoard();
    f.addUser("carol", "human");
    const mine = await register(f);
    const hers = await register(f, "carol");
    const w = { f, b: restart(f), auth: mine };
    const req = required(pairing(w).ask);
    const stranger = await SoftwareAuthenticator.create("ES256");
    const a = await finish(w.b, hers, req.approval);
    const b = await finish(w.b, stranger, req.approval);
    expect(why(a)).toBe("that passkey was not accepted for this approval");
    expect(why(b)).toBe(why(a));
  });

  it("refuses to grant a connector whose name changed after the approval was requested", async () => {
    const w = await world();
    const c = oauthRequest(w.b);
    const asked = required(w.b.oauthDecide(web(), { request_id: c.request_id, approve: true, handle: "claude-ai" }));
    // A later authorization request for the same client stores a new name from a fresh document.
    oauthRequest(w.b, { client_doc: { client_id: CLIENT, client_name: "Renamed Client", redirect_uris: [REDIRECT] } });
    const r = await finish(w.b, w.auth, asked.approval);
    expect(why(r)).toContain("the client's details changed after the approval was requested; start again");
    expect(w.f.sql.one("SELECT COUNT(*) AS n FROM oauth_grants")).toEqual({ n: 0 });
    expect(w.f.sql.one("SELECT state FROM approvals WHERE id IN (SELECT id FROM approvals ORDER BY created_at LIMIT 1)")).toEqual({ state: "pending" });
  });
});

// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0

/**
 * Passkey sign-in (issue #54): registering a passkey from a pairing session,
 * signing in with it, every check refused by a tampered input, the limits, the
 * single-use challenge, removal, and what is never written down.
 */

import { describe, expect, it } from "vitest";
import { revokePasskeys } from "../src/actions/web-session.ts";
import { callTool } from "../src/tools.ts";
import type { ActResult, BoardConfig, CallContext } from "../src/types.ts";
import { b64u, cbor, SoftwareAuthenticator, type Alg, type CeremonyOptions } from "./authenticator.ts";
import { ADMIN, makeBoard, sha256, type Fixture } from "./helpers.ts";

const MIN = 60_000;
const RP = "board.example";
const ORIGIN = "https://board.example";
const SOURCE = "ip:1.1.1.1";

interface Session {
  cookie: string;
  id: string;
  ctx: CallContext;
}

/** A web session made by a pairing code, as the person gets by `bbs web-login`. */
function pairingSession(f: Fixture, as = ADMIN): Session {
  const p = f.board.webPairStart({ source: SOURCE, label: "Chrome on macOS" });
  if (!p.ok) throw new Error("pair start refused");
  if (!f.board.act(f.ctx(as, "cli"), "web_pairing_approve", { code: p.value.code }).ok) throw new Error("approve refused");
  const c = f.board.webPairClaim({ pollSecret: p.value.poll_secret, source: SOURCE });
  if (!c.ok) throw new Error("claim refused");
  const v = c.value as { session: string; id: string };
  return { cookie: v.session, id: v.id, ctx: { handle: as, via: "web", webSession: v.id } };
}

function makeFixture(config: Partial<BoardConfig> = {}): Fixture {
  return makeBoard({ config });
}

function start(f: Fixture, s: Session) {
  const r = f.board.passkeyRegisterStart(s.ctx, { rpId: RP, origin: ORIGIN, source: SOURCE });
  if (!r.ok) throw new Error(`register start refused: ${r.error.message}`);
  return r.value as { challenge: string; user: { id: string; name: string }; excludeCredentials: { id: string }[] };
}

/** Register `auth` for the session's person; `tamper` changes what the authenticator writes. */
async function register(f: Fixture, s: Session, auth: SoftwareAuthenticator, tamper: Partial<CeremonyOptions> = {}, label?: string): Promise<ActResult> {
  const { challenge } = start(f, s);
  const credential = auth.register({ challenge, rpId: RP, origin: ORIGIN, ...tamper });
  return f.board.passkeyRegisterFinish(s.ctx, { rpId: RP, origin: ORIGIN, credential, ...(label !== undefined ? { label } : {}) });
}

async function registered(f: Fixture, s: Session, alg: Alg = "ES256", o: ConstructorParameters<typeof Object>[0] = {}) {
  const auth = await SoftwareAuthenticator.create(alg, o as never);
  const r = await register(f, s, auth);
  if (!r.ok) throw new Error(`register refused: ${r.error.message}`);
  return auth;
}

function signinStart(f: Fixture, source = SOURCE) {
  const r = f.board.passkeySigninStart({ rpId: RP, origin: ORIGIN, source });
  if (!r.ok) throw new Error(`sign-in start refused: ${r.error.message}`);
  return r.value as { challenge: string; rpId: string; allowCredentials: unknown[]; userVerification: string };
}

async function signIn(f: Fixture, auth: SoftwareAuthenticator, tamper: Partial<CeremonyOptions> = {}, source = SOURCE) {
  const { challenge } = signinStart(f, source);
  const credential = await auth.assert({ challenge, rpId: RP, origin: ORIGIN, ...tamper });
  return f.board.passkeySigninFinish({ rpId: RP, origin: ORIGIN, credential, label: "Safari on iPhone", source });
}

function rowsOf(f: Fixture, action: string) {
  return f.auditRows().filter((r) => r.action === action);
}

function why(r: ActResult): string {
  return r.ok ? "ok" : r.error.message;
}

describe.each<Alg>(["ES256", "RS256"])("register and sign in with %s", (alg) => {
  it("registers from a pairing session, then signs a new browser in; the session is a passkey session", async () => {
    const f = makeFixture();
    const s = pairingSession(f);
    const options = start(f, s);
    expect(options).toMatchObject({
      rp: { id: RP, name: "BBS-5000" },
      user: { name: ADMIN },
      attestation: "none",
      authenticatorSelection: { residentKey: "required", requireResidentKey: true, userVerification: "required" },
      pubKeyCredParams: [{ alg: -7 }, { alg: -257 }],
    });
    // The user id is a random value the board made, never the handle.
    expect(options.user.id).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(options.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const auth = await SoftwareAuthenticator.create(alg);
    const credential = auth.register({ challenge: options.challenge, rpId: RP, origin: ORIGIN });
    const reg = await f.board.passkeyRegisterFinish(s.ctx, { rpId: RP, origin: ORIGIN, credential, label: "My laptop" });
    expect(reg).toMatchObject({ ok: true, value: { label: "My laptop", synced: false } });

    const challenge = signinStart(f);
    expect(challenge).toMatchObject({ rpId: RP, allowCredentials: [], userVerification: "required" });
    const answer = await auth.assert({ challenge: challenge.challenge, rpId: RP, origin: ORIGIN, userHandle: options.user.id });
    const r = await f.board.passkeySigninFinish({ rpId: RP, origin: ORIGIN, credential: answer, label: "Safari on iPhone", source: SOURCE });
    expect(r).toMatchObject({ ok: true, value: { status: "approved", handle: ADMIN, max_age_ms: 30 * 24 * 60 * MIN } });
    const v = (r as unknown as { value: { session: string; id: string } }).value;
    expect(v.session).toMatch(/^[A-Za-z0-9_-]{43}$/);

    expect(f.board.authenticateWebSession(v.session, { source: SOURCE })).toEqual({ ok: true, handle: ADMIN, kind: "human", webSession: v.id });
    expect(f.sql.one("SELECT method, label FROM web_sessions WHERE id = ?", v.id)).toEqual({ method: "passkey", label: "Safari on iPhone" });
    expect(f.sql.one("SELECT method FROM web_sessions WHERE id = ?", s.id)).toEqual({ method: "pairing" });
    expect(f.board.act({ handle: ADMIN, via: "web", webSession: v.id }, "whoami", {})).toMatchObject({ ok: true, value: { handle: ADMIN, via: "web" } });
  });

  it("each sign-in advances the sign count and last-used time; a successful one writes one audited row", async () => {
    const f = makeFixture();
    const auth = await registered(f, pairingSession(f), alg);
    f.clock.advance(5 * MIN);
    expect((await signIn(f, auth)).ok).toBe(true);
    expect(f.sql.one("SELECT sign_count, last_used_at FROM passkeys")).toEqual({ sign_count: 2, last_used_at: f.clock.t });
    expect((await signIn(f, auth)).ok).toBe(true);
    expect(f.sql.one("SELECT sign_count FROM passkeys")).toEqual({ sign_count: 3 });
    expect(rowsOf(f, "passkey_signin")).toHaveLength(2);
    expect(rowsOf(f, "passkey_signin")[0]).toMatchObject({ actor: ADMIN, via: "web", result: "ok", target_type: "web_session" });
  });
});

describe("registration details", () => {
  it("accepts an attestation of any format and ignores its statement", async () => {
    const f = makeFixture();
    const s = pairingSession(f);
    const auth = await SoftwareAuthenticator.create("ES256");
    expect((await register(f, s, auth, { fmt: "packed" })).ok).toBe(true);
  });

  it("records the backup-eligible flag and lists it as synced: true, and a device-bound one as synced: false", async () => {
    const f = makeFixture();
    const s = pairingSession(f);
    const synced = await SoftwareAuthenticator.create("ES256", { backupEligible: true, backupState: true });
    const bound = await SoftwareAuthenticator.create("ES256");
    expect((await register(f, s, synced, {}, "Phone")).ok).toBe(true);
    expect((await register(f, s, bound, {}, "Security key")).ok).toBe(true);
    expect(f.sql.all("SELECT label, backup_eligible, backup_state FROM passkeys ORDER BY created_at, rowid")).toEqual([
      { label: "Phone", backup_eligible: 1, backup_state: 1 },
      { label: "Security key", backup_eligible: 0, backup_state: 0 },
    ]);
    const listed = f.board.act(f.ctx(ADMIN, "cli"), "passkeys", {});
    expect(listed).toMatchObject({ ok: true });
    const v = (listed as unknown as { value: { passkeys: { label: string; synced: boolean; transports: string[] }[] } }).value;
    expect(v.passkeys.map((p) => [p.label, p.synced])).toEqual([["Phone", true], ["Security key", false]]);
    expect(v.passkeys[0]?.transports).toEqual(["internal", "hybrid"]);
    // Through the tool the times are ISO text.
    const tool = callTool(f.board, f.ctx(ADMIN, "cli"), "bbs_passkeys", {}, "cli");
    const first = (tool.structuredContent.passkeys as { created_at: string; last_used_at: unknown }[])[0];
    expect(first?.created_at).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(first?.last_used_at).toBeNull();
  });

  it("cleans the label and falls back to 'passkey'", async () => {
    const f = makeFixture();
    const s = pairingSession(f);
    expect((await register(f, s, await SoftwareAuthenticator.create("ES256"), {}, "  Lap‮top\u0007  "))).toMatchObject({ ok: true, value: { label: "Laptop" } });
    expect((await register(f, s, await SoftwareAuthenticator.create("ES256"), {}, ""))).toMatchObject({ ok: true, value: { label: "passkey" } });
  });

  it("excludes the credentials the person already has, and keeps one user id", async () => {
    const f = makeFixture();
    const s = pairingSession(f);
    const first = await registered(f, s);
    const options = start(f, s);
    expect(options.excludeCredentials.map((c) => c.id)).toEqual([b64u(first.credentialId)]);
    expect(start(f, s).user.id).toBe(options.user.id);
  });
});

describe("registration is refused", () => {
  const refused: [string, Partial<CeremonyOptions>, string][] = [
    ["a wrong origin", { clientOrigin: "https://evil.example" }, "client_data_wrong_origin"],
    ["a wrong relying party id", { signedRpId: "evil.example" }, "wrong_rp_id"],
    ["a wrong ceremony type", { type: "webauthn.get" }, "client_data_wrong_type"],
    ["no user verification", { userVerified: false }, "user_not_verified"],
    ["no user presence", { userPresent: false }, "user_not_present"],
    ["a challenge the board never made", { challenge: b64u(new Uint8Array(32).fill(7)) }, "challenge_not_pending"],
  ];
  it.each(refused)("for %s", async (_name, tamper, reason) => {
    const f = makeFixture();
    const s = pairingSession(f);
    const r = await register(f, s, await SoftwareAuthenticator.create("ES256"), tamper);
    expect(r.ok).toBe(false);
    expect(why(r)).toBe("that passkey was not accepted");
    expect(JSON.parse(String(rowsOf(f, "passkey_register").at(-1)?.detail))).toMatchObject({ why: reason });
    expect(rowsOf(f, "passkey_register").at(-1)).toMatchObject({ result: "denied", actor: ADMIN });
    expect(f.sql.one("SELECT COUNT(*) AS n FROM passkeys")).toEqual({ n: 0 });
  });

  it("for a replayed challenge", async () => {
    const f = makeFixture();
    const s = pairingSession(f);
    const auth = await SoftwareAuthenticator.create("ES256");
    const { challenge } = start(f, s);
    const credential = auth.register({ challenge, rpId: RP, origin: ORIGIN });
    expect((await f.board.passkeyRegisterFinish(s.ctx, { rpId: RP, origin: ORIGIN, credential })).ok).toBe(true);
    const again = await f.board.passkeyRegisterFinish(s.ctx, { rpId: RP, origin: ORIGIN, credential });
    expect(again.ok).toBe(false);
    expect(JSON.parse(String(rowsOf(f, "passkey_register").at(-1)?.detail))).toMatchObject({ why: "challenge_not_pending" });
  });

  it("for an expired challenge", async () => {
    const f = makeFixture();
    const s = pairingSession(f);
    const auth = await SoftwareAuthenticator.create("ES256");
    const { challenge } = start(f, s);
    const credential = auth.register({ challenge, rpId: RP, origin: ORIGIN });
    f.clock.advance(5 * MIN + 1);
    expect((await f.board.passkeyRegisterFinish(s.ctx, { rpId: RP, origin: ORIGIN, credential })).ok).toBe(false);
    expect(f.sql.one("SELECT COUNT(*) AS n FROM passkeys")).toEqual({ n: 0 });
  });

  it("for a credential id that is already registered", async () => {
    const f = makeFixture();
    const s = pairingSession(f);
    const auth = await registered(f, s);
    const again = await register(f, s, auth);
    expect(again.ok).toBe(false);
    expect(JSON.parse(String(rowsOf(f, "passkey_register").at(-1)?.detail))).toMatchObject({ why: "credential_already_registered" });
    expect(f.sql.one("SELECT COUNT(*) AS n FROM passkeys")).toEqual({ n: 1 });
  });

  it("for an RSA key under 2048 bits, and for a key of another algorithm", async () => {
    const f = makeFixture();
    const s = pairingSession(f);
    const weak = await SoftwareAuthenticator.create("RS256", { modulusLength: 1024 });
    expect((await register(f, s, weak)).ok).toBe(false);
    expect(JSON.parse(String(rowsOf(f, "passkey_register").at(-1)?.detail))).toMatchObject({ why: "public_key_too_weak" });
    // An EdDSA (COSE -8) key: the answer is well formed but the algorithm is not allowed.
    const odd = await SoftwareAuthenticator.create("ES256");
    odd.cose = () => cbor({ map: [[1, 1], [3, -8], [-1, 6], [-2, new Uint8Array(32)]] });
    expect((await register(f, s, odd)).ok).toBe(false);
    expect(JSON.parse(String(rowsOf(f, "passkey_register").at(-1)?.detail))).toMatchObject({ why: "public_key_algorithm_not_allowed" });
  });

  it("for a malformed answer", async () => {
    const f = makeFixture();
    const s = pairingSession(f);
    start(f, s);
    for (const credential of [undefined, "x", {}, { id: "AAAA", response: {} }, { id: "AAAA", response: { clientDataJSON: "AAAA", attestationObject: "AAAA" } }]) {
      const r = await f.board.passkeyRegisterFinish(s.ctx, { rpId: RP, origin: ORIGIN, credential });
      expect(r.ok, JSON.stringify(credential)).toBe(false);
    }
  });

  it("from a session another person's challenge was made for, and from a session that is not the one that asked", async () => {
    const f = makeFixture();
    f.addUser("pat", "human");
    const mine = pairingSession(f);
    const theirs = pairingSession(f);
    const auth = await SoftwareAuthenticator.create("ES256");
    const { challenge } = start(f, mine);
    const credential = auth.register({ challenge, rpId: RP, origin: ORIGIN });
    expect((await f.board.passkeyRegisterFinish(theirs.ctx, { rpId: RP, origin: ORIGIN, credential })).ok).toBe(false);
    expect((await f.board.passkeyRegisterFinish(mine.ctx, { rpId: RP, origin: ORIGIN, credential })).ok).toBe(true);
  });

  it("for an agent account, and from anywhere but a web session", async () => {
    const f = makeFixture();
    f.addUser("alice");
    const r = f.board.passkeyRegisterStart({ handle: "alice", via: "mcp" }, { rpId: RP, origin: ORIGIN, source: SOURCE });
    expect(r).toMatchObject({ ok: false, error: { code: "forbidden" } });
    const cli = f.board.passkeyRegisterStart(f.ctx(ADMIN, "cli"), { rpId: RP, origin: ORIGIN, source: SOURCE });
    expect(cli.ok).toBe(false);
    expect(f.sql.one("SELECT COUNT(*) AS n FROM passkey_challenges")).toEqual({ n: 0 });
  });

  it("from a session made by a passkey, with a message to sign in with a pairing code", async () => {
    const f = makeFixture();
    const auth = await registered(f, pairingSession(f));
    const r = (await signIn(f, auth)) as unknown as { value: { id: string } };
    const ctx: CallContext = { handle: ADMIN, via: "web", webSession: r.value.id };
    const start2 = f.board.passkeyRegisterStart(ctx, { rpId: RP, origin: ORIGIN, source: SOURCE });
    expect(start2).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(why(start2)).toMatch(/sign in with a pairing code/);
    // Not from a forged finish either: a challenge made in a pairing session cannot be spent from this one.
    const pairing = pairingSession(f);
    const { challenge } = start(f, pairing);
    const other = await SoftwareAuthenticator.create("ES256");
    const credential = other.register({ challenge, rpId: RP, origin: ORIGIN });
    const finish = await f.board.passkeyRegisterFinish(ctx, { rpId: RP, origin: ORIGIN, credential });
    expect(finish.ok).toBe(false);
    expect(f.sql.one("SELECT COUNT(*) AS n FROM passkeys")).toEqual({ n: 1 });
    const listed = f.board.act(ctx, "passkeys", {}) as unknown as { value: { can_register: boolean; note: string } };
    expect(listed.value.can_register).toBe(false);
    expect(listed.value.note).toMatch(/pairing code/);
  });
});

describe("sign-in is refused", () => {
  const refused: [string, Partial<CeremonyOptions>, string][] = [
    ["a wrong origin", { clientOrigin: "https://evil.example" }, "passkey_client_data_wrong_origin"],
    ["a wrong relying party id", { signedRpId: "evil.example" }, "passkey_wrong_rp_id"],
    ["a wrong ceremony type", { type: "webauthn.create" }, "passkey_client_data_wrong_type"],
    ["no user verification", { userVerified: false }, "passkey_user_not_verified"],
    ["no user presence", { userPresent: false }, "passkey_user_not_present"],
    ["a bad signature", { corruptSignature: true }, "passkey_bad_signature"],
    ["a user handle that is not this person's", { userHandle: "bm90LXRoZS11c2Vy" }, "passkey_user_handle_mismatch"],
  ];
  it.each(refused)("for %s", async (_name, tamper, reason) => {
    for (const alg of ["ES256", "RS256"] as const) {
      const f = makeFixture();
      const auth = await registered(f, pairingSession(f), alg);
      const r = await signIn(f, auth, tamper);
      expect(r, `${alg} ${_name}`).toMatchObject({ ok: false, error: { code: "unauthorized", message: `authentication failed: ${reason.slice("passkey_".length)}` } });
      expect(rowsOf(f, "auth").at(-1)).toMatchObject({ actor: "anonymous", result: "denied" });
      expect(JSON.parse(String(rowsOf(f, "auth").at(-1)?.detail))).toMatchObject({ endpoint: "/api/web/passkey/signin/finish", source: SOURCE });
      expect(String(rowsOf(f, "auth").at(-1)?.detail)).toContain(reason);
      expect(f.sql.one("SELECT COUNT(*) AS n FROM web_sessions WHERE method = 'passkey'")).toEqual({ n: 0 });
      // A refusal removes nothing.
      expect(f.sql.one("SELECT COUNT(*) AS n FROM passkeys")).toEqual({ n: 1 });
    }
  });

  it("for a replayed challenge", async () => {
    const f = makeFixture();
    const auth = await registered(f, pairingSession(f));
    const { challenge } = signinStart(f);
    const credential = await auth.assert({ challenge, rpId: RP, origin: ORIGIN });
    const finish = () => f.board.passkeySigninFinish({ rpId: RP, origin: ORIGIN, credential, label: "x", source: SOURCE });
    expect((await finish()).ok).toBe(true);
    expect(await finish()).toMatchObject({ ok: false, error: { message: "authentication failed: challenge_not_pending" } });
  });

  it("for an expired challenge, and for one that is a registration's", async () => {
    const f = makeFixture();
    const s = pairingSession(f);
    const auth = await registered(f, s);
    const { challenge } = signinStart(f);
    const credential = await auth.assert({ challenge, rpId: RP, origin: ORIGIN });
    f.clock.advance(5 * MIN + 1);
    expect(await f.board.passkeySigninFinish({ rpId: RP, origin: ORIGIN, credential, label: "x", source: SOURCE })).toMatchObject({ ok: false });
    const reg = start(f, s);
    const withRegChallenge = await auth.assert({ challenge: reg.challenge, rpId: RP, origin: ORIGIN });
    expect(await f.board.passkeySigninFinish({ rpId: RP, origin: ORIGIN, credential: withRegChallenge, label: "x", source: SOURCE })).toMatchObject({
      ok: false,
      error: { message: "authentication failed: challenge_not_pending" },
    });
  });

  it("for a credential the board does not know", async () => {
    const f = makeFixture();
    await registered(f, pairingSession(f));
    const stranger = await SoftwareAuthenticator.create("ES256");
    expect(await signIn(f, stranger)).toMatchObject({ ok: false, error: { message: "authentication failed: unknown_credential" } });
  });

  it("for a signature made by another key under a known credential id", async () => {
    const f = makeFixture();
    const auth = await registered(f, pairingSession(f));
    const impostor = await SoftwareAuthenticator.create("ES256", { credentialId: auth.credentialId });
    expect(await signIn(f, impostor)).toMatchObject({ ok: false, error: { message: "authentication failed: bad_signature" } });
  });

  it("when the account is not an active human any more", async () => {
    const f = makeFixture();
    const auth = await registered(f, pairingSession(f));
    f.sql.exec("UPDATE users SET kind = 'agent' WHERE handle = ?", ADMIN);
    expect(await signIn(f, auth)).toMatchObject({ ok: false, error: { message: "authentication failed: account_not_active" } });
    f.sql.exec("UPDATE users SET kind = 'human', status = 'kicked' WHERE handle = ?", ADMIN);
    expect(await signIn(f, auth)).toMatchObject({ ok: false, error: { message: "authentication failed: account_not_active" } });
  });

  it("when the sign count does not increase: refused and audited, the credential kept", async () => {
    const f = makeFixture();
    const auth = await registered(f, pairingSession(f));
    expect((await signIn(f, auth, { signCount: 10 })).ok).toBe(true);
    for (const count of [10, 9, 1]) {
      const r = await signIn(f, auth, { signCount: count });
      expect(r, `count ${count}`).toMatchObject({ ok: false, error: { message: "authentication failed: sign_count_not_increasing" } });
    }
    const row = rowsOf(f, "auth").at(-1);
    expect(String(row?.detail)).toContain("passkey_sign_count_not_increasing");
    expect(JSON.parse(String(row?.detail)).passkey).toMatch(/^pk_/);
    expect(f.sql.one("SELECT sign_count FROM passkeys")).toEqual({ sign_count: 10 });
    expect(f.sql.one("SELECT COUNT(*) AS n FROM web_sessions WHERE method = 'passkey'")).toEqual({ n: 1 });
    // The credential still works with a higher count.
    expect((await signIn(f, auth, { signCount: 11 })).ok).toBe(true);
  });

  it("allows authenticators that never count: a stored or presented count of zero", async () => {
    const f = makeFixture();
    const auth = await registered(f, pairingSession(f));
    expect((await signIn(f, auth, { signCount: 0 })).ok).toBe(true);
    expect((await signIn(f, auth, { signCount: 0 })).ok).toBe(true);
    expect((await signIn(f, auth, { signCount: 5 })).ok).toBe(true);
    expect((await signIn(f, auth, { signCount: 0 })).ok).toBe(true);
    expect(f.sql.one("SELECT sign_count FROM passkeys")).toEqual({ sign_count: 5 });
  });

  it("with a malformed answer", async () => {
    const f = makeFixture();
    await registered(f, pairingSession(f));
    signinStart(f);
    for (const credential of [undefined, null, "x", {}, { id: "AAAA", response: { clientDataJSON: "AAAA", authenticatorData: "AAAA", signature: "AAAA" } }]) {
      const r = await f.board.passkeySigninFinish({ rpId: RP, origin: ORIGIN, credential, label: "x", source: SOURCE });
      expect(r.ok, JSON.stringify(credential)).toBe(false);
    }
  });

  it("the two finishes of one challenge make exactly one session, under concurrency", async () => {
    const f = makeFixture();
    const auth = await registered(f, pairingSession(f));
    const { challenge } = signinStart(f);
    const credential = await auth.assert({ challenge, rpId: RP, origin: ORIGIN });
    const results = await Promise.all(
      Array.from({ length: 5 }, () => f.board.passkeySigninFinish({ rpId: RP, origin: ORIGIN, credential, label: "x", source: SOURCE })),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(f.sql.one("SELECT COUNT(*) AS n FROM web_sessions WHERE method = 'passkey'")).toEqual({ n: 1 });
  });

  it("the two finishes of one registration make exactly one passkey, under concurrency", async () => {
    const f = makeFixture();
    const s = pairingSession(f);
    const auth = await SoftwareAuthenticator.create("ES256");
    const { challenge } = start(f, s);
    const credential = auth.register({ challenge, rpId: RP, origin: ORIGIN });
    const results = await Promise.all(Array.from({ length: 5 }, () => f.board.passkeyRegisterFinish(s.ctx, { rpId: RP, origin: ORIGIN, credential })));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(f.sql.one("SELECT COUNT(*) AS n FROM passkeys")).toEqual({ n: 1 });
  });
});

describe("refusals at the unauthenticated endpoints go through the failed sign-in guards", () => {
  it("never write a row per refused sign-in, and answer 429 past the limit", async () => {
    const f = makeFixture({ authFailureLimit: 3, passkeySigninMaxPerSource: 100, passkeySigninMaxPending: 200 });
    const auth = await registered(f, pairingSession(f));
    const before = f.auditRows().length;
    const answers: string[] = [];
    for (let i = 0; i < 12; i++) {
      const r = await signIn(f, auth, { corruptSignature: true }, "ip:9.9.9.9");
      answers.push(r.ok ? "ok" : r.error.code);
    }
    expect(answers.slice(0, 3)).toEqual(["unauthorized", "unauthorized", "unauthorized"]);
    expect(answers.at(-1)).toBe("rate_limited");
    const rows = f.auditRows().slice(before);
    // Twelve starts, then three failure rows and one summary row, not twelve.
    expect(rows.filter((r) => r.action === "auth")).toHaveLength(3);
    expect(rows.filter((r) => r.action === "sign_in_limited")).toHaveLength(1);
  });

  it("limit starts per source and board-wide, as a condition of the write", () => {
    const f = makeFixture({ passkeySigninMaxPerSource: 2, passkeySigninMaxPending: 3 });
    expect(f.board.passkeySigninStart({ rpId: RP, origin: ORIGIN, source: "a" }).ok).toBe(true);
    expect(f.board.passkeySigninStart({ rpId: RP, origin: ORIGIN, source: "a" }).ok).toBe(true);
    expect(f.board.passkeySigninStart({ rpId: RP, origin: ORIGIN, source: "a" })).toMatchObject({ ok: false, error: { code: "rate_limited" } });
    expect(f.board.passkeySigninStart({ rpId: RP, origin: ORIGIN, source: "b" }).ok).toBe(true);
    expect(f.board.passkeySigninStart({ rpId: RP, origin: ORIGIN, source: "c" })).toMatchObject({ ok: false, error: { code: "rate_limited" } });
    expect(f.sql.one("SELECT COUNT(*) AS n FROM passkey_challenges")).toEqual({ n: 3 });
    // The challenges expire, so the room comes back.
    f.clock.advance(5 * MIN + 1);
    expect(f.board.passkeySigninStart({ rpId: RP, origin: ORIGIN, source: "a" }).ok).toBe(true);
  });

  it("a start writes an audit row as anonymous, and none holds the challenge", () => {
    const f = makeFixture();
    const { challenge } = signinStart(f);
    expect(rowsOf(f, "passkey_signin_start")[0]).toMatchObject({ actor: "anonymous", actor_kind: "anonymous", via: "web", result: "ok" });
    expect(JSON.stringify(f.auditRows())).not.toContain(challenge);
  });
});

describe("limits and removal", () => {
  it("allows at most passkeysPerUser passkeys, refused past it", async () => {
    const f = makeFixture({ passkeysPerUser: 2 });
    const s = pairingSession(f);
    await registered(f, s);
    await registered(f, s);
    expect(f.board.passkeyRegisterStart(s.ctx, { rpId: RP, origin: ORIGIN, source: SOURCE })).toMatchObject({ ok: false, error: { code: "forbidden" } });
  });

  it("a challenge made before the cap was reached still cannot add a passkey past it: the INSERT holds the cap", async () => {
    const f = makeFixture({ passkeysPerUser: 2 });
    const s = pairingSession(f);
    await registered(f, s);
    const late = await SoftwareAuthenticator.create("ES256");
    const { challenge } = start(f, s);
    f.sql.exec(
      `INSERT INTO passkeys (id, handle, credential_id, public_key, alg, sign_count, backup_eligible, backup_state, label, created_at)
       VALUES ('pk_race', ?, 'race', '{}', 'ES256', 0, 0, 0, 'Race', 1)`,
      ADMIN,
    );
    const credential = late.register({ challenge, rpId: RP, origin: ORIGIN });
    const r = await f.board.passkeyRegisterFinish(s.ctx, { rpId: RP, origin: ORIGIN, credential });
    expect(r).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(why(r)).toMatch(/already have 2 passkeys/);
    expect(f.sql.one("SELECT COUNT(*) AS n FROM passkeys")).toEqual({ n: 2 });
  });

  it("a new registration start replaces the person's older pending challenge", () => {
    const f = makeFixture();
    const s = pairingSession(f);
    start(f, s);
    start(f, s);
    start(f, s);
    start(f, s);
    expect(f.sql.one("SELECT COUNT(*) AS n FROM passkey_challenges WHERE purpose = 'register' AND consumed_at IS NULL")).toEqual({ n: 1 });
  });

  it("removes a passkey from the web view unless it is the last one; the last goes only from the CLI", async () => {
    const f = makeFixture();
    const s = pairingSession(f);
    await registered(f, s);
    await registered(f, s);
    const ids = f.sql.all<{ id: string }>("SELECT id FROM passkeys ORDER BY created_at, rowid").map((r) => r.id);
    expect(f.board.act(s.ctx, "passkey_remove", { id: ids[0] })).toMatchObject({ ok: true, value: { removed: ids[0] } });
    const last = f.board.act(s.ctx, "passkey_remove", { id: ids[1] });
    expect(last).toMatchObject({ ok: false, error: { code: "forbidden", message: "removing your last passkey is only available from the bbs CLI" } });
    expect(f.sql.one("SELECT COUNT(*) AS n FROM passkeys")).toEqual({ n: 1 });
    expect(f.board.act(f.ctx(ADMIN, "cli"), "passkey_remove", { id: ids[1] })).toMatchObject({ ok: true });
    expect(f.sql.one("SELECT COUNT(*) AS n FROM passkeys")).toEqual({ n: 0 });
    expect(f.board.act(f.ctx(ADMIN, "cli"), "passkey_remove", { id: "pk_nope" })).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(rowsOf(f, "passkey_remove").map((r) => [r.result, r.via])).toEqual([["ok", "web"], ["denied", "web"], ["ok", "cli"], ["error", "cli"]]);
  });

  it("two removals from the web of the last two passkeys leave one", async () => {
    const f = makeFixture();
    const s = pairingSession(f);
    await registered(f, s);
    await registered(f, s);
    const ids = f.sql.all<{ id: string }>("SELECT id FROM passkeys").map((r) => r.id);
    const results = ids.map((id) => f.board.act(s.ctx, "passkey_remove", { id }));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(f.sql.one("SELECT COUNT(*) AS n FROM passkeys")).toEqual({ n: 1 });
  });

  it("a removed passkey no longer signs in, and one person cannot remove or list another's", async () => {
    const f = makeFixture();
    f.addUser("pat", "human");
    const s = pairingSession(f);
    const auth = await registered(f, s);
    const id = (f.sql.one("SELECT id FROM passkeys") as { id: string }).id;
    expect(f.board.act(f.ctx("pat", "cli"), "passkey_remove", { id })).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect((f.board.act(f.ctx("pat", "cli"), "passkeys", {}) as unknown as { value: { passkeys: unknown[] } }).value.passkeys).toEqual([]);
    expect(f.board.act(f.ctx(ADMIN, "cli"), "passkey_remove", { id }).ok).toBe(true);
    expect(await signIn(f, auth)).toMatchObject({ ok: false, error: { message: "authentication failed: unknown_credential" } });
  });

  it("the tools are for a person via the CLI or the web view, never an agent or /mcp", () => {
    const f = makeFixture();
    f.addUser("alice");
    for (const name of ["bbs_passkeys", "bbs_passkey_remove"]) {
      expect(callTool(f.board, { handle: "alice", via: "mcp" }, name, { id: "pk_x" }, "mcp").isError).toBe(true);
      expect(callTool(f.board, { handle: "alice", via: "api" }, name, { id: "pk_x" }, "api").isError).toBe(true);
    }
    expect(callTool(f.board, f.ctx(ADMIN, "cli"), "bbs_passkeys", {}, "mcp").structuredContent).toMatchObject({ error: { code: "forbidden" } });
    const s = pairingSession(f);
    expect(callTool(f.board, s.ctx, "bbs_passkeys", {}, "api").isError).toBe(false);
  });

  it("revoking all web sessions stays CLI-only", () => {
    const f = makeFixture();
    const s = pairingSession(f);
    expect(f.board.act(s.ctx, "web_session_revoke", { all: true })).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(f.board.act(f.ctx(ADMIN, "cli"), "web_session_revoke", { all: true }).ok).toBe(true);
  });
});

describe("what is stored and written down", () => {
  it("keeps only hashes of challenges, and no challenge, cookie, key or signature in an audit row", async () => {
    const f = makeFixture();
    const s = pairingSession(f);
    const auth = await SoftwareAuthenticator.create("ES256");
    const options = start(f, s);
    const credential = auth.register({ challenge: options.challenge, rpId: RP, origin: ORIGIN });
    expect((await f.board.passkeyRegisterFinish(s.ctx, { rpId: RP, origin: ORIGIN, credential })).ok).toBe(true);
    const { challenge } = signinStart(f);
    const answer = await auth.assert({ challenge, rpId: RP, origin: ORIGIN });
    const r = (await f.board.passkeySigninFinish({ rpId: RP, origin: ORIGIN, credential: answer, label: "x", source: SOURCE })) as unknown as { value: { session: string } };
    // A refused one too, with a bad signature.
    const { challenge: c3 } = signinStart(f);
    const bad = await auth.assert({ challenge: c3, rpId: RP, origin: ORIGIN, corruptSignature: true });
    await f.board.passkeySigninFinish({ rpId: RP, origin: ORIGIN, credential: bad, label: "x", source: SOURCE });

    const hashes = f.sql.all<{ hash: string }>("SELECT hash FROM passkey_challenges").map((c) => c.hash);
    expect(hashes).toHaveLength(3);
    for (const c of [options.challenge, challenge, c3]) expect(hashes).not.toContain(c);
    const everything = JSON.stringify(f.auditRows());
    const key = (f.sql.one("SELECT public_key FROM passkeys") as { public_key: string }).public_key;
    const jwk = JSON.parse(key) as { x: string };
    for (const secret of [options.challenge, challenge, c3, r.value.session, answer.response.signature, bad.response.signature, jwk.x, credential.response.attestationObject, options.user.id]) {
      expect(everything).not.toContain(secret);
    }
    // The public key is stored without private fields.
    expect(Object.keys(jwk).sort()).toEqual(["crv", "kty", "x", "y"]);
    expect(f.sql.one("SELECT token_hash FROM web_sessions WHERE method = 'passkey'")).not.toContain(r.value.session);
    const reg = rowsOf(f, "passkey_register")[0];
    expect(reg).toMatchObject({ actor: ADMIN, via: "web", target_type: "passkey" });
    expect(JSON.parse(String(reg?.detail))).toMatchObject({ synced: false });
  });

  it("the prune timer deletes expired challenges and re-arms while any row is left", () => {
    const f = makeFixture();
    signinStart(f);
    expect(f.sql.one("SELECT COUNT(*) AS n FROM timers WHERE kind = 'web_prune'")).toEqual({ n: 1 });
    f.clock.advance(5 * MIN + 1);
    f.clock.advance(24 * 60 * MIN);
    f.board.runDueTimers();
    expect(f.sql.one("SELECT COUNT(*) AS n FROM passkey_challenges")).toEqual({ n: 0 });
    expect(JSON.parse(String(rowsOf(f, "web_prune")[0]?.detail))).toMatchObject({ challenges: 1, rearmed: false });
  });
});

describe("removing or revoking passkeys ends what they made", () => {
  const sessionIds = (f: Fixture) => f.sql.all<{ id: string }>("SELECT id FROM web_sessions ORDER BY id").map((r) => r.id);

  it("a removed passkey ends exactly the web sessions it made, and leaves pairing sessions and other passkeys' sessions", async () => {
    const f = makeFixture();
    const pairing = pairingSession(f);
    const a = await registered(f, pairing);
    const b = await registered(f, pairing);
    const idA = (f.sql.one("SELECT id FROM passkeys WHERE credential_id = ?", b64u(a.credentialId)) as { id: string }).id;
    const idB = (f.sql.one("SELECT id FROM passkeys WHERE credential_id = ?", b64u(b.credentialId)) as { id: string }).id;
    const val = (r: unknown) => (r as { value: { id: string; session: string } }).value;
    const a1 = val(await signIn(f, a));
    const a2 = val(await signIn(f, a));
    const b1 = val(await signIn(f, b));
    expect(f.sql.all("SELECT id, passkey FROM web_sessions WHERE passkey IS NOT NULL ORDER BY id")).toHaveLength(3);
    expect(f.sql.one("SELECT passkey FROM web_sessions WHERE id = ?", pairing.id)).toEqual({ passkey: null });

    const removed = f.board.act(f.ctx(ADMIN, "cli"), "passkey_remove", { id: idA });
    expect(removed).toMatchObject({ ok: true, value: { removed: idA, ended_current: false } });
    expect((removed as unknown as { value: { ended_sessions: string[] } }).value.ended_sessions.sort()).toEqual([a1.id, a2.id].sort());
    expect(sessionIds(f).sort()).toEqual([pairing.id, b1.id].sort());
    expect(JSON.parse(String(rowsOf(f, "passkey_remove").at(-1)?.detail)).ended_sessions.sort()).toEqual([a1.id, a2.id].sort());
    expect(f.board.authenticateWebSession(a1.session, { source: SOURCE }).ok).toBe(false);
    expect(f.board.authenticateWebSession(b1.session, { source: SOURCE }).ok).toBe(true);
    expect(idB).toMatch(/^pk_/);
  });

  it("removing the passkey this very session was made by ends the caller's session too", async () => {
    const f = makeFixture();
    const pairing = pairingSession(f);
    const a = await registered(f, pairing);
    await registered(f, pairing);
    const mine = (await signIn(f, a)) as unknown as { value: { id: string; session: string } };
    const id = (f.sql.one("SELECT id FROM passkeys WHERE credential_id = ?", b64u(a.credentialId)) as { id: string }).id;
    const ctx: CallContext = { handle: ADMIN, via: "web", webSession: mine.value.id };
    expect(f.board.act(ctx, "passkey_remove", { id })).toMatchObject({ ok: true, value: { ended_current: true } });
    expect(f.board.authenticateWebSession(mine.value.session, { source: SOURCE }).ok).toBe(false);
  });

  it("retiring an admin removes their passkeys and challenges: their passkey sign-in is an unknown credential", async () => {
    const f = makeFixture();
    const auth = await registered(f, pairingSession(f));
    start(f, pairingSession(f));
    expect((await signIn(f, auth)).ok).toBe(true);
    expect(f.board.bootstrapHuman("owner2", sha256("second credential")).ok).toBe(true);
    expect(f.sql.one("SELECT COUNT(*) AS n FROM passkeys WHERE handle = ?", ADMIN)).toEqual({ n: 0 });
    expect(f.sql.one("SELECT COUNT(*) AS n FROM passkey_challenges WHERE handle = ?", ADMIN)).toEqual({ n: 0 });
    expect(f.sql.one("SELECT COUNT(*) AS n FROM web_sessions WHERE handle = ?", ADMIN)).toEqual({ n: 0 });
    expect(await signIn(f, auth)).toMatchObject({ ok: false, error: { message: "authentication failed: unknown_credential" } });
    const row = rowsOf(f, "bootstrap_human").at(-1);
    expect(JSON.parse(String(row?.detail)).removed_passkeys[ADMIN]).toHaveLength(1);
  });

  it("rotating a person's own credential ends their web sessions and removes their passkeys", async () => {
    const f = makeFixture();
    const pairing = pairingSession(f);
    const auth = await registered(f, pairing);
    const signedIn = (await signIn(f, auth)) as unknown as { ok: boolean; value: { session: string } };
    expect(signedIn.ok).toBe(true);
    expect(f.board.bootstrapHuman(ADMIN, sha256("a new credential after a leak")).ok).toBe(true);
    expect(f.sql.one("SELECT COUNT(*) AS n FROM passkeys WHERE handle = ?", ADMIN)).toEqual({ n: 0 });
    expect(f.sql.one("SELECT COUNT(*) AS n FROM web_sessions WHERE handle = ?", ADMIN)).toEqual({ n: 0 });
    expect(f.board.authenticateWebSession(signedIn.value.session, { source: SOURCE }).ok).toBe(false);
    expect(await signIn(f, auth)).toMatchObject({ ok: false, error: { message: "authentication failed: unknown_credential" } });
    const detail = JSON.parse(String(rowsOf(f, "bootstrap_human").at(-1)?.detail));
    expect(detail.own_removed_passkeys).toHaveLength(1);
    expect(detail.ended_web_sessions).toBeGreaterThanOrEqual(2);
  });

  it("a pairing approved before a credential rotation cannot be claimed after it", () => {
    const f = makeFixture();
    const p = f.board.webPairStart({ source: SOURCE, label: "Chrome on macOS" });
    if (!p.ok) throw new Error("pair start refused");
    expect(f.board.act(f.ctx(ADMIN, "cli"), "web_pairing_approve", { code: p.value.code }).ok).toBe(true);
    expect(f.board.bootstrapHuman(ADMIN, sha256("a new credential after a leak")).ok).toBe(true);
    const claim = f.board.webPairClaim({ pollSecret: p.value.poll_secret, source: SOURCE });
    expect(claim.ok && (claim.value as { status?: string }).status === "approved").toBe(false);
    expect(f.sql.one("SELECT COUNT(*) AS n FROM web_sessions WHERE handle = ?", ADMIN)).toEqual({ n: 0 });
  });

  it("revokePasskeys, the kick path's call, removes a person's passkeys and challenges and returns their ids", async () => {
    const f = makeFixture();
    await registered(f, pairingSession(f));
    start(f, pairingSession(f));
    const expected = f.sql.all<{ id: string }>("SELECT id FROM passkeys").map((r) => r.id);
    const tx = { sql: f.sql, actor: { handle: ADMIN } } as never;
    expect(f.sql.transaction(() => revokePasskeys(tx, ADMIN))).toEqual(expected);
    expect(f.sql.one("SELECT COUNT(*) AS n FROM passkeys")).toEqual({ n: 0 });
    expect(f.sql.one("SELECT COUNT(*) AS n FROM passkey_challenges")).toEqual({ n: 0 });
  });
});

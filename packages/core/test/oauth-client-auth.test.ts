// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0

/**
 * Client authentication with `private_key_jwt` at `/oauth/token` and
 * `/oauth/revoke` (issue #55, design §9 "Client authentication"): the client
 * document's rules, the key set, every assertion check, the single-use `jti`,
 * the guarantee that a bad assertion never ends a grant, key rotation, and the
 * consent and listing fields. Keys are generated here with Web Crypto.
 */

import type { webcrypto } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { s256 } from "../src/actions/oauth.ts";
import { ASSERTION_TYPE, parseKeySet } from "../src/actions/client-auth.ts";
import { Board, type OAuthClientAuthResult, type OAuthTokenResult } from "../src/act.ts";
import { NodeSqliteSql } from "../src/node-sqlite.ts";
import { DEFAULT_CONFIG, validateConfig, type ActResult, type BoardConfig, type CallContext } from "../src/types.ts";
import { migrate } from "../src/schema.ts";
import { ADMIN, makeBoard, sha256, type Fixture } from "./helpers.ts";

const MIN = 60_000;

const CLIENT = "https://client.example/oauth/client.json";
const REDIRECT = "https://client.example/callback";
const OTHER = "https://other.example/oauth/client.json";
const OTHER_REDIRECT = "https://other.example/callback";
const RESOURCE = "https://api.example/mcp";
const ISSUER = "https://api.example";
const TOKEN_URL = `${ISSUER}/oauth/token`;
const REVOKE_URL = `${ISSUER}/oauth/revoke`;
const VERIFIER = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ-._~0123";
const CHALLENGE = s256(sha256, VERIFIER);
const SOURCE = "ip:9.9.9.9";

const webCtx = (): CallContext => ({ handle: ADMIN, via: "web", webSession: "ws_test" });

// ---------------------------------------------------------------------------
// Keys and assertions

interface Signer {
  alg: string;
  kid: string;
  priv: webcrypto.CryptoKey;
  jwk: Record<string, unknown>;
}

const enc = new TextEncoder();
const b64u = (bytes: ArrayBuffer | Uint8Array | string): string => {
  const u = typeof bytes === "string" ? enc.encode(bytes) : new Uint8Array(bytes);
  let s = "";
  for (const b of u) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

async function rsaSigner(kid: string, bits: number): Promise<Signer> {
  const pair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: bits, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as webcrypto.CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as Record<string, unknown>;
  return { alg: "RS256", kid, priv: pair.privateKey, jwk: { ...jwk, kid, use: "sig", alg: "RS256" } };
}

async function ecSigner(kid: string): Promise<Signer> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as webcrypto.CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as Record<string, unknown>;
  return { alg: "ES256", kid, priv: pair.privateKey, jwk: { ...jwk, kid, use: "sig", alg: "ES256" } };
}

async function signWith(signer: Signer, data: Uint8Array): Promise<Uint8Array> {
  const params = signer.alg === "ES256" ? { name: "ECDSA", hash: "SHA-256" } : { name: "RSASSA-PKCS1-v1_5" };
  return new Uint8Array(await crypto.subtle.sign(params, signer.priv, data as Uint8Array<ArrayBuffer>));
}

interface Keys {
  rsa: Signer;
  ec: Signer;
  /** A second key under the EC key's kid: a signature that is well formed but not by the stored key. */
  impostor: Signer;
  small: Signer;
  jwks: { keys: Record<string, unknown>[] };
}
let K: Keys;

beforeAll(async () => {
  const rsa = await rsaSigner("rsa1", 2048);
  const ec = await ecSigner("ec1");
  const impostor = await ecSigner("ec1");
  const small = await rsaSigner("small1", 1024);
  K = { rsa, ec, impostor, small, jwks: { keys: [rsa.jwk, ec.jwk] } };
}, 60_000);

let jtiCounter = 0;

interface AssertionOptions {
  signer?: Signer;
  header?: Record<string, unknown>;
  payload?: Record<string, unknown>;
  /** Replace the signature with these bytes (base64url text). */
  signature?: string;
}

/** A compact JWS for `clientId`, valid at the fixture's clock unless `o` says otherwise. */
async function assertionFor(f: Fixture, clientId: string, o: AssertionOptions = {}): Promise<string> {
  const signer = o.signer ?? K.rsa;
  const now = Math.floor(f.clock.t / 1000);
  const header = { alg: signer.alg, typ: "JWT", kid: signer.kid, ...o.header };
  const payload = { iss: clientId, sub: clientId, aud: ISSUER, exp: now + 300, iat: now, jti: `jti-${++jtiCounter}`, ...o.payload };
  const signingInput = `${b64u(JSON.stringify(header))}.${b64u(JSON.stringify(payload))}`;
  const sig = o.signature ?? b64u(await signWith(signer, enc.encode(signingInput)));
  return `${signingInput}.${sig}`;
}

/** An assertion signed with HMAC (HS256), which the board must never accept. */
async function hmacAssertion(f: Fixture, clientId: string): Promise<string> {
  const now = Math.floor(f.clock.t / 1000);
  const signingInput = `${b64u(JSON.stringify({ alg: "HS256", typ: "JWT" }))}.${b64u(
    JSON.stringify({ iss: clientId, sub: clientId, aud: ISSUER, exp: now + 300, jti: `jti-${++jtiCounter}` }),
  )}`;
  const key = await crypto.subtle.importKey("raw", enc.encode("shared secret of some length"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return `${signingInput}.${b64u(await crypto.subtle.sign("HMAC", key, enc.encode(signingInput)))}`;
}

// ---------------------------------------------------------------------------
// Board helpers

function fx(config: Partial<BoardConfig> = {}): Fixture {
  return makeBoard({ config });
}

function pkDoc(clientId = CLIENT, redirect = REDIRECT, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    client_id: clientId,
    client_name: "Signing Client",
    redirect_uris: [redirect],
    token_endpoint_auth_method: "private_key_jwt",
    jwks: K.jwks,
    ...over,
  };
}

function authorizeParams(clientId: string, redirect: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirect,
    code_challenge: CHALLENGE,
    code_challenge_method: "S256",
    resource: RESOURCE,
    state: "st-1",
    resource_expected: RESOURCE,
    ...over,
  };
}

function request(f: Fixture, clientId: string, redirect: string, over: Record<string, unknown> = {}): ActResult<Record<string, unknown>> {
  return f.board.oauthRequest(webCtx(), authorizeParams(clientId, redirect, { client_doc: pkDoc(clientId, redirect), ...over })) as ActResult<
    Record<string, unknown>
  >;
}

function requestIdOf(r: ActResult<Record<string, unknown>>): string {
  if (!r.ok) throw new Error(`request refused: ${r.error.message}`);
  return (r.value as { request_id: string }).request_id;
}

function refusedMessage(r: ActResult): string {
  if (r.ok) throw new Error("expected a refusal");
  return r.error.message;
}

interface Approved {
  code: string;
  grant: string;
}

/** Request (with `over`) and approve; returns the code and grant. */
function approve(f: Fixture, clientId = CLIENT, redirect = REDIRECT, over: Record<string, unknown> = {}): Approved {
  const r = request(f, clientId, redirect, over);
  if (!r.ok) throw new Error(`request refused: ${r.error.message}`);
  const d = f.board.oauthDecide(webCtx(), { request_id: (r.value as { request_id: string }).request_id, approve: true, handle: "claude-ai" });
  if (!d.ok) throw new Error(`decide refused: ${d.error.message}`);
  return d.value as unknown as Approved;
}

type Params = Record<string, string | undefined>;

function exchangeParams(code: string, clientId = CLIENT, redirect = REDIRECT, over: Params = {}): Params {
  return { grant_type: "authorization_code", code, code_verifier: VERIFIER, client_id: clientId, redirect_uri: redirect, resource: RESOURCE, ...over };
}

function refreshParams(token: string, clientId = CLIENT, over: Params = {}): Params {
  return { grant_type: "refresh_token", refresh_token: token, client_id: clientId, resource: RESOURCE, ...over };
}

/** The Worker's two calls, in order: authenticate the client (the one `await`), then the synchronous token write. */
async function token(f: Fixture, params: Params, assertion?: string, o: { type?: string | undefined; audiences?: string[] } = {}): Promise<OAuthTokenResult> {
  const a: OAuthClientAuthResult = await f.board.authenticateOAuthClient({
    clientId: params.client_id,
    assertionType: assertion === undefined ? undefined : "type" in o ? o.type : ASSERTION_TYPE,
    assertion,
    audiences: o.audiences ?? [ISSUER, TOKEN_URL],
    endpoint: "/oauth/token",
    source: SOURCE,
  });
  if (!a.ok) return a;
  return f.board.oauthToken({ params, resource: RESOURCE, clientAuth: a.auth, source: SOURCE });
}

async function revoke(f: Fixture, tok: string, clientId: string | undefined, assertion?: string) {
  const a = await f.board.authenticateOAuthClient({
    clientId,
    assertionType: assertion === undefined ? undefined : ASSERTION_TYPE,
    assertion,
    audiences: [ISSUER, TOKEN_URL, REVOKE_URL],
    endpoint: "/oauth/revoke",
    source: SOURCE,
  });
  if (!a.ok) return a;
  return f.board.oauthRevoke({ token: tok, clientId, clientAuth: a.auth, source: SOURCE });
}

function good(r: { ok: boolean }): { access_token: string; refresh_token: string } {
  const t = r as OAuthTokenResult;
  if (!t.ok) throw new Error(`token refused: ${t.error}: ${t.description}`);
  return t.value;
}

/** Sign in as the signing client with an RS256 assertion; returns the tokens and grant. */
async function signIn(f: Fixture, clientId = CLIENT, redirect = REDIRECT, over: Record<string, unknown> = {}) {
  const a = approve(f, clientId, redirect, over);
  const t = good(await token(f, exchangeParams(a.code, clientId, redirect), await assertionFor(f, clientId)));
  return { ...a, access: t.access_token, refresh: t.refresh_token };
}

const grantCount = (f: Fixture): number => (f.sql.one("SELECT COUNT(*) AS n FROM oauth_grants") as { n: number }).n;

// ---------------------------------------------------------------------------

describe("the client document (design §9 step 3)", () => {
  it("stores a signing client with its method, keys and declared algorithm", () => {
    const f = fx();
    const r = request(f, CLIENT, REDIRECT, { client_doc: pkDoc(CLIENT, REDIRECT, { token_endpoint_auth_signing_alg: "RS256" }) });
    expect(r.ok).toBe(true);
    const row = f.sql.one("SELECT auth_method, auth_alg, jwks_uri, jwks FROM oauth_clients WHERE client_id = ?", CLIENT) as {
      auth_method: string;
      auth_alg: string;
      jwks_uri: string | null;
      jwks: string;
    };
    expect(row).toMatchObject({ auth_method: "private_key_jwt", auth_alg: "RS256", jwks_uri: null });
    const keys = JSON.parse(row.jwks) as Record<string, unknown>[];
    expect(keys.map((k) => k.kid)).toEqual(["rsa1", "ec1"]);
    // Only public fields are kept.
    expect(Object.keys(keys[0] as object).sort()).toEqual(["e", "kid", "kty", "n"]);
  });

  it("accepts method none or no method as a public client, ignoring the rest", () => {
    for (const over of [{ token_endpoint_auth_method: "none" }, { token_endpoint_auth_method: undefined }]) {
      const f = fx();
      const r = request(f, CLIENT, REDIRECT, { client_doc: pkDoc(CLIENT, REDIRECT, { ...over, token_endpoint_auth_methods_supported: ["none", "private_key_jwt"] }) });
      expect(r.ok).toBe(true);
      expect(f.sql.one("SELECT auth_method, jwks FROM oauth_clients")).toEqual({ auth_method: "none", jwks: null });
    }
  });

  it("takes a key set fetched from jwks_uri, on the client's own host", () => {
    const f = fx();
    const doc = pkDoc(CLIENT, REDIRECT, { jwks: undefined, jwks_uri: "https://client.example/oauth/jwks.json" });
    const r = request(f, CLIENT, REDIRECT, { client_doc: doc, client_jwks: K.jwks });
    expect(r.ok).toBe(true);
    expect(f.sql.one("SELECT auth_method, jwks_uri FROM oauth_clients")).toEqual({
      auth_method: "private_key_jwt",
      jwks_uri: "https://client.example/oauth/jwks.json",
    });
  });

  const refused: [string, () => { docOver: Record<string, unknown>; over?: Record<string, unknown> }, RegExp][] = [
    ["has neither jwks_uri nor jwks", () => ({ docOver: { jwks: undefined } }), /neither jwks_uri nor jwks/],
    ["has both jwks and jwks_uri", () => ({ docOver: { jwks_uri: "https://client.example/jwks.json" } }), /both jwks_uri and jwks/],
    ["declares an unsupported algorithm", () => ({ docOver: { token_endpoint_auth_signing_alg: "PS256" } }), /does not support; it supports RS256 and ES256/],
    ["declares none as the algorithm", () => ({ docOver: { token_endpoint_auth_signing_alg: "none" } }), /does not support/],
    [
      "names a jwks_uri on another host",
      () => ({ docOver: { jwks: undefined, jwks_uri: "https://evil.example/jwks.json" }, over: { client_jwks: K.jwks } }),
      /same host/,
    ],
    [
      "names a jwks_uri over http",
      () => ({ docOver: { jwks: undefined, jwks_uri: "http://client.example/jwks.json" }, over: { client_jwks: K.jwks } }),
      /https/,
    ],
    ["names a jwks_uri that was not fetched", () => ({ docOver: { jwks: undefined, jwks_uri: "https://client.example/jwks.json" } }), /not fetched/],
    ["has a jwks that is not a key set", () => ({ docOver: { jwks: { nope: 1 } } }), /no keys array/],
    ["has an RSA key under 2048 bits", () => ({ docOver: { jwks: { keys: [K.small.jwk] } } }), /no usable signing key.*shorter than 2048/],
    ["has only a key whose use is enc", () => ({ docOver: { jwks: { keys: [{ ...K.rsa.jwk, use: "enc" }] } } }), /no usable signing key.*not for signing/],
    [
      "has only keys of other types",
      () => ({ docOver: { jwks: { keys: [{ kty: "oct", k: "AAAA" }, { kty: "OKP", crv: "Ed25519", x: "AAAA" }] } } }),
      /no usable signing key/,
    ],
    ["has an EC key on another curve", () => ({ docOver: { jwks: { keys: [{ kty: "EC", crv: "P-384", x: "AA", y: "AA" }] } } }), /not on P-256/],
  ];

  it.each(refused)("refuses a private_key_jwt document that %s, caching nothing", (_why, make, message) => {
    const f = fx();
    const { docOver, over } = make();
    const r = request(f, CLIENT, REDIRECT, { client_doc: pkDoc(CLIENT, REDIRECT, docOver), ...over });
    expect(refusedMessage(r)).toMatch(message);
    expect(f.sql.one("SELECT COUNT(*) AS n FROM oauth_clients")).toEqual({ n: 0 });
    expect(f.sql.one("SELECT COUNT(*) AS n FROM oauth_requests")).toEqual({ n: 0 });
  });

  it("skips unusable keys among usable ones, and keeps at most oauthJwksMaxKeys", () => {
    const set = { keys: [K.small.jwk, { ...K.rsa.jwk, use: "enc" }, K.ec.jwk, K.rsa.jwk, { kty: "oct" }] };
    const r = parseKeySet(set, DEFAULT_CONFIG);
    expect(r.ok && r.keys.map((k) => k.kid)).toEqual(["ec1", "rsa1"]);
    const many = { keys: Array.from({ length: 30 }, (_, i) => ({ ...K.ec.jwk, kid: `k${i}` })) };
    const capped = parseKeySet(many, DEFAULT_CONFIG);
    expect(capped.ok && capped.keys).toHaveLength(DEFAULT_CONFIG.oauthJwksMaxKeys);
    const tooBig = parseKeySet({ keys: [K.ec.jwk], pad: "x".repeat(70_000) }, DEFAULT_CONFIG);
    expect(tooBig.ok).toBe(false);
  });

  it("shows how the client authenticates on the consent summary and in the grant listing", () => {
    const f = fx();
    const r = request(f, CLIENT, REDIRECT);
    expect((r as { value: Record<string, unknown> }).value.client_auth).toBe("private_key_jwt");
    const none = fx();
    const n = none.board.oauthRequest(webCtx(), authorizeParams(CLIENT, REDIRECT, { client_doc: { client_id: CLIENT, redirect_uris: [REDIRECT] } })) as ActResult<Record<string, unknown>>;
    expect((n as { value: Record<string, unknown> }).value.client_auth).toBe("none");
    approve(f);
    const grants = f.board.act<{ grants: { client_auth: string }[] }>(f.ctx(ADMIN, "cli"), "oauth_grants", {});
    expect(grants.ok && grants.value.grants.map((g) => g.client_auth)).toEqual(["private_key_jwt"]);
  });
});

describe("a signing client at /oauth/token and /oauth/revoke", () => {
  it("exchanges a code, refreshes and revokes with RS256 assertions", async () => {
    const f = fx();
    const a = approve(f);
    const t1 = good(await token(f, exchangeParams(a.code), await assertionFor(f, CLIENT, { signer: K.rsa })));
    const t2 = good(await token(f, refreshParams(t1.refresh_token), await assertionFor(f, CLIENT, { signer: K.rsa })));
    expect(t2.access_token).not.toBe(t1.access_token);
    expect(await revoke(f, t2.refresh_token, CLIENT, await assertionFor(f, CLIENT, { signer: K.rsa }))).toEqual({ ok: true });
    expect(grantCount(f)).toBe(0);
  });

  it("exchanges a code, refreshes and revokes with ES256 assertions", async () => {
    const f = fx();
    const a = approve(f);
    const t1 = good(await token(f, exchangeParams(a.code), await assertionFor(f, CLIENT, { signer: K.ec })));
    const t2 = good(await token(f, refreshParams(t1.refresh_token), await assertionFor(f, CLIENT, { signer: K.ec })));
    expect(await revoke(f, t2.access_token, CLIENT, await assertionFor(f, CLIENT, { signer: K.ec }))).toEqual({ ok: true });
    expect(grantCount(f)).toBe(0);
  });

  it("names the client by the assertion's iss when the request has no client_id", async () => {
    const f = fx();
    const a = approve(f);
    const t = good(await token(f, exchangeParams(a.code, CLIENT, REDIRECT, { client_id: undefined }), await assertionFor(f, CLIENT)));
    expect(await revoke(f, t.refresh_token, undefined, await assertionFor(f, CLIENT))).toEqual({ ok: true });
  });

  it("accepts the issuer or the token endpoint, as a string or in an array, and the revoke endpoint only for revoke", async () => {
    const f = fx();
    const a = approve(f);
    const t = good(await token(f, exchangeParams(a.code), await assertionFor(f, CLIENT, { payload: { aud: TOKEN_URL } })));
    const t2 = good(await token(f, refreshParams(t.refresh_token), await assertionFor(f, CLIENT, { payload: { aud: ["https://elsewhere.example", ISSUER] } })));
    const viaToken = await token(f, refreshParams(t2.refresh_token), await assertionFor(f, CLIENT, { payload: { aud: REVOKE_URL } }));
    expect(viaToken).toMatchObject({ ok: false, error: "invalid_client" });
    expect(await revoke(f, t2.refresh_token, CLIENT, await assertionFor(f, CLIENT, { payload: { aud: REVOKE_URL } }))).toEqual({ ok: true });
  });

  it("allows a minute of clock skew on exp, nbf and iat, and no more", async () => {
    const f = fx();
    const now = Math.floor(f.clock.t / 1000);
    const a = approve(f);
    const t = good(
      await token(f, exchangeParams(a.code), await assertionFor(f, CLIENT, { payload: { exp: now - 30, nbf: now + 30, iat: now + 30 } })),
    );
    const late = await token(f, refreshParams(t.refresh_token), await assertionFor(f, CLIENT, { payload: { exp: now - 61 } }));
    expect(late).toMatchObject({ ok: false, error: "invalid_client" });
    const early = await token(f, refreshParams(t.refresh_token), await assertionFor(f, CLIENT, { payload: { nbf: now + 61 } }));
    expect(early).toMatchObject({ ok: false, error: "invalid_client" });
  });

  it("uses the only key when the assertion has no kid, and refuses a missing kid when the set has several", async () => {
    const f = fx();
    const one = approve(f, CLIENT, REDIRECT, { client_doc: pkDoc(CLIENT, REDIRECT, { jwks: { keys: [K.ec.jwk] } }) });
    good(await token(f, exchangeParams(one.code), await assertionFor(f, CLIENT, { signer: K.ec, header: { kid: undefined } })));
    const g = fx();
    const many = approve(g);
    const r = await token(g, exchangeParams(many.code), await assertionFor(g, CLIENT, { header: { kid: undefined } }));
    expect(r).toMatchObject({ ok: false, error: "invalid_client" });
  });

  it("notes the method on the token and revoke audit rows, and never writes the assertion or a key", async () => {
    const f = fx();
    const a = approve(f);
    const assertion = await assertionFor(f, CLIENT);
    const t = good(await token(f, exchangeParams(a.code), assertion));
    await revoke(f, t.refresh_token, CLIENT, await assertionFor(f, CLIENT));
    const rows = f.auditRows();
    const detail = (action: string) => rows.filter((r) => r.action === action).map((r) => JSON.parse(r.detail as string) as Record<string, unknown>);
    expect(detail("oauth_code_exchange")[0]).toMatchObject({ client_auth: "private_key_jwt", grant_type: "authorization_code" });
    expect(detail("oauth_grant_ended")[0]).toMatchObject({ client_auth: "private_key_jwt", reason: "client_revoke" });
    expect(detail("oauth_assertion_use")[0]).toMatchObject({ client_auth: "private_key_jwt", alg: "RS256", kid: "rsa1" });
    const everything = JSON.stringify(rows);
    expect(everything).not.toContain(assertion);
    expect(everything).not.toContain(assertion.split(".")[2] as string);
    expect(everything).not.toContain(String(K.rsa.jwk.n));
    // Only the jti's hash is stored.
    expect(JSON.stringify(f.sql.all("SELECT * FROM oauth_client_jtis"))).not.toContain("jti-");
  });

  it("notes the method none on a public client's token rows", async () => {
    const f = fx();
    const d = request(f, CLIENT, REDIRECT, { client_doc: { client_id: CLIENT, redirect_uris: [REDIRECT] } });
    expect(d.ok).toBe(true);
    const dec = f.board.oauthDecide(webCtx(), { request_id: requestIdOf(d), approve: true, handle: "claude-ai" });
    const code = (dec as { value: { code: string } }).value.code;
    good(await token(f, exchangeParams(code)));
    const row = f.auditRows().find((r) => r.action === "oauth_code_exchange");
    expect(JSON.parse(row?.detail as string)).toMatchObject({ client_auth: "none" });
  });
});

describe("refusals (all invalid_client, counted, never ending a grant)", () => {
  const cases: [string, (f: Fixture) => Promise<string | undefined>][] = [
    ["wrong iss", (f) => assertionFor(f, CLIENT, { payload: { iss: OTHER } })],
    ["wrong sub", (f) => assertionFor(f, CLIENT, { payload: { sub: OTHER } })],
    ["missing sub", (f) => assertionFor(f, CLIENT, { payload: { sub: undefined } })],
    ["wrong aud", (f) => assertionFor(f, CLIENT, { payload: { aud: "https://elsewhere.example" } })],
    ["aud array without this server", (f) => assertionFor(f, CLIENT, { payload: { aud: ["https://a.example", "https://b.example"] } })],
    ["missing aud", (f) => assertionFor(f, CLIENT, { payload: { aud: undefined } })],
    ["expired", (f) => assertionFor(f, CLIENT, { payload: { exp: Math.floor(f.clock.t / 1000) - 3_600 } })],
    ["missing exp", (f) => assertionFor(f, CLIENT, { payload: { exp: undefined } })],
    ["exp as a string", (f) => assertionFor(f, CLIENT, { payload: { exp: String(Math.floor(f.clock.t / 1000) + 60) } })],
    ["exp too far ahead", (f) => assertionFor(f, CLIENT, { payload: { exp: Math.floor(f.clock.t / 1000) + 11 * 60 } })],
    ["iat in the future", (f) => assertionFor(f, CLIENT, { payload: { iat: Math.floor(f.clock.t / 1000) + 300 } })],
    ["nbf in the future", (f) => assertionFor(f, CLIENT, { payload: { nbf: Math.floor(f.clock.t / 1000) + 300 } })],
    ["missing jti", (f) => assertionFor(f, CLIENT, { payload: { jti: undefined } })],
    ["empty jti", (f) => assertionFor(f, CLIENT, { payload: { jti: "" } })],
    ["jti too long", (f) => assertionFor(f, CLIENT, { payload: { jti: "j".repeat(257) } })],
    ["jti not a string", (f) => assertionFor(f, CLIENT, { payload: { jti: 5 } })],
    ["alg none", (f) => assertionFor(f, CLIENT, { header: { alg: "none" }, signature: "" })],
    ["alg none with a signature", (f) => assertionFor(f, CLIENT, { header: { alg: "none" } })],
    ["HS256", (f) => hmacAssertion(f, CLIENT)],
    ["an algorithm the board does not support", (f) => assertionFor(f, CLIENT, { header: { alg: "PS256" } })],
    ["RS256 claimed for an EC key", (f) => assertionFor(f, CLIENT, { signer: K.ec, header: { alg: "RS256" } })],
    ["ES256 claimed for an RSA key", (f) => assertionFor(f, CLIENT, { signer: K.rsa, header: { alg: "ES256" } })],
    ["critical header parameters", (f) => assertionFor(f, CLIENT, { header: { crit: ["exp"] } })],
    ["unknown kid", (f) => assertionFor(f, CLIENT, { header: { kid: "rotated-away" } })],
    ["a bad signature (RSA, tampered)", async (f) => tamper(await assertionFor(f, CLIENT, { signer: K.rsa }))],
    ["a bad signature (EC, tampered)", async (f) => tamper(await assertionFor(f, CLIENT, { signer: K.ec }))],
    ["a signature by another key under the stored kid", (f) => assertionFor(f, CLIENT, { signer: K.impostor })],
    ["a signature of the wrong length (EC)", (f) => assertionFor(f, CLIENT, { signer: K.ec, signature: b64u(new Uint8Array(70)) })],
    ["not a compact JWS", async () => "not-a-jwt"],
    ["two parts", async () => "aaaa.bbbb"],
    ["four parts", async () => "aaaa.bbbb.cccc.dddd"],
    ["an oversize assertion", (f) => assertionFor(f, CLIENT, { payload: { pad: "x".repeat(9_000) } })],
    ["a payload that is not JSON", async () => `${b64u('{"alg":"RS256"}')}.${b64u("nope")}.${b64u("sig")}`],
    ["no assertion at all", async () => undefined],
  ];

  function tamper(jws: string): string {
    const [h, p, s] = jws.split(".") as [string, string, string];
    return `${h}.${p}.${s.slice(0, -2)}${s.endsWith("AA") ? "BB" : "AA"}`;
  }

  it.each(cases)("refuses %s, counts it, and leaves the grant and the code usable", async (_why, make) => {
    const f = fx();
    const a = approve(f);
    const before = f.auditRows().length;
    const r = await token(f, exchangeParams(a.code), await make(f));
    expect(r).toMatchObject({ ok: false, error: "invalid_client" });
    // Counted by the failed sign-in guards, with its reason on the row.
    const rows = f.auditRows().slice(before).filter((x) => x.action === "auth");
    expect(rows.length).toBe(1);
    expect(grantCount(f)).toBe(1);
    expect(f.sql.one("SELECT COUNT(*) AS n FROM oauth_codes WHERE used_at IS NOT NULL")).toEqual({ n: 0 });
    // The same code still works with a good assertion.
    good(await token(f, exchangeParams(a.code), await assertionFor(f, CLIENT)));
  });

  it("refuses the same cases on the revoke endpoint and on refresh without ending the grant", async () => {
    const f = fx();
    const p = await signIn(f);
    for (const [, make] of cases.slice(0, 8)) {
      const bad = await make(f);
      const r1 = await token(f, refreshParams(p.refresh), bad);
      expect(r1).toMatchObject({ ok: false, error: "invalid_client" });
      const r2 = await revoke(f, p.refresh, CLIENT, bad);
      expect(r2).toMatchObject({ ok: false, error: "invalid_client" });
    }
    expect(grantCount(f)).toBe(1);
    expect(f.sql.one("SELECT COUNT(*) AS n FROM oauth_tokens WHERE replaced_at IS NOT NULL")).toEqual({ n: 0 });
    good(await token(f, refreshParams(p.refresh), await assertionFor(f, CLIENT)));
  });

  it("a bad assertion over the failed sign-in limit is answered temporarily_unavailable, like any other refusal", async () => {
    const f = fx({ authFailureLimit: 2 });
    const a = approve(f);
    const out: string[] = [];
    for (let i = 0; i < 4; i++) {
      const r = await token(f, exchangeParams(a.code), "garbage");
      out.push(r.ok ? "ok" : r.error);
    }
    expect(out).toEqual(["invalid_client", "invalid_client", "temporarily_unavailable", "temporarily_unavailable"]);
    expect(grantCount(f)).toBe(1);
  });

  it("refuses an assertion type that is not jwt-bearer, and a type without an assertion", async () => {
    const f = fx();
    const a = approve(f);
    const assertion = await assertionFor(f, CLIENT);
    expect(await token(f, exchangeParams(a.code), assertion, { type: "urn:other" })).toMatchObject({ ok: false, error: "invalid_client" });
    expect(await token(f, exchangeParams(a.code), assertion, { type: undefined })).toMatchObject({ ok: false, error: "invalid_client" });
    const noAssertion = await f.board.authenticateOAuthClient({
      clientId: CLIENT,
      assertionType: ASSERTION_TYPE,
      audiences: [ISSUER],
      endpoint: "/oauth/token",
      source: SOURCE,
    });
    expect(noAssertion).toMatchObject({ ok: false, error: "invalid_client" });
    good(await token(f, exchangeParams(a.code), assertion));
  });

  it("refuses a request that carries a client_id different from the assertion's iss", async () => {
    const f = fx();
    const a = approve(f);
    const r = await token(f, exchangeParams(a.code, OTHER), await assertionFor(f, CLIENT));
    expect(r).toMatchObject({ ok: false, error: "invalid_client" });
    expect(grantCount(f)).toBe(1);
  });

  it("refuses an assertion from a client the board does not know, and a signing client's plain request", async () => {
    const f = fx();
    const a = approve(f);
    expect(await token(f, exchangeParams(a.code, OTHER, REDIRECT), await assertionFor(f, OTHER))).toMatchObject({ ok: false, error: "invalid_client" });
    // The signing client asking as if it were public, through the synchronous call too.
    expect(await token(f, exchangeParams(a.code))).toMatchObject({ ok: false, error: "invalid_client" });
    const direct = f.board.oauthToken({ params: exchangeParams(a.code), resource: RESOURCE, source: SOURCE });
    expect(direct).toMatchObject({ ok: false, error: "invalid_client" });
    expect(await revoke(f, "anything", CLIENT)).toMatchObject({ ok: false, error: "invalid_client" });
    expect(f.board.oauthRevoke({ token: "x", clientId: CLIENT, source: SOURCE })).toMatchObject({ ok: false, error: "invalid_client" });
    expect(grantCount(f)).toBe(1);
  });

  it("refuses an assertion from a public client", async () => {
    const f = fx();
    const d = request(f, CLIENT, REDIRECT, { client_doc: { client_id: CLIENT, redirect_uris: [REDIRECT] } });
    const dec = f.board.oauthDecide(webCtx(), { request_id: requestIdOf(d), approve: true, handle: "claude-ai" });
    const code = (dec as { value: { code: string } }).value.code;
    const r = await token(f, exchangeParams(code), await assertionFor(f, CLIENT));
    expect(r).toMatchObject({ ok: false, error: "invalid_client" });
    // The public client's own request still works.
    good(await token(f, exchangeParams(code)));
  });

  it("holds the declared algorithm: an RS256 assertion from a client that declared ES256 is refused", async () => {
    const f = fx();
    const a = approve(f, CLIENT, REDIRECT, { client_doc: pkDoc(CLIENT, REDIRECT, { token_endpoint_auth_signing_alg: "ES256" }) });
    expect(await token(f, exchangeParams(a.code), await assertionFor(f, CLIENT, { signer: K.rsa }))).toMatchObject({ ok: false, error: "invalid_client" });
    good(await token(f, exchangeParams(a.code), await assertionFor(f, CLIENT, { signer: K.ec })));
  });
});

describe("a valid assertion does not make another client's secrets usable", () => {
  it("refuses client A's assertion with client B's code, and B's grant stays", async () => {
    const f = fx();
    const a = approve(f, CLIENT, REDIRECT);
    const b = approve(f, OTHER, OTHER_REDIRECT);
    // A authenticates as A and presents B's code with B's redirect: the code is not A's.
    const r = await token(f, exchangeParams(b.code, CLIENT, OTHER_REDIRECT), await assertionFor(f, CLIENT));
    expect(r).toMatchObject({ ok: false, error: "invalid_grant" });
    expect(grantCount(f)).toBe(2);
    // Each client's own code works.
    good(await token(f, exchangeParams(a.code), await assertionFor(f, CLIENT)));
    good(await token(f, exchangeParams(b.code, OTHER, OTHER_REDIRECT), await assertionFor(f, OTHER)));
  });

  it("refuses client A's assertion with client B's refresh token and B's access token to revoke", async () => {
    const f = fx();
    await signIn(f, CLIENT, REDIRECT);
    const b = await signIn(f, OTHER, OTHER_REDIRECT);
    const r = await token(f, refreshParams(b.refresh, CLIENT), await assertionFor(f, CLIENT));
    expect(r).toMatchObject({ ok: false, error: "invalid_grant" });
    const rv = await revoke(f, b.access, CLIENT, await assertionFor(f, CLIENT));
    expect(rv).toMatchObject({ ok: false, error: "invalid_client" });
    expect(grantCount(f)).toBe(2);
    good(await token(f, refreshParams(b.refresh, OTHER), await assertionFor(f, OTHER)));
  });

  it("still ends the grant when an authenticated client replays a code or a refresh token", async () => {
    const f = fx();
    const a = approve(f);
    good(await token(f, exchangeParams(a.code), await assertionFor(f, CLIENT)));
    const replay = await token(f, exchangeParams(a.code), await assertionFor(f, CLIENT));
    expect(replay).toMatchObject({ ok: false, error: "invalid_grant" });
    expect(grantCount(f)).toBe(0);
  });
});

describe("the assertion's jti is single use, as a condition of the write", () => {
  it("refuses a second use, even for another request", async () => {
    const f = fx();
    const a = approve(f);
    const assertion = await assertionFor(f, CLIENT);
    const t = good(await token(f, exchangeParams(a.code), assertion));
    const again = await token(f, refreshParams(t.refresh_token), assertion);
    expect(again).toMatchObject({ ok: false, error: "invalid_client" });
    // The refresh token was not spent and the grant lives.
    good(await token(f, refreshParams(t.refresh_token), await assertionFor(f, CLIENT)));
  });

  it("lets exactly one of several concurrent uses of one assertion win", async () => {
    const f = fx();
    const codes = [approve(f), approve(f), approve(f), approve(f), approve(f)];
    const shared = await assertionFor(f, CLIENT);
    const results = await Promise.all(codes.map((c) => token(f, exchangeParams(c.code), shared)));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok && r.error === "invalid_client")).toHaveLength(4);
    expect(f.sql.one("SELECT COUNT(*) AS n FROM oauth_client_jtis")).toEqual({ n: 1 });
    expect(f.sql.one("SELECT COUNT(*) AS n FROM oauth_codes WHERE used_at IS NOT NULL")).toEqual({ n: 1 });
  });

  it("scopes a jti to its client: two clients may use the same jti", async () => {
    const f = fx();
    const a = approve(f, CLIENT, REDIRECT);
    const b = approve(f, OTHER, OTHER_REDIRECT);
    good(await token(f, exchangeParams(a.code), await assertionFor(f, CLIENT, { payload: { jti: "same" } })));
    good(await token(f, exchangeParams(b.code, OTHER, OTHER_REDIRECT), await assertionFor(f, OTHER, { payload: { jti: "same" } })));
  });

  it("caps the unexpired jti rows per client in the write, frees them as they expire, and prunes them", async () => {
    const f = fx({ oauthJtiMaxPerClient: 2 });
    const a = approve(f);
    const t = good(await token(f, exchangeParams(a.code), await assertionFor(f, CLIENT)));
    const t1 = good(await token(f, refreshParams(t.refresh_token), await assertionFor(f, CLIENT)));
    const third = await token(f, refreshParams(t1.refresh_token), await assertionFor(f, CLIENT));
    expect(third).toMatchObject({ ok: false, error: "invalid_client" });
    expect(f.sql.one("SELECT COUNT(*) AS n FROM oauth_client_jtis")).toEqual({ n: 2 });
    // Once they can no longer validate (exp plus the skew), the rows are deleted by the next write.
    f.clock.advance(7 * MIN);
    const t2 = good(await token(f, refreshParams(t1.refresh_token), await assertionFor(f, CLIENT)));
    expect(f.sql.one("SELECT COUNT(*) AS n FROM oauth_client_jtis")).toEqual({ n: 1 });
    expect(t2.refresh_token).toBeTruthy();
    // The prune timer frees whatever is left once it expires.
    f.clock.advance(24 * 60 * MIN);
    f.board.runDueTimers();
    expect(f.sql.one("SELECT COUNT(*) AS n FROM oauth_client_jtis")).toEqual({ n: 0 });
  });

  it("does not spend the jti when the assertion fails any check", async () => {
    const f = fx();
    const a = approve(f);
    await token(f, exchangeParams(a.code), await assertionFor(f, CLIENT, { payload: { aud: "https://elsewhere.example", jti: "keep" } }));
    expect(f.sql.one("SELECT COUNT(*) AS n FROM oauth_client_jtis")).toEqual({ n: 0 });
    good(await token(f, exchangeParams(a.code), await assertionFor(f, CLIENT, { payload: { jti: "keep" } })));
  });
});

describe("key rotation: a kid the stored set lacks (design §9 client authentication)", () => {
  const JWKS_URI = "https://client.example/oauth/jwks.json";
  /** A document with a key set address, and the set the Worker would have fetched (the RSA key only). */
  const withUri = (): Record<string, unknown> => ({
    client_doc: pkDoc(CLIENT, REDIRECT, { jwks: undefined, jwks_uri: JWKS_URI }),
    client_jwks: { keys: [K.rsa.jwk] },
  });

  it("names the client to refetch (uncounted) when it has a jwks_uri, once, and counts the second refusal", async () => {
    const f = fx();
    const a = approve(f, CLIENT, REDIRECT, withUri());
    const rotated = await assertionFor(f, CLIENT, { signer: K.ec });
    const before = f.auditRows().length;
    const first = await token(f, exchangeParams(a.code), rotated);
    expect(first).toMatchObject({ ok: false, error: "invalid_client", refetchKeys: CLIENT });
    expect(f.auditRows().length).toBe(before);
    const again = await f.board.authenticateOAuthClient({
      clientId: CLIENT,
      assertionType: ASSERTION_TYPE,
      assertion: rotated,
      audiences: [ISSUER],
      endpoint: "/oauth/token",
      keysRefetched: true,
      source: SOURCE,
    });
    expect(again).toMatchObject({ ok: false, error: "invalid_client" });
    expect(again).not.toHaveProperty("refetchKeys");
    expect(f.auditRows().length).toBe(before + 1);
  });

  it("gives no refetch hint for an inline key set", async () => {
    const f = fx();
    const a = approve(f);
    const r = await token(f, exchangeParams(a.code), await assertionFor(f, CLIENT, { header: { kid: "rotated-away" } }));
    expect(r).not.toHaveProperty("refetchKeys");
  });

  it("claims a refetch at most once per interval, however many ask, and writes nothing for a refused claim", async () => {
    const f = fx();
    approve(f, CLIENT, REDIRECT, withUri());
    // Fetched just now with the document.
    expect(f.board.oauthClaimKeyRefetch(CLIENT)).toBeNull();
    f.clock.advance(5 * MIN);
    const before = f.auditRows().length;
    const claims = [f.board.oauthClaimKeyRefetch(CLIENT), f.board.oauthClaimKeyRefetch(CLIENT), f.board.oauthClaimKeyRefetch(CLIENT)];
    expect(claims).toEqual([JWKS_URI, null, null]);
    expect(f.auditRows().length).toBe(before + 1);
    f.clock.advance(4 * MIN);
    expect(f.board.oauthClaimKeyRefetch(CLIENT)).toBeNull();
    f.clock.advance(MIN);
    expect(f.board.oauthClaimKeyRefetch(CLIENT)).toBe(JWKS_URI);
  });

  it("never claims for an inline or public client or an unknown one", () => {
    const f = fx();
    approve(f);
    f.clock.advance(60 * MIN);
    expect(f.board.oauthClaimKeyRefetch(CLIENT)).toBeNull();
    expect(f.board.oauthClaimKeyRefetch(OTHER)).toBeNull();
  });

  it("stores a refetched set and then accepts the new key", async () => {
    const f = fx();
    const a = approve(f, CLIENT, REDIRECT, withUri());
    const rotated = await assertionFor(f, CLIENT, { signer: K.ec });
    expect(await token(f, exchangeParams(a.code), rotated)).toMatchObject({ refetchKeys: CLIENT });
    f.clock.advance(5 * MIN);
    expect(f.board.oauthClaimKeyRefetch(CLIENT)).toBe(JWKS_URI);
    expect(f.board.oauthStoreKeys(CLIENT, { keys: [K.rsa.jwk, K.ec.jwk] })).toBe(true);
    // (The first code has expired by now; the document is still fresh, so a new request needs no fetch.)
    const b = approve(f, CLIENT, REDIRECT, { client_doc: undefined });
    good(await token(f, exchangeParams(b.code), await assertionFor(f, CLIENT, { signer: K.ec })));
  });

  it("refuses to store a key set that breaks the key rules, a set for a client that has no address, and keeps the old keys", async () => {
    const f = fx();
    approve(f, CLIENT, REDIRECT, withUri());
    expect(f.board.oauthStoreKeys(CLIENT, { keys: [K.small.jwk] })).toBe(false);
    expect(f.board.oauthStoreKeys(CLIENT, "nope")).toBe(false);
    const row = f.sql.one("SELECT jwks FROM oauth_clients WHERE client_id = ?", CLIENT) as { jwks: string };
    expect((JSON.parse(row.jwks) as { kid: string }[]).map((k) => k.kid)).toEqual(["rsa1"]);
    const g = fx();
    approve(g);
    expect(g.board.oauthStoreKeys(CLIENT, K.jwks)).toBe(false);
  });
});

describe("upgrading from schema version 9 and the configuration", () => {
  it("keeps existing clients and grants working as public clients", async () => {
    const sql = new NodeSqliteSql();
    migrate(sql, 0);
    for (const stmt of [
      "DROP INDEX users_parent",
      "DROP INDEX users_parent_harness_session",
      "ALTER TABLE users DROP COLUMN retired_at",
      "ALTER TABLE users DROP COLUMN harness_session",
      "ALTER TABLE users DROP COLUMN parent",
      "ALTER TABLE sessions DROP COLUMN grant_id",
      "DROP INDEX users_handle_nocase",
      "DROP INDEX approvals_target",
      "DROP INDEX approvals_handle",
      "DROP TABLE approvals",
      "ALTER TABLE web_pairings DROP COLUMN approval_hash",
      "ALTER TABLE passkeys DROP COLUMN approver_barred",
      "ALTER TABLE topics DROP COLUMN announce_pending",
      "DROP INDEX passkey_challenges_expiry",
      "DROP TABLE passkey_challenges",
      "DROP TABLE passkey_users",
      "DROP INDEX passkeys_handle",
      "DROP TABLE passkeys",
      "DROP INDEX web_sessions_passkey",
      "ALTER TABLE web_sessions DROP COLUMN passkey",
      "ALTER TABLE web_sessions DROP COLUMN method",
      "DROP INDEX sessions_handle_mcp",
      "DROP INDEX audit_session_ts",
      "ALTER TABLE sessions DROP COLUMN mcp_session_hash",
      "ALTER TABLE sessions DROP COLUMN via_grant",
      "DROP INDEX audit_action_actor_seq",
      "DROP INDEX sessions_handle_attached",
      "ALTER TABLE sessions DROP COLUMN os",
      "ALTER TABLE sessions DROP COLUMN model",
      "DROP INDEX oauth_client_jtis_expiry",
      "DROP TABLE oauth_client_jtis",
      "ALTER TABLE oauth_clients DROP COLUMN auth_method",
      "ALTER TABLE oauth_clients DROP COLUMN auth_alg",
      "ALTER TABLE oauth_clients DROP COLUMN jwks_uri",
      "ALTER TABLE oauth_clients DROP COLUMN jwks",
      "ALTER TABLE oauth_clients DROP COLUMN jwks_fetched_at",
      "UPDATE meta SET value = '9' WHERE key = 'schema_version'",
    ]) {
      sql.exec(stmt);
    }
    const now = Date.UTC(2026, 10, 20, 12, 0, 0);
    sql.exec("INSERT INTO users (handle, kind, created_at) VALUES ('claude-ai', 'agent', 0)");
    sql.exec("INSERT INTO oauth_clients (client_id, name, redirect_uris, fetched_at) VALUES (?, 'Old', ?, ?)", CLIENT, JSON.stringify([REDIRECT]), now);
    sql.exec(
      `INSERT INTO oauth_grants (id, client_id, client_name, client_host, handle, approved_by, created_at, renewed_at, expires_at)
       VALUES ('og_old', ?, 'Old', 'client.example', 'claude-ai', 'claude-ai', ?, ?, ?)`,
      CLIENT,
      now,
      now,
      now + 30 * 24 * 60 * MIN,
    );
    sql.exec(
      `INSERT INTO oauth_tokens (grant_id, parent_id, access_hash, access_expires_at, refresh_hash, issued_at)
       VALUES ('og_old', NULL, ?, ?, ?, ?)`,
      sha256("at-old"),
      now + 60 * MIN,
      sha256("rt-old"),
      now,
    );
    const board = new Board({ sql, now: () => now, sha256 });
    expect(sql.one("SELECT auth_method, jwks, jwks_uri, auth_alg FROM oauth_clients")).toEqual({
      auth_method: "none",
      jwks: null,
      jwks_uri: null,
      auth_alg: null,
    });
    // As a public client: it authenticates with its client_id, refuses an assertion, and its grant refreshes.
    expect(await board.authenticateOAuthClient({ clientId: CLIENT, audiences: [ISSUER], endpoint: "/oauth/token" })).toEqual({
      ok: true,
      auth: { clientId: CLIENT, method: "none" },
    });
    const withAssertion = await board.authenticateOAuthClient({
      clientId: CLIENT,
      assertionType: ASSERTION_TYPE,
      assertion: "a.b.c",
      audiences: [ISSUER],
      endpoint: "/oauth/token",
    });
    expect(withAssertion).toMatchObject({ ok: false, error: "invalid_client" });
    const refreshed = board.oauthToken({ params: refreshParams("rt-old"), resource: RESOURCE });
    expect(refreshed.ok).toBe(true);
    const listed = board.act<{ grants: { client_auth: string }[] }>({ handle: "owner", via: "cli" }, "oauth_grants", {});
    // (No human here: the listing is refused, which is fine; the grant listing is covered above.)
    expect(listed.ok).toBe(false);
  });

  it("validates the new thresholds as positive integers", () => {
    for (const key of [
      "oauthJwksMaxBytes",
      "oauthJwksMaxKeys",
      "oauthJwksRefetchMs",
      "oauthAssertionMaxBytes",
      "oauthAssertionSkewMs",
      "oauthAssertionMaxLifetimeMs",
      "oauthJtiMaxPerClient",
    ] as const) {
      expect(validateConfig({ ...DEFAULT_CONFIG, [key]: 0 }), key).toMatch(/positive integer/);
      expect(validateConfig({ ...DEFAULT_CONFIG, [key]: 1.5 }), key).toMatch(/positive integer/);
    }
    expect(validateConfig(DEFAULT_CONFIG)).toBeUndefined();
  });

  it("keeps a signing client's row, and so its method, while it has a live grant, however old", async () => {
    const f = fx();
    const p = await signIn(f);
    f.clock.advance(2 * 24 * 60 * MIN);
    f.board.runDueTimers();
    expect(f.sql.one("SELECT auth_method FROM oauth_clients")).toEqual({ auth_method: "private_key_jwt" });
    // It must still sign: a plain refresh is refused.
    expect(await token(f, refreshParams(p.refresh))).toMatchObject({ ok: false, error: "invalid_client" });
    good(await token(f, refreshParams(p.refresh), await assertionFor(f, CLIENT)));
  });
});

// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0

/**
 * Client authentication with `private_key_jwt` (issue #55, RFC 7523 section 3
 * and OpenID Connect Core section 9; design §9 "Client authentication").
 *
 * A client whose metadata document asks for it signs a short-lived JWT (its
 * "assertion") with its private key and sends it to `/oauth/token` and
 * `/oauth/revoke`; the board checks the signature against the client's public
 * keys. This file holds the rules and the check. It uses only the Web Crypto
 * global (`crypto.subtle`), which Workers and Node 22+ both have, and imports
 * nothing from either. Web Crypto's verify is asynchronous, so the check runs
 * before the board's synchronous write (`Board.authenticateOAuthClient`); the
 * single-use `jti` is then spent in the write itself (`oauthAssertionUse`).
 *
 * Only RS256 and ES256 are accepted. The header's `alg` is never trusted to
 * choose a weaker check: it must be one of the two, must match the algorithm
 * the client's document declared (when it did), and must fit the key's type.
 * `jwk`, `jku` and `x5u` in a header are ignored: keys come only from the
 * client's stored key set. A header with `crit` is refused.
 */

import type { BoardConfig } from "../types.ts";

/** The `client_assertion_type` a JWT assertion carries. */
export const ASSERTION_TYPE = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";

export type AuthMethod = "none" | "private_key_jwt";
export type SigningAlg = "RS256" | "ES256";
export const SIGNING_ALGS: readonly SigningAlg[] = ["RS256", "ES256"];

/** The shortest RSA modulus accepted. */
export const MIN_RSA_BITS = 2_048;
const MAX_KID = 256;
const MAX_JTI = 256;
/** Entries of a key set looked at, whatever the cap on keys kept (a set of junk is refused, not parsed forever). */
const MAX_KEY_ENTRIES = 100;

/** One public signing key, reduced to the fields the check needs. */
export interface ClientKey {
  kid?: string;
  kty: "RSA" | "EC";
  /** RSA: modulus and exponent, base64url. */
  n?: string;
  e?: string;
  /** EC (P-256): the point, base64url. */
  x?: string;
  y?: string;
}

const B64URL_RE = /^[A-Za-z0-9_-]*$/;

/** Strict base64url decoding (no padding, no other characters); undefined when malformed. */
export function b64uDecode(s: string): Uint8Array | undefined {
  if (!B64URL_RE.test(s) || s.length % 4 === 1) return undefined;
  const padded = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bitLength(bytes: Uint8Array): number {
  let i = 0;
  while (i < bytes.length && bytes[i] === 0) i++;
  if (i === bytes.length) return 0;
  return (bytes.length - i) * 8 - Math.clz32(bytes[i] as number) + 24;
}

export type KeySetResult = { ok: true; keys: ClientKey[] } | { ok: false; reason: string };

/**
 * Reduce a JWK Set to the public signing keys the board can use: RSA keys of
 * at least 2048 bits and P-256 keys, whose `use` (when present) is `sig` and
 * whose `alg` (when present) is the one their type allows. Other keys are
 * skipped, as a key set may hold keys for other purposes; a set with none left
 * is refused. At most `oauthJwksMaxKeys` are kept, and private fields are
 * never copied. Pure, so the Worker's fetch result and a document's inline
 * `jwks` take the same path.
 */
export function parseKeySet(raw: unknown, config: Pick<BoardConfig, "oauthJwksMaxBytes" | "oauthJwksMaxKeys">): KeySetResult {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, reason: "the key set is not a JSON object" };
  const keys = (raw as Record<string, unknown>).keys;
  if (!Array.isArray(keys)) return { ok: false, reason: "the key set has no keys array" };
  if (JSON.stringify(raw).length > config.oauthJwksMaxBytes) {
    return { ok: false, reason: `the key set is larger than ${config.oauthJwksMaxBytes} bytes` };
  }
  const kept: ClientKey[] = [];
  const skipped = new Set<string>();
  for (const entry of keys.slice(0, MAX_KEY_ENTRIES)) {
    if (kept.length >= config.oauthJwksMaxKeys) break;
    const k = reduceKey(entry);
    if ("skip" in k) skipped.add(k.skip);
    else kept.push(k);
  }
  if (kept.length === 0) {
    const why = skipped.size > 0 ? ` (${[...skipped].join("; ")})` : "";
    return { ok: false, reason: `the key set has no usable signing key${why}` };
  }
  return { ok: true, keys: kept };
}

function reduceKey(entry: unknown): ClientKey | { skip: string } {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return { skip: "a key is not an object" };
  const k = entry as Record<string, unknown>;
  if (k.use !== undefined && k.use !== "sig") return { skip: "a key is not for signing" };
  if (k.key_ops !== undefined && !(Array.isArray(k.key_ops) && k.key_ops.includes("verify"))) return { skip: "a key is not for verifying" };
  let kid: string | undefined;
  if (k.kid !== undefined) {
    if (typeof k.kid !== "string" || k.kid.length === 0 || k.kid.length > MAX_KID) return { skip: "a key has a bad kid" };
    kid = k.kid;
  }
  const withKid = <T extends ClientKey>(key: T): T => (kid !== undefined ? { ...key, kid } : key);
  if (k.kty === "RSA") {
    if (k.alg !== undefined && k.alg !== "RS256") return { skip: "an RSA key names an algorithm other than RS256" };
    if (typeof k.n !== "string" || typeof k.e !== "string") return { skip: "an RSA key lacks n or e" };
    const n = b64uDecode(k.n);
    const e = b64uDecode(k.e);
    if (!n || !e || e.length === 0 || e.length > 8) return { skip: "an RSA key is malformed" };
    if (bitLength(n) < MIN_RSA_BITS) return { skip: `an RSA key is shorter than ${MIN_RSA_BITS} bits` };
    return withKid({ kty: "RSA", n: k.n, e: k.e });
  }
  if (k.kty === "EC") {
    if (k.crv !== "P-256") return { skip: "an EC key is not on P-256" };
    if (k.alg !== undefined && k.alg !== "ES256") return { skip: "an EC key names an algorithm other than ES256" };
    if (typeof k.x !== "string" || typeof k.y !== "string") return { skip: "an EC key lacks x or y" };
    if (b64uDecode(k.x)?.length !== 32 || b64uDecode(k.y)?.length !== 32) return { skip: "an EC key is malformed" };
    return withKid({ kty: "EC", x: k.x, y: k.y });
  }
  return { skip: "a key is neither RSA nor EC" };
}

/** A stored key set (JSON written by `parseKeySet`'s output), or undefined when it does not read back. */
export function readStoredKeys(json: string | null): ClientKey[] | undefined {
  if (json === null) return undefined;
  try {
    const v = JSON.parse(json) as unknown;
    return Array.isArray(v) ? (v as ClientKey[]) : undefined;
  } catch {
    return undefined;
  }
}

function decodeJson(part: string): Record<string, unknown> | undefined {
  const bytes = b64uDecode(part);
  if (!bytes) return undefined;
  try {
    const v = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes)) as unknown;
    return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The `iss` an assertion names, read without checking anything, only to find
 * which client's keys to check it against when the request has no `client_id`.
 */
export function peekIssuer(assertion: string): string | undefined {
  const parts = assertion.split(".");
  if (parts.length !== 3) return undefined;
  const payload = decodeJson(parts[1] as string);
  return typeof payload?.iss === "string" ? payload.iss : undefined;
}

export interface AssertionCheck {
  assertion: string;
  clientId: string;
  keys: readonly ClientKey[];
  /** The algorithm the client's document declared, or null. */
  declaredAlg: SigningAlg | null;
  /** The addresses an assertion's `aud` may name. */
  audiences: readonly string[];
  now: number;
  config: Pick<BoardConfig, "oauthAssertionMaxBytes" | "oauthAssertionSkewMs" | "oauthAssertionMaxLifetimeMs">;
}

export type AssertionResult =
  | { ok: true; jti: string; expiresAt: number; alg: SigningAlg; kid: string | null }
  /** `unknownKid`: the header named a `kid` the stored set lacks, so the set may have rotated. */
  | { ok: false; reason: string; unknownKid?: true };

const refuse = (reason: string): AssertionResult => ({ ok: false, reason });

/**
 * Check a client assertion: its form, claims and signature. `expiresAt` is the
 * time (ms) until which the assertion could still pass this check, which is how
 * long its `jti` must be remembered. Never throws.
 */
export async function verifyAssertion(a: AssertionCheck): Promise<AssertionResult> {
  try {
    return await verify(a);
  } catch {
    return refuse("the assertion could not be checked");
  }
}

async function verify(a: AssertionCheck): Promise<AssertionResult> {
  if (a.assertion.length > a.config.oauthAssertionMaxBytes) return refuse("the assertion is too long");
  const parts = a.assertion.split(".");
  if (parts.length !== 3 || parts.some((p) => p === "")) return refuse("the assertion is not a compact JWS");
  const [h, p, s] = parts as [string, string, string];
  const header = decodeJson(h);
  const payload = decodeJson(p);
  const sig = b64uDecode(s);
  if (!header || !payload || !sig) return refuse("the assertion is not a compact JWS");
  if (header.crit !== undefined) return refuse("the assertion has critical header parameters");
  const alg = header.alg;
  if (alg !== "RS256" && alg !== "ES256") return refuse("the assertion's algorithm is not RS256 or ES256");
  if (a.declaredAlg !== null && alg !== a.declaredAlg) return refuse("the assertion's algorithm is not the one the client declared");

  // Claims first: the cheap checks, before any key is imported.
  const skew = a.config.oauthAssertionSkewMs;
  if (payload.iss !== a.clientId) return refuse("iss is not the client");
  if (payload.sub !== a.clientId) return refuse("sub is not the client");
  const aud = payload.aud;
  const auds = typeof aud === "string" ? [aud] : Array.isArray(aud) && aud.every((x) => typeof x === "string") ? (aud as string[]) : [];
  if (!auds.some((x) => a.audiences.includes(x))) return refuse("aud does not name this server");
  const exp = payload.exp;
  if (typeof exp !== "number" || !Number.isFinite(exp)) return refuse("exp is missing or not a number");
  if (exp * 1_000 + skew <= a.now) return refuse("the assertion has expired");
  if (exp * 1_000 - a.now > a.config.oauthAssertionMaxLifetimeMs) return refuse("exp is too far ahead");
  for (const claim of ["nbf", "iat"] as const) {
    const v = payload[claim];
    if (v === undefined) continue;
    if (typeof v !== "number" || !Number.isFinite(v)) return refuse(`${claim} is not a number`);
    if (v * 1_000 - skew > a.now) return refuse(`${claim} is in the future`);
  }
  const jti = payload.jti;
  if (typeof jti !== "string" || jti.length === 0 || jti.length > MAX_JTI) return refuse("jti is missing or not a short string");

  // The key: by `kid`, or the only key.
  const kid = header.kid;
  if (kid !== undefined && typeof kid !== "string") return refuse("kid is not a string");
  const wantKty = alg === "RS256" ? "RSA" : "EC";
  let candidates: readonly ClientKey[];
  if (kid !== undefined) {
    candidates = a.keys.filter((k) => k.kid === kid);
    if (candidates.length === 0) return { ok: false, reason: "no key has the assertion's kid", unknownKid: true };
  } else if (a.keys.length === 1) {
    candidates = a.keys;
  } else {
    return refuse("the assertion has no kid and the client has several keys");
  }
  const usable = candidates.filter((k) => k.kty === wantKty);
  if (usable.length === 0) return refuse("the key is not of the type the algorithm needs");
  const data = new TextEncoder().encode(`${h}.${p}`);
  for (const key of usable) {
    if (await signatureHolds(alg, key, data, sig)) {
      return { ok: true, jti, expiresAt: exp * 1_000 + skew, alg, kid: kid ?? null };
    }
  }
  return refuse("the signature does not verify");
}

async function signatureHolds(alg: SigningAlg, key: ClientKey, data: Uint8Array, sig: Uint8Array): Promise<boolean> {
  if (alg === "RS256") {
    const k = await crypto.subtle.importKey(
      "jwk",
      { kty: "RSA", n: key.n as string, e: key.e as string, alg: "RS256", ext: true },
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    return crypto.subtle.verify("RSASSA-PKCS1-v1_5", k, sig as Uint8Array<ArrayBuffer>, data as Uint8Array<ArrayBuffer>);
  }
  // ES256 signatures in a JWS are the raw 64-byte r and s, which is the form Web Crypto takes.
  if (sig.length !== 64) return false;
  const k = await crypto.subtle.importKey(
    "jwk",
    { kty: "EC", crv: "P-256", x: key.x as string, y: key.y as string, ext: true },
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  return crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, k, sig as Uint8Array<ArrayBuffer>, data as Uint8Array<ArrayBuffer>);
}

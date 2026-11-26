// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0

/**
 * The WebAuthn checks for passkey sign-in (issue #54, design §12), as pure
 * functions: a minimal CBOR decoder, the authenticator data and COSE key
 * parsers, the client data checks and the signature check. It uses only the
 * Web Crypto global (`crypto.subtle`) and imports nothing from Node or
 * Cloudflare, like `client-auth.ts`. Web Crypto's verify and import are
 * asynchronous, so the check runs before the board's synchronous write
 * (`Board.passkeySigninFinish`, `Board.passkeyRegisterFinish`).
 *
 * Two algorithms only: ES256 (COSE -7, P-256) and RS256 (COSE -257, RSA of at
 * least 2048 bits). Attestation statements are not verified: the board asks
 * for `attestation: "none"` and ignores whatever format arrives, because the
 * board trusts a credential for being registered by a signed-in person, not
 * for what made it. Every refusal is a `PasskeyError` carrying a short
 * snake_case reason for the audit row.
 */

import { b64uDecode, MIN_RSA_BITS } from "./client-auth.ts";

export type PasskeyAlg = "ES256" | "RS256";
export const COSE_ES256 = -7;
export const COSE_RS256 = -257;

/** A refused credential, registration or assertion. `reason` is for the audit row, never the person. */
export class PasskeyError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(reason);
    this.name = "PasskeyError";
    this.reason = reason;
  }
}

/** A base64url text field of an answer, decoded; refused when empty, malformed or longer than `max` bytes. */
export function bytesField(v: unknown, max: number): Uint8Array {
  if (typeof v !== "string" || v.length === 0 || v.length > Math.ceil((max * 4) / 3) + 4) throw new PasskeyError("malformed_request");
  const bytes = b64uDecode(v);
  if (bytes === undefined || bytes.length === 0 || bytes.length > max) throw new PasskeyError("malformed_request");
  return bytes;
}

/** A field of an answer that must be a JSON object. */
export function objectField(v: unknown): Record<string, unknown> {
  if (v === null || typeof v !== "object" || Array.isArray(v)) throw new PasskeyError("malformed_request");
  return v as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// CBOR (RFC 8949), the part WebAuthn uses.

/** A decoded CBOR map: keys are numbers or text. */
export type CborMap = Map<number | string, unknown>;

const MAX_DEPTH = 8;
const MAX_ENTRIES = 256;
const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/**
 * Decode one definite-length CBOR item at `pos`. Integers must be safe
 * integers, floats become numbers, a tag is skipped, and indefinite lengths,
 * 64-bit integers past 2^53 and simple values other than the booleans, null
 * and undefined are refused. Returns the value and where it ended.
 */
export function cborDecode(buf: Uint8Array, pos = 0, depth = 0): { value: unknown; end: number } {
  if (depth > MAX_DEPTH) throw new PasskeyError("cbor_too_deep");
  if (pos >= buf.length) throw new PasskeyError("cbor_truncated");
  const first = buf[pos] as number;
  const major = first >> 5;
  const info = first & 31;
  if (major === 7) return decodeSimple(buf, pos, info);
  let arg: number;
  let end = pos + 1;
  if (info < 24) {
    arg = info;
  } else if (info === 24 || info === 25 || info === 26 || info === 27) {
    const size = 1 << (info - 24);
    if (end + size > buf.length) throw new PasskeyError("cbor_truncated");
    const view = new DataView(buf.buffer, buf.byteOffset + end, size);
    if (size === 1) arg = view.getUint8(0);
    else if (size === 2) arg = view.getUint16(0);
    else if (size === 4) arg = view.getUint32(0);
    else {
      const hi = view.getUint32(0);
      if (hi >= 0x200000) throw new PasskeyError("cbor_integer_too_large");
      arg = hi * 0x1_0000_0000 + view.getUint32(4);
    }
    end += size;
  } else {
    throw new PasskeyError("cbor_indefinite_length");
  }
  switch (major) {
    case 0:
      return { value: arg, end };
    case 1:
      return { value: -1 - arg, end };
    case 2:
    case 3: {
      if (arg > buf.length - end) throw new PasskeyError("cbor_truncated");
      const bytes = buf.subarray(end, end + arg);
      if (major === 2) return { value: bytes, end: end + arg };
      try {
        return { value: UTF8.decode(bytes), end: end + arg };
      } catch {
        throw new PasskeyError("cbor_bad_text");
      }
    }
    case 4: {
      if (arg > MAX_ENTRIES) throw new PasskeyError("cbor_too_large");
      const out: unknown[] = [];
      for (let i = 0; i < arg; i++) {
        const item = cborDecode(buf, end, depth + 1);
        out.push(item.value);
        end = item.end;
      }
      return { value: out, end };
    }
    case 5: {
      if (arg > MAX_ENTRIES) throw new PasskeyError("cbor_too_large");
      const out: CborMap = new Map();
      for (let i = 0; i < arg; i++) {
        const k = cborDecode(buf, end, depth + 1);
        if (typeof k.value !== "number" && typeof k.value !== "string") throw new PasskeyError("cbor_bad_key");
        if (out.has(k.value)) throw new PasskeyError("cbor_duplicate_key");
        const v = cborDecode(buf, k.end, depth + 1);
        out.set(k.value, v.value);
        end = v.end;
      }
      return { value: out, end };
    }
    default:
      // Major type 6: a tag. Skipped; the tagged item is the value.
      return cborDecode(buf, end, depth + 1);
  }
}

function decodeSimple(buf: Uint8Array, pos: number, info: number): { value: unknown; end: number } {
  if (info === 20) return { value: false, end: pos + 1 };
  if (info === 21) return { value: true, end: pos + 1 };
  if (info === 22) return { value: null, end: pos + 1 };
  if (info === 23) return { value: undefined, end: pos + 1 };
  if (info === 25 || info === 26 || info === 27) {
    const size = 1 << (info - 24);
    if (pos + 1 + size > buf.length) throw new PasskeyError("cbor_truncated");
    const view = new DataView(buf.buffer, buf.byteOffset + pos + 1, size);
    if (size === 4) return { value: view.getFloat32(0), end: pos + 5 };
    if (size === 8) return { value: view.getFloat64(0), end: pos + 9 };
    const h = view.getUint16(0);
    const exp = (h >> 10) & 31;
    const frac = h & 1023;
    const mag = exp === 0 ? frac * 2 ** -24 : exp === 31 ? (frac === 0 ? Infinity : NaN) : (1 + frac / 1024) * 2 ** (exp - 15);
    return { value: h & 0x8000 ? -mag : mag, end: pos + 3 };
  }
  throw new PasskeyError("cbor_unsupported_simple");
}

/** Decode a buffer that must hold exactly one CBOR item. */
export function cborDecodeAll(buf: Uint8Array): unknown {
  const { value, end } = cborDecode(buf);
  if (end !== buf.length) throw new PasskeyError("cbor_trailing_bytes");
  return value;
}

// ---------------------------------------------------------------------------
// Authenticator data and the attestation object.

export interface AuthData {
  /** SHA-256 of the RP id the authenticator signed for, lowercase hex. */
  rpIdHashHex: string;
  userPresent: boolean;
  userVerified: boolean;
  /** BE: the credential may be backed up (synced); fixed for the life of the credential. */
  backupEligible: boolean;
  /** BS: the credential is backed up now. */
  backupState: boolean;
  signCount: number;
  /** Present when the AT flag is set (registration). */
  credentialId?: Uint8Array;
  coseKey?: unknown;
}

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_BE = 0x08;
const FLAG_BS = 0x10;
const FLAG_AT = 0x40;
const FLAG_ED = 0x80;
/** Longest credential id WebAuthn allows. */
export const MAX_CREDENTIAL_ID_BYTES = 1_023;

export function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

/**
 * Parse authenticator data. `attested` says whether it must carry the
 * attested credential data (registration) or must not (an assertion).
 */
export function parseAuthData(bytes: Uint8Array, attested: boolean): AuthData {
  if (bytes.length < 37) throw new PasskeyError("authdata_short");
  const flags = bytes[32] as number;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  const out: AuthData = {
    rpIdHashHex: toHex(bytes.subarray(0, 32)),
    userPresent: (flags & FLAG_UP) !== 0,
    userVerified: (flags & FLAG_UV) !== 0,
    backupEligible: (flags & FLAG_BE) !== 0,
    backupState: (flags & FLAG_BS) !== 0,
    signCount: view.getUint32(33),
  };
  // A credential that is backed up must be one that can be (WebAuthn level 3).
  if (out.backupState && !out.backupEligible) throw new PasskeyError("authdata_bad_backup_flags");
  if (((flags & FLAG_AT) !== 0) !== attested) throw new PasskeyError(attested ? "authdata_no_credential" : "authdata_unexpected_credential");
  let pos = 37;
  if (attested) {
    if (bytes.length < pos + 18) throw new PasskeyError("authdata_short");
    const idLength = view.getUint16(pos + 16);
    pos += 18;
    if (idLength === 0 || idLength > MAX_CREDENTIAL_ID_BYTES || pos + idLength > bytes.length) {
      throw new PasskeyError("authdata_bad_credential_id");
    }
    out.credentialId = bytes.slice(pos, pos + idLength);
    pos += idLength;
    const key = cborDecode(bytes, pos);
    out.coseKey = key.value;
    pos = key.end;
  }
  if ((flags & FLAG_ED) !== 0) pos = cborDecode(bytes, pos).end;
  if (pos !== bytes.length) throw new PasskeyError("authdata_trailing_bytes");
  return out;
}

/** The `authData` bytes of an attestation object, of any format: the statement is decoded (so it must be well formed) and ignored. */
export function attestationAuthData(bytes: Uint8Array): Uint8Array {
  const top = cborDecodeAll(bytes);
  if (!(top instanceof Map)) throw new PasskeyError("attestation_malformed");
  const fmt = top.get("fmt");
  const authData = top.get("authData");
  if (typeof fmt !== "string" || !(top.get("attStmt") instanceof Map) || !(authData instanceof Uint8Array)) {
    throw new PasskeyError("attestation_malformed");
  }
  return authData;
}

// ---------------------------------------------------------------------------
// The credential's public key.

/** A credential's public key as stored: the algorithm and the JWK (public fields only). */
export interface PasskeyPublicKey {
  alg: PasskeyAlg;
  jwk: { kty: string } & Record<string, string>;
}

function b64u(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function bitLength(bytes: Uint8Array): number {
  let i = 0;
  while (i < bytes.length && bytes[i] === 0) i++;
  if (i === bytes.length) return 0;
  return (bytes.length - i) * 8 - Math.clz32(bytes[i] as number) + 24;
}

/**
 * Read a COSE_Key into a JWK. `kty` 2 (EC2) with curve 1 (P-256), and `kty` 3
 * (RSA) with a modulus of at least 2048 bits, are the only keys accepted; when
 * the key names an `alg` it must be the one its type allows.
 */
export function coseToPublicKey(cose: unknown): PasskeyPublicKey {
  if (!(cose instanceof Map)) throw new PasskeyError("public_key_malformed");
  const kty = cose.get(1);
  const alg = cose.get(3);
  if (kty === 2) {
    if (alg !== undefined && alg !== COSE_ES256) throw new PasskeyError("public_key_algorithm_not_allowed");
    const x = cose.get(-2);
    const y = cose.get(-3);
    if (cose.get(-1) !== 1 || !(x instanceof Uint8Array) || !(y instanceof Uint8Array) || x.length !== 32 || y.length !== 32) {
      throw new PasskeyError("public_key_malformed");
    }
    return { alg: "ES256", jwk: { kty: "EC", crv: "P-256", x: b64u(x), y: b64u(y) } };
  }
  if (kty === 3) {
    if (alg !== undefined && alg !== COSE_RS256) throw new PasskeyError("public_key_algorithm_not_allowed");
    const n = cose.get(-1);
    const e = cose.get(-2);
    if (!(n instanceof Uint8Array) || !(e instanceof Uint8Array) || e.length === 0 || e.length > 8) {
      throw new PasskeyError("public_key_malformed");
    }
    if (bitLength(n) < MIN_RSA_BITS) throw new PasskeyError("public_key_too_weak");
    return { alg: "RS256", jwk: { kty: "RSA", n: b64u(n), e: b64u(e) } };
  }
  throw new PasskeyError("public_key_algorithm_not_allowed");
}

/** Import a stored key for verifying; a key Web Crypto rejects (a point off the curve) is refused. */
export async function importPasskeyKey(pk: PasskeyPublicKey): Promise<Awaited<ReturnType<typeof crypto.subtle.importKey>>> {
  try {
    if (pk.alg === "RS256") {
      return await crypto.subtle.importKey("jwk", { ...pk.jwk, alg: "RS256", ext: true }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    }
    return await crypto.subtle.importKey("jwk", { ...pk.jwk, ext: true }, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  } catch {
    throw new PasskeyError("public_key_malformed");
  }
}

// ---------------------------------------------------------------------------
// Client data and the signature.

/**
 * Check `clientDataJSON`: the ceremony `type`, the exact `origin`, no
 * cross-origin framing. Returns the challenge it carries (base64url text, for
 * the caller to look up by its hash).
 */
export function parseClientData(bytes: Uint8Array, expect: { type: "webauthn.create" | "webauthn.get"; origin: string }): { challenge: string } {
  let data: unknown;
  try {
    data = JSON.parse(UTF8.decode(bytes));
  } catch {
    throw new PasskeyError("client_data_malformed");
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) throw new PasskeyError("client_data_malformed");
  const d = data as Record<string, unknown>;
  if (d.type !== expect.type) throw new PasskeyError("client_data_wrong_type");
  if (typeof d.challenge !== "string" || d.challenge.length === 0 || d.challenge.length > 128 || b64uDecode(d.challenge) === undefined) {
    throw new PasskeyError("client_data_malformed");
  }
  if (d.origin !== expect.origin) throw new PasskeyError("client_data_wrong_origin");
  if (d.crossOrigin === true || d.topOrigin !== undefined) throw new PasskeyError("client_data_cross_origin");
  return { challenge: d.challenge };
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/** An ASN.1 DER ECDSA signature as the raw 64 bytes (r then s) Web Crypto takes; undefined when malformed. */
export function derToRaw(der: Uint8Array): Uint8Array | undefined {
  let pos = 0;
  const readLength = (): number | undefined => {
    const b = der[pos++];
    if (b === undefined) return undefined;
    if (b < 0x80) return b;
    if (b !== 0x81) return undefined;
    const n = der[pos++];
    return n !== undefined && n >= 0x80 ? n : undefined;
  };
  if (der[pos++] !== 0x30) return undefined;
  const total = readLength();
  if (total === undefined || pos + total !== der.length) return undefined;
  const out = new Uint8Array(64);
  for (let half = 0; half < 2; half++) {
    if (der[pos++] !== 0x02) return undefined;
    const len = readLength();
    if (len === undefined || len === 0 || pos + len > der.length) return undefined;
    let int = der.subarray(pos, pos + len);
    pos += len;
    if ((int[0] as number) & 0x80) return undefined;
    while (int.length > 1 && int[0] === 0) int = int.subarray(1);
    if (int.length > 32) return undefined;
    out.set(int, half * 32 + (32 - int.length));
  }
  return pos === der.length ? out : undefined;
}

/**
 * Whether `signature` is the credential's signature over
 * `authenticatorData || SHA-256(clientDataJSON)`. Never throws for a bad
 * signature; a malformed one is simply false.
 */
export async function assertionSignatureHolds(
  pk: PasskeyPublicKey,
  authenticatorData: Uint8Array,
  clientDataJSON: Uint8Array,
  signature: Uint8Array,
): Promise<boolean> {
  const key = await importPasskeyKey(pk);
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", clientDataJSON as Uint8Array<ArrayBuffer>));
  const data = concat(authenticatorData, hash) as Uint8Array<ArrayBuffer>;
  try {
    if (pk.alg === "RS256") {
      return await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signature as Uint8Array<ArrayBuffer>, data);
    }
    const raw = derToRaw(signature);
    if (raw === undefined) return false;
    return await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, raw as Uint8Array<ArrayBuffer>, data);
  } catch {
    return false;
  }
}

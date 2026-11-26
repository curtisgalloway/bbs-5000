// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0

/**
 * A software WebAuthn authenticator for tests (issue #54): ES256 and RS256
 * credentials from Web Crypto, with the registration answer (a CBOR attestation
 * object and `clientDataJSON`) and the sign-in answer (authenticator data, a
 * signature and `clientDataJSON`) built the way a browser hands them to the
 * page, base64url text throughout. Every field a check looks at can be tampered
 * with through the options, so a test can show each check refuses.
 */

import { createHash, type webcrypto } from "node:crypto";

type CryptoKey = webcrypto.CryptoKey;
type JsonWebKey = webcrypto.JsonWebKey;

export type Alg = "ES256" | "RS256";

export const b64u = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64url");
export const fromB64u = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, "base64url"));
const sha256 = (data: Uint8Array | string): Uint8Array => new Uint8Array(createHash("sha256").update(data).digest());

// A minimal CBOR encoder: what an attestation object and a COSE key need.
type Cbor = number | string | Uint8Array | Cbor[] | [Cbor, Cbor][] | { map: [Cbor, Cbor][] };

function head(major: number, n: number): Uint8Array {
  if (n < 24) return Uint8Array.of((major << 5) | n);
  if (n < 256) return Uint8Array.of((major << 5) | 24, n);
  if (n < 65536) return Uint8Array.of((major << 5) | 25, n >> 8, n & 255);
  return Uint8Array.of((major << 5) | 26, (n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255);
}

export function cbor(v: Cbor): Uint8Array {
  const parts: Uint8Array[] = [];
  const walk = (x: Cbor): void => {
    if (typeof x === "number") parts.push(x >= 0 ? head(0, x) : head(1, -1 - x));
    else if (typeof x === "string") {
      const b = new TextEncoder().encode(x);
      parts.push(head(3, b.length), b);
    } else if (x instanceof Uint8Array) parts.push(head(2, x.length), x);
    else if (Array.isArray(x)) {
      parts.push(head(4, x.length));
      for (const i of x) walk(i as Cbor);
    } else {
      parts.push(head(5, x.map.length));
      for (const [k, val] of x.map) {
        walk(k);
        walk(val);
      }
    }
  };
  walk(v);
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let pos = 0;
  for (const p of parts) {
    out.set(p, pos);
    pos += p.length;
  }
  return out;
}

const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let pos = 0;
  for (const p of parts) {
    out.set(p, pos);
    pos += p.length;
  }
  return out;
};

/** Raw r || s (what Web Crypto signs) as the ASN.1 DER an authenticator sends. */
export function rawToDer(raw: Uint8Array): Uint8Array {
  const int = (b: Uint8Array): Uint8Array => {
    let i = 0;
    while (i < b.length - 1 && b[i] === 0) i++;
    let v = b.subarray(i);
    if ((v[0] as number) & 0x80) v = concat(Uint8Array.of(0), v);
    return concat(Uint8Array.of(0x02, v.length), v);
  };
  const body = concat(int(raw.subarray(0, 32)), int(raw.subarray(32)));
  return concat(Uint8Array.of(0x30, body.length), body);
}

export interface CeremonyOptions {
  challenge: string;
  rpId: string;
  origin: string;
  /** Override `clientDataJSON.type`. */
  type?: string;
  /** Override the origin written in `clientDataJSON` (the page's claim, against the origin the board expects). */
  clientOrigin?: string;
  /** The RP id the authenticator hashes into the authenticator data (default `rpId`). */
  signedRpId?: string;
  userPresent?: boolean;
  userVerified?: boolean;
  /** Set the sign count to this (default: the authenticator's own counter, advanced by one). */
  signCount?: number;
  /** Flip a bit of the signature. */
  corruptSignature?: boolean;
  /** `userHandle` of an assertion. */
  userHandle?: string;
  /** Attestation format to name in the object; the statement is empty or junk, never checked. */
  fmt?: string;
}

export interface SoftwareOptions {
  /** RSA modulus length (default 2048). */
  modulusLength?: number;
  backupEligible?: boolean;
  backupState?: boolean;
  credentialId?: Uint8Array;
}

export class SoftwareAuthenticator {
  readonly alg: Alg;
  readonly credentialId: Uint8Array;
  backupEligible: boolean;
  backupState: boolean;
  signCount = 0;
  readonly #priv: CryptoKey;
  readonly #jwk: JsonWebKey;

  private constructor(alg: Alg, priv: CryptoKey, jwk: JsonWebKey, o: SoftwareOptions) {
    this.alg = alg;
    this.#priv = priv;
    this.#jwk = jwk;
    this.credentialId = o.credentialId ?? crypto.getRandomValues(new Uint8Array(32));
    this.backupEligible = o.backupEligible ?? false;
    this.backupState = o.backupState ?? false;
  }

  static async create(alg: Alg, o: SoftwareOptions = {}): Promise<SoftwareAuthenticator> {
    const pair =
      alg === "ES256"
        ? await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])
        : await crypto.subtle.generateKey(
            { name: "RSASSA-PKCS1-v1_5", modulusLength: o.modulusLength ?? 2048, publicExponent: Uint8Array.of(1, 0, 1), hash: "SHA-256" },
            true,
            ["sign", "verify"],
          );
    return new SoftwareAuthenticator(alg, pair.privateKey, await crypto.subtle.exportKey("jwk", pair.publicKey), o);
  }

  /** The credential's public key as a COSE_Key. */
  cose(): Uint8Array {
    const j = this.#jwk;
    if (this.alg === "ES256") {
      return cbor({ map: [[1, 2], [3, -7], [-1, 1], [-2, fromB64u(j.x as string)], [-3, fromB64u(j.y as string)]] });
    }
    return cbor({ map: [[1, 3], [3, -257], [-1, fromB64u(j.n as string)], [-2, fromB64u(j.e as string)]] });
  }

  #flags(o: CeremonyOptions, attested: boolean): number {
    return (
      ((o.userPresent ?? true) ? 0x01 : 0) |
      ((o.userVerified ?? true) ? 0x04 : 0) |
      (this.backupEligible ? 0x08 : 0) |
      (this.backupState ? 0x10 : 0) |
      (attested ? 0x40 : 0)
    );
  }

  #authData(o: CeremonyOptions, attested: boolean): Uint8Array {
    const count = o.signCount ?? ++this.signCount;
    if (o.signCount !== undefined) this.signCount = o.signCount;
    const fixed = concat(sha256(o.signedRpId ?? o.rpId), Uint8Array.of(this.#flags(o, attested)), Uint8Array.of(count >>> 24, (count >>> 16) & 255, (count >>> 8) & 255, count & 255));
    if (!attested) return fixed;
    const id = this.credentialId;
    return concat(fixed, new Uint8Array(16), Uint8Array.of(id.length >> 8, id.length & 255), id, this.cose());
  }

  #clientData(type: string, o: CeremonyOptions): Uint8Array {
    return new TextEncoder().encode(
      JSON.stringify({ type: o.type ?? type, challenge: o.challenge, origin: o.clientOrigin ?? o.origin, crossOrigin: false }),
    );
  }

  /** What `navigator.credentials.create()` yields, as JSON-safe text. */
  register(o: CeremonyOptions): { id: string; rawId: string; type: "public-key"; response: { clientDataJSON: string; attestationObject: string; transports: string[] } } {
    const authData = this.#authData(o, true);
    const fmt = o.fmt ?? "none";
    const attStmt = fmt === "none" ? { map: [] } : { map: [["alg", -7], ["sig", new Uint8Array(70)]] as [Cbor, Cbor][] };
    const attestationObject = cbor({ map: [["fmt", fmt], ["attStmt", attStmt], ["authData", authData]] });
    const id = b64u(this.credentialId);
    return {
      id,
      rawId: id,
      type: "public-key",
      response: { clientDataJSON: b64u(this.#clientData("webauthn.create", o)), attestationObject: b64u(attestationObject), transports: ["internal", "hybrid"] },
    };
  }

  /** What `navigator.credentials.get()` yields, as JSON-safe text. */
  async assert(o: CeremonyOptions): Promise<{
    id: string;
    rawId: string;
    type: "public-key";
    response: { clientDataJSON: string; authenticatorData: string; signature: string; userHandle?: string };
  }> {
    const authData = this.#authData(o, false);
    const clientData = this.#clientData("webauthn.get", o);
    const data = concat(authData, sha256(clientData));
    let signature: Uint8Array;
    if (this.alg === "ES256") {
      const raw = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, this.#priv, data as Uint8Array<ArrayBuffer>));
      signature = rawToDer(raw);
    } else {
      signature = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", this.#priv, data as Uint8Array<ArrayBuffer>));
    }
    if (o.corruptSignature) {
      signature = signature.slice();
      signature[signature.length - 1] = (signature[signature.length - 1] as number) ^ 1;
    }
    const id = b64u(this.credentialId);
    return {
      id,
      rawId: id,
      type: "public-key",
      response: {
        clientDataJSON: b64u(clientData),
        authenticatorData: b64u(authData),
        signature: b64u(signature),
        ...(o.userHandle !== undefined ? { userHandle: o.userHandle } : {}),
      },
    };
  }
}

// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0

/**
 * `GcsSink`: audit batches to a Google Cloud Storage bucket (design §13,
 * plan M6a). Uses only Web globals (`fetch`, `crypto.subtle`, `btoa`,
 * `atob`), so it runs in the Worker and in Node unit tests alike.
 *
 * - Auth: a service-account JWT (RS256: RSASSA-PKCS1-v1_5 with SHA-256,
 *   signed with Web Crypto from the key's PKCS#8 PEM) exchanged at the token
 *   endpoint for an access token (grant type jwt-bearer), cached until five
 *   minutes before it expires.
 * - Writes: one request kind only, the JSON API media upload
 *   (`POST /upload/storage/v1/b/<bucket>/o?uploadType=media&name=...`) with
 *   `ifGenerationMatch=0`, so it succeeds only when no object of that name
 *   exists. There is no read, overwrite or delete code path.
 * - HTTP 412 (Precondition Failed, reason `conditionNotMet`) means the object
 *   already exists. It is reported as `"exists"`, which the export treats as
 *   confirmed: the name carries the board's random id (so no other board, and
 *   no earlier life of this board's storage, uses it), the board fixes a
 *   batch's seq range before the first attempt (`audit_export_begin`) and
 *   retries the same range, and the content (canonical JSON of rows that
 *   never change) is the same; so an earlier attempt of this batch, whose
 *   response was lost, wrote it.
 * - Every request is abandoned after GCS_TIMEOUT_MS (30 s); the write then
 *   counts as failed and is retried later. The
 *   object is never compared or replaced (the account has no read
 *   permission); the chain verifier over the archive catches a mismatch.
 *
 * Docs read 2026-11-20 (pre-publication notes on I0 and M6a): objects insert, status
 * codes, service-account OAuth, Workers Web Crypto.
 */

import type { AuditSink } from "./audit-export.ts";

export const GCS_STORAGE_URL = "https://storage.googleapis.com";
export const GCS_TOKEN_URL = "https://oauth2.googleapis.com/token";
/** Writing objects needs read_write; the account's IAM role limits it to create in one bucket. */
export const GCS_SCOPE = "https://www.googleapis.com/auth/devstorage.read_write";

/** Web Crypto's key type, named so both the Node and workerd type sets accept it. */
type SigningKey = Awaited<ReturnType<typeof crypto.subtle.importKey>>;

/** Refresh the access token this long before it expires. */
const TOKEN_MARGIN_MS = 5 * 60_000;
/** Each request (token or upload) is abandoned after this long; the write counts as failed. */
export const GCS_TIMEOUT_MS = 30_000;

/** JWT lifetime (Google allows at most one hour). */
const JWT_LIFETIME_S = 3_600;

export interface GcsSinkOptions {
  bucket: string;
  /** The service account's `client_email` (the JWT `iss`). */
  clientEmail: string;
  /** The service account's `private_key`: PKCS#8 PEM ("BEGIN PRIVATE KEY"). */
  privateKeyPem: string;
  /** Storage base URL; only the e2e fake endpoint changes it (localhost or 127.0.0.1 only). */
  storageUrl?: string | undefined;
  /** Token endpoint; also the JWT `aud`. Only the e2e fake endpoint changes it (same rule). */
  tokenUrl?: string | undefined;
  fetch?: typeof fetch;
  now?: () => number;
  /** Tests only: a shorter request timeout than GCS_TIMEOUT_MS. */
  timeoutMs?: number;
}

const BUCKET_RE = /^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$/;

/**
 * An endpoint is Google's own, or an override to this machine (the e2e
 * fake: http or https on localhost or 127.0.0.1). Any other override is
 * refused (review m5), so a setting cannot send the credential or the audit
 * rows anywhere else.
 */
function checkEndpoint(url: string, fixed: string, what: string): string {
  if (url === fixed) return fixed;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error(`${what} is not a URL`);
  }
  const local = u.hostname === "127.0.0.1" || u.hostname === "localhost";
  if (!local || (u.protocol !== "http:" && u.protocol !== "https:") || u.username || u.password) {
    throw new Error(`${what} override must be http(s)://localhost or http(s)://127.0.0.1 (test only)`);
  }
  return url.replace(/\/+$/, "");
}

export class GcsSink implements AuditSink {
  readonly #bucket: string;
  readonly #clientEmail: string;
  readonly #pem: string;
  readonly #storageUrl: string;
  readonly #tokenUrl: string;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  readonly #timeoutMs: number;
  #key: Promise<SigningKey> | undefined;
  #token: { value: string; expiresAt: number } | undefined;

  constructor(o: GcsSinkOptions) {
    if (!BUCKET_RE.test(o.bucket)) throw new Error("bucket name is not valid");
    if (!o.clientEmail) throw new Error("client_email is missing");
    this.#bucket = o.bucket;
    this.#clientEmail = o.clientEmail;
    this.#pem = o.privateKeyPem;
    this.#storageUrl = checkEndpoint(o.storageUrl ?? GCS_STORAGE_URL, GCS_STORAGE_URL, "storage URL");
    this.#tokenUrl = checkEndpoint(o.tokenUrl ?? GCS_TOKEN_URL, GCS_TOKEN_URL, "token URL");
    this.#timeoutMs = o.timeoutMs ?? GCS_TIMEOUT_MS;
    // Wrapped: a bare `fetch` reference called unbound fails in workerd.
    this.#fetch = o.fetch ?? ((input, init) => fetch(input, init));
    this.#now = o.now ?? Date.now;
  }

  /** Create `path` with `body`; never replaces an existing object. */
  async create(path: string, body: string): Promise<"created" | "exists"> {
    const token = await this.#accessToken();
    const url =
      `${this.#storageUrl}/upload/storage/v1/b/${encodeURIComponent(this.#bucket)}/o` +
      `?uploadType=media&ifGenerationMatch=0&name=${encodeURIComponent(path)}`;
    const res = await this.#send("upload", url, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/x-ndjson" },
      body,
    });
    if (res.ok) {
      await res.body?.cancel();
      return "created";
    }
    const reason = await errorReason(res);
    if (res.status === 412) return "exists";
    if (res.status === 401) this.#token = undefined;
    throw new Error(`Cloud Storage upload failed: HTTP ${res.status}${reason}`);
  }

  async #accessToken(): Promise<string> {
    const now = this.#now();
    if (this.#token && this.#token.expiresAt - TOKEN_MARGIN_MS > now) return this.#token.value;
    const assertion = await this.#signJwt(Math.floor(now / 1000));
    const res = await this.#send("token request", this.#tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }).toString(),
    });
    if (!res.ok) {
      throw new Error(`token request failed: HTTP ${res.status}${await errorReason(res)}`);
    }
    const json = (await res.json().catch(() => null)) as { access_token?: unknown; expires_in?: unknown } | null;
    if (!json || typeof json.access_token !== "string" || json.access_token === "") {
      throw new Error("token response has no access_token");
    }
    const seconds = typeof json.expires_in === "number" && json.expires_in > 0 ? json.expires_in : 3_600;
    this.#token = { value: json.access_token, expiresAt: now + seconds * 1000 };
    return json.access_token;
  }

  /** One request with the timeout; a timeout or network failure rejects with a short message. */
  async #send(what: string, url: string, init: RequestInit): Promise<Response> {
    try {
      return await this.#fetch(url, { ...init, signal: AbortSignal.timeout(this.#timeoutMs) });
    } catch (err) {
      const name = (err as { name?: unknown } | null)?.name;
      if (name === "TimeoutError" || name === "AbortError") {
        throw new Error(`Cloud Storage ${what} timed out after ${this.#timeoutMs} ms`);
      }
      throw new Error(`Cloud Storage ${what} failed: ${String((err as Error)?.message ?? err).slice(0, 120)}`);
    }
  }

  async #signJwt(iat: number): Promise<string> {
    this.#key ??= importPkcs8(this.#pem);
    // A failed import is not cached, so a fixed secret works without a restart.
    const key = await this.#key.catch((err: unknown) => {
      this.#key = undefined;
      throw err;
    });
    const enc = new TextEncoder();
    const header = b64url(enc.encode(JSON.stringify({ alg: "RS256", typ: "JWT" })));
    const claims = b64url(
      enc.encode(
        JSON.stringify({
          iss: this.#clientEmail,
          scope: GCS_SCOPE,
          aud: this.#tokenUrl,
          iat,
          exp: iat + JWT_LIFETIME_S,
        }),
      ),
    );
    const input = `${header}.${claims}`;
    const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, enc.encode(input));
    return `${input}.${b64url(new Uint8Array(sig))}`;
  }
}

/** Import a PKCS#8 PEM RSA key for RS256 signing (Web Crypto `importKey("pkcs8")`). */
export async function importPkcs8(pem: string): Promise<SigningKey> {
  if (/BEGIN RSA PRIVATE KEY/.test(pem)) {
    throw new Error("private key is PKCS#1; a service-account key is PKCS#8 (BEGIN PRIVATE KEY)");
  }
  const m = /-----BEGIN PRIVATE KEY-----([\s\S]+?)-----END PRIVATE KEY-----/.exec(pem);
  if (!m?.[1]) throw new Error("private key is not a PKCS#8 PEM");
  const bin = atob(m[1].replace(/\s+/g, ""));
  const der = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) der[i] = bin.charCodeAt(i);
  return crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, [
    "sign",
  ]);
}

/**
 * Build a sink from a service-account JSON key (the file Google issues). Uses
 * `client_email` and `private_key`; the key's `token_uri` is not used (the
 * token endpoint is fixed, overridable only for the e2e fake).
 */
export function gcsSinkFromServiceAccount(
  keyJson: string,
  bucket: string,
  extra: Omit<GcsSinkOptions, "bucket" | "clientEmail" | "privateKeyPem"> = {},
): GcsSink {
  let key: unknown;
  try {
    key = JSON.parse(keyJson);
  } catch {
    throw new Error("service-account key is not JSON");
  }
  const k = key as { type?: unknown; client_email?: unknown; private_key?: unknown };
  if (k.type !== "service_account") throw new Error("key type is not service_account");
  if (typeof k.client_email !== "string" || typeof k.private_key !== "string") {
    throw new Error("key has no client_email or private_key");
  }
  return new GcsSink({ ...extra, bucket, clientEmail: k.client_email, privateKeyPem: k.private_key });
}

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A short, safe reason from a Google error body (`error.errors[0].reason` or `error.status`). */
async function errorReason(res: Response): Promise<string> {
  const json = (await res.json().catch(() => null)) as {
    error?: { status?: unknown; errors?: { reason?: unknown }[] } | string;
  } | null;
  let reason: unknown;
  if (json && typeof json.error === "object") reason = json.error.errors?.[0]?.reason ?? json.error.status;
  else if (json) reason = json.error;
  if (typeof reason !== "string") return "";
  const clean = reason.replace(/[^A-Za-z0-9._ -]/g, "").slice(0, 80);
  return clean ? ` (${clean})` : "";
}

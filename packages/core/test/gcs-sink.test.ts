// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0

/**
 * M6a A6.3: `GcsSink` against mocked HTTP only (spec §5 M6: no bucket, no
 * Google Cloud project). The service-account key is generated per run and
 * never written to disk.
 */

import { createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { exportAudit } from "../src/audit-export.ts";
import { makeBoard } from "./helpers.ts";
import {
  GCS_SCOPE,
  GCS_TIMEOUT_MS,
  GCS_TOKEN_URL,
  GcsSink,
  gcsSinkFromServiceAccount,
  importPkcs8,
} from "../src/gcs-sink.ts";

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const EMAIL = "audit-writer@example-project.iam.gserviceaccount.com";

interface Call {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body: string;
}

/** A mocked `fetch`: records every request, answers from `respond`. */
function mockFetch(respond: (c: Call) => { status: number; json?: unknown }) {
  const calls: Call[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    const call = {
      url: new URL(String(input)),
      method: init?.method ?? "GET",
      headers,
      body: String(init?.body ?? ""),
    };
    calls.push(call);
    const r = respond(call);
    return new Response(r.json === undefined ? null : JSON.stringify(r.json), {
      status: r.status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { calls, fetchFn };
}

/** Token endpoint OK; uploads answer `uploadStatus`. */
function google(uploadStatus: (n: number) => number = () => 200) {
  let uploads = 0;
  let tokens = 0;
  return mockFetch((c) => {
    if (c.url.href === GCS_TOKEN_URL) {
      tokens += 1;
      return { status: 200, json: { access_token: `at-${tokens}`, expires_in: 3600, token_type: "Bearer" } };
    }
    uploads += 1;
    const status = uploadStatus(uploads);
    if (status === 412) return { status, json: { error: { code: 412, errors: [{ reason: "conditionNotMet" }] } } };
    if (status >= 400) return { status, json: { error: { code: status, errors: [{ reason: "backendError" }] } } };
    return { status, json: { kind: "storage#object", name: c.url.searchParams.get("name"), generation: "1" } };
  });
}

function sink(fetchFn: typeof fetch, now = () => Date.UTC(2026, 10, 20, 12)) {
  return new GcsSink({ bucket: "bbs-audit", clientEmail: EMAIL, privateKeyPem: privateKey, fetch: fetchFn, now });
}

const PATH = "audit/dt=2026-11-20/1-12.ndjson";

describe("GcsSink (mocked HTTP)", () => {
  it("signs an RS256 service-account JWT and exchanges it at the token endpoint", async () => {
    const g = google();
    await sink(g.fetchFn).create(PATH, "{}\n");
    const tok = g.calls[0]!;
    expect(tok.method).toBe("POST");
    expect(tok.url.href).toBe("https://oauth2.googleapis.com/token");
    expect(tok.headers["content-type"]).toBe("application/x-www-form-urlencoded");
    const form = new URLSearchParams(tok.body);
    expect(form.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
    const [h, c, s] = form.get("assertion")!.split(".");
    const dec = (x: string) => JSON.parse(Buffer.from(x, "base64url").toString("utf8"));
    expect(dec(h!)).toEqual({ alg: "RS256", typ: "JWT" });
    const claims = dec(c!);
    expect(claims).toEqual({
      iss: EMAIL,
      scope: GCS_SCOPE,
      aud: "https://oauth2.googleapis.com/token",
      iat: Date.UTC(2026, 10, 20, 12) / 1000,
      exp: Date.UTC(2026, 10, 20, 12) / 1000 + 3600,
    });
    const ok = verify("RSA-SHA256", Buffer.from(`${h}.${c}`), createPublicKey(publicKey), Buffer.from(s!, "base64url"));
    expect(ok).toBe(true);
  });

  it("every write is a media upload with the does-not-exist precondition (ifGenerationMatch=0)", async () => {
    const g = google();
    const s = sink(g.fetchFn);
    expect(await s.create(PATH, "a\n")).toBe("created");
    expect(await s.create("audit/dt=2026-11-20/13-20.ndjson", "b\n")).toBe("created");
    const uploads = g.calls.filter((c) => c.url.host === "storage.googleapis.com");
    expect(uploads).toHaveLength(2);
    for (const u of uploads) {
      expect(u.method).toBe("POST");
      expect(u.url.pathname).toBe("/upload/storage/v1/b/bbs-audit/o");
      expect(u.url.searchParams.get("uploadType")).toBe("media");
      expect(u.url.searchParams.get("ifGenerationMatch")).toBe("0");
      expect(u.headers.authorization).toBe("Bearer at-1");
      expect(u.headers["content-type"]).toBe("application/x-ndjson");
    }
    expect(uploads.map((u) => u.url.searchParams.get("name"))).toEqual([PATH, "audit/dt=2026-11-20/13-20.ndjson"]);
    expect(uploads[0]!.body).toBe("a\n");
    // Every request the sink made was a POST: token or create. Nothing else.
    expect(g.calls.every((c) => c.method === "POST")).toBe(true);
  });

  it("412 Precondition Failed means the object exists: reported as exists, not retried or replaced", async () => {
    const g = google(() => 412);
    expect(await sink(g.fetchFn).create(PATH, "a\n")).toBe("exists");
    expect(g.calls.filter((c) => c.url.host === "storage.googleapis.com")).toHaveLength(1);
  });

  it("other failures reject without the token in the message", async () => {
    const g = google(() => 503);
    const err = await sink(g.fetchFn).create(PATH, "a\n").catch((e: Error) => e);
    expect(String(err)).toBe("Error: Cloud Storage upload failed: HTTP 503 (backendError)");
    expect(String(err)).not.toContain("at-1");
  });

  it("caches the access token until five minutes before expiry; a 401 drops it", async () => {
    let t = Date.UTC(2026, 10, 20, 12);
    const g = google((i) => (i === 3 ? 401 : 200));
    const s = sink(g.fetchFn, () => t);
    await s.create("audit/dt=2026-11-20/1-1.ndjson", "a\n");
    t += 54 * 60_000;
    await s.create("audit/dt=2026-11-20/2-2.ndjson", "a\n");
    const tokens = () => g.calls.filter((c) => c.url.href === GCS_TOKEN_URL).length;
    expect(tokens()).toBe(1);
    t += 2 * 60_000; // 56 minutes: inside the margin
    await expect(s.create("audit/dt=2026-11-20/3-3.ndjson", "a\n")).rejects.toThrow(/HTTP 401/);
    expect(tokens()).toBe(2);
    await s.create("audit/dt=2026-11-20/3-3.ndjson", "a\n");
    expect(tokens()).toBe(3);
  });

  it("a token response without a usable expires_in is treated as one hour (F review N15)", async () => {
    for (const expires of [undefined, 0, "3600"]) {
      let t = Date.UTC(2026, 10, 20, 12);
      let tokens = 0;
      const g = mockFetch((c) => {
        if (c.url.href === GCS_TOKEN_URL) {
          tokens += 1;
          return { status: 200, json: { access_token: `at-${tokens}`, ...(expires === undefined ? {} : { expires_in: expires }) } };
        }
        return { status: 200, json: { kind: "storage#object" } };
      });
      const s = sink(g.fetchFn, () => t);
      await s.create("audit/dt=2026-11-20/1-1.ndjson", "a\n");
      t += 54 * 60_000; // inside the hour, outside the five-minute margin: cached
      await s.create("audit/dt=2026-11-20/2-2.ndjson", "a\n");
      expect(tokens, String(expires)).toBe(1);
      t += 2 * 60_000; // 56 minutes: refreshed
      await s.create("audit/dt=2026-11-20/3-3.ndjson", "a\n");
      expect(tokens, String(expires)).toBe(2);
    }
  });

  it("times out a hung request after GCS_TIMEOUT_MS (30 s); a timeout is a failed write (review m4)", async () => {
    expect(GCS_TIMEOUT_MS).toBe(30_000);
    const signals: AbortSignal[] = [];
    let tokenAnswers = false;
    const hang = (signal: AbortSignal) =>
      new Promise<Response>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
      const signal = init?.signal as AbortSignal;
      signals.push(signal);
      if (String(input) === GCS_TOKEN_URL && tokenAnswers) {
        return new Response(JSON.stringify({ access_token: "at", expires_in: 3600 }), { status: 200 });
      }
      return hang(signal);
    }) as typeof fetch;
    const s = new GcsSink({ bucket: "bbs-audit", clientEmail: EMAIL, privateKeyPem: privateKey, fetch: fetchFn, timeoutMs: 50 });
    // The token request hangs.
    await expect(s.create(PATH, "a\n")).rejects.toThrow("Cloud Storage token request timed out after 50 ms");
    // The token answers; the upload hangs.
    tokenAnswers = true;
    await expect(s.create(PATH, "a\n")).rejects.toThrow("Cloud Storage upload timed out after 50 ms");
    expect(signals.every((x) => x instanceof AbortSignal)).toBe(true);
    expect(signals).toHaveLength(3);
  });

  it("an upload that times out is recorded as a failed write; the rows stay unexported", async () => {
    const f = makeBoard();
    f.addUser("alice");
    f.clock.advance(15 * 60_000);
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input) === GCS_TOKEN_URL) {
        return new Response(JSON.stringify({ access_token: "at", expires_in: 3600 }), { status: 200 });
      }
      const signal = init?.signal as AbortSignal;
      return new Promise<Response>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    }) as typeof fetch;
    const s = new GcsSink({ bucket: "bbs-audit", clientEmail: EMAIL, privateKeyPem: privateKey, fetch: fetchFn, timeoutMs: 50, now: f.clock.now });
    const run = await exportAudit(f.board, s);
    expect(run.failed?.error).toBe("Cloud Storage upload timed out after 50 ms");
    expect(f.sql.one("SELECT COUNT(*) AS n FROM audit WHERE exported = 1")).toEqual({ n: 0 });
    const row = f.sql.one<{ detail: string }>("SELECT detail FROM audit WHERE action = 'audit_export_failed'");
    expect(JSON.parse(row!.detail)).toMatchObject({ error: "Cloud Storage upload timed out after 50 ms", failures: 1 });
  });

  it("a failed token request rejects", async () => {
    const m = mockFetch(() => ({ status: 400, json: { error: "invalid_grant" } }));
    await expect(sink(m.fetchFn).create(PATH, "a\n")).rejects.toThrow("token request failed: HTTP 400 (invalid_grant)");
    expect(m.calls).toHaveLength(1);
  });

  it("accepts endpoint overrides only on localhost or 127.0.0.1 (review m5); refuses PKCS#1 keys and bad bucket names", async () => {
    const base = { bucket: "bbs-audit", clientEmail: EMAIL, privateKeyPem: privateKey };
    for (const url of [
      "http://storage.example.com",
      "https://storage.example.com",
      "https://storage.googleapis.com.example.com",
      "http://192.0.2.1",
      "ftp://127.0.0.1",
      "http://user:pw@127.0.0.1",
      "not a url",
    ]) {
      expect(() => new GcsSink({ ...base, storageUrl: url }), url).toThrow();
      expect(() => new GcsSink({ ...base, tokenUrl: url }), url).toThrow();
    }
    expect(() => new GcsSink({ ...base, tokenUrl: "https://example.com/token" })).toThrow(/localhost or http\(s\):\/\/127\.0\.0\.1/);
    for (const url of ["http://127.0.0.1:9999", "https://localhost:9999", "http://localhost"]) {
      expect(() => new GcsSink({ ...base, storageUrl: url, tokenUrl: `${url}/token` }), url).not.toThrow();
    }
    // Google's own endpoints, given explicitly, are the defaults.
    expect(() => new GcsSink({ ...base, storageUrl: "https://storage.googleapis.com", tokenUrl: GCS_TOKEN_URL })).not.toThrow();
    expect(() => new GcsSink({ ...base, bucket: "Bad Bucket" })).toThrow(/bucket/);
    const pkcs1 = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs1", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    }).privateKey;
    await expect(importPkcs8(pkcs1)).rejects.toThrow(/PKCS#1/);
    // Web Crypto importKey("pkcs8") with RSASSA-PKCS1-v1_5 / SHA-256 (B14, in Node here; in workerd by the e2e run).
    const key = await importPkcs8(privateKey);
    expect(key.algorithm).toMatchObject({ name: "RSASSA-PKCS1-v1_5", hash: { name: "SHA-256" } });
  });

  it("builds from a service-account JSON key", async () => {
    const g = google();
    const json = JSON.stringify({
      type: "service_account",
      project_id: "example-project",
      private_key: privateKey,
      client_email: EMAIL,
      token_uri: "https://elsewhere.example/token",
    });
    const s = gcsSinkFromServiceAccount(json, "bbs-audit", { fetch: g.fetchFn });
    await s.create(PATH, "a\n");
    // The key's token_uri is not used.
    expect(g.calls[0]!.url.href).toBe(GCS_TOKEN_URL);
    expect(() => gcsSinkFromServiceAccount("{", "b-b")).toThrow(/not JSON/);
    expect(() => gcsSinkFromServiceAccount(JSON.stringify({ type: "user" }), "bbs-audit")).toThrow(/service_account/);
  });

  it("has no read, overwrite or delete code path", () => {
    const src = readFileSync(join(import.meta.dirname, "..", "src", "gcs-sink.ts"), "utf8");
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    // The only HTTP method in the code is POST (token exchange and create).
    expect([...code.matchAll(/method:\s*"([A-Z]+)"/g)].map((m) => m[1])).toEqual(["POST", "POST"]);
    expect(code).not.toMatch(/"(GET|PUT|PATCH|DELETE|HEAD)"/);
    // Object resources (/o/<name>), rewrite, copy, compose and resumable uploads are never addressed.
    expect(code).not.toMatch(/\/o\/|rewriteTo|copyTo|compose|uploadType=resumable|uploadType=multipart/);
    // The one upload URL carries the precondition.
    expect(code.match(/uploadType=media/g)).toHaveLength(1);
    expect(code).toMatch(/uploadType=media&ifGenerationMatch=0&name=/);
    // One fetch call site (behind the timeout), used for the token and the upload.
    expect(code.match(/this\.#fetch\(/g)).toHaveLength(1);
    expect(code.match(/this\.#send\(/g)).toHaveLength(2);
    expect(code).toMatch(/signal: AbortSignal\.timeout\(this\.#timeoutMs\)/);
  });
});

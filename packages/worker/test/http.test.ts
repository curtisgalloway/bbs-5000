// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { VIAS_BY_KIND } from "@bbs-5000/core";
import {
  apiToolName,
  bearerToken,
  claimedClient,
  internalErrorLine,
  isApiHost,
  isApiPath,
  MAX_BODY_BYTES,
  readCapped,
  deriveVia,
  parseArgs,
  provisionalVia,
  redactSecrets,
  retryAfterSeconds,
  sessionFrom,
  signInSource,
  statusFor,
} from "../src/http.ts";
import { auditSinkFromEnv, leaseFromEnv, spansFromEnv } from "../src/env.ts";
import { generateKeyPairSync } from "node:crypto";

describe("bearerToken", () => {
  it.each([
    [null, undefined],
    ["", undefined],
    ["Basic abc", undefined],
    ["Bearer", undefined],
    ["Bearer abc", "abc"],
    ["bearer  abc ", "abc"],
    ["Bearer abc def", undefined],
  ])("%j -> %j", (header, token) => {
    expect(bearerToken(header)).toBe(token);
  });

  it("passes long tokens through whole (core refuses them; never truncated)", () => {
    expect(bearerToken(`Bearer ${"x".repeat(2000)}`)).toHaveLength(2000);
  });
});

describe("via (B7)", () => {
  it("is mcp on /mcp whatever the client says", () => {
    expect(deriveVia("/mcp", "agent", "cli")).toBe("mcp");
    expect(provisionalVia("/mcp")).toBe("mcp");
  });

  it("is api for every refused sign-in on /api; the claimed client is only detail", () => {
    expect(provisionalVia("/api")).toBe("api");
    expect(claimedClient(" cli ")).toBe("cli");
    expect(claimedClient("")).toBeUndefined();
    expect(claimedClient(null)).toBeUndefined();
    expect(claimedClient("x".repeat(100))).toHaveLength(32);
  });

  it("is api for an agent on /api, even through the CLI", () => {
    expect(deriveVia("/api", "agent", "cli")).toBe("api");
    expect(deriveVia("/api", "agent", null)).toBe("api");
    // An agent token that claims to be the web view is still an agent on /api (B22, A5.2).
    expect(deriveVia("/api", "agent", "web")).toBe("api");
  });

  it("is the named client for a person on /api, else api (which core refuses)", () => {
    expect(deriveVia("/api", "human", "cli")).toBe("cli");
    expect(deriveVia("/api", "human", " CLI ")).toBe("cli");
    // Issue #47: `web` comes only from a session cookie; a bearer token that
    // says it is the web view is an unnamed client, which core refuses.
    expect(deriveVia("/api", "human", "web")).toBe("api");
    expect(deriveVia("/api", "human", " Web ")).toBe("api");
    expect(deriveVia("/api", "human", "app-voice")).toBe("api");
    expect(deriveVia("/api", "human", null)).toBe("api");
    expect(VIAS_BY_KIND.human).not.toContain("api");
  });

  it("every derived via fits the kind, or is refused by core", () => {
    for (const kind of ["agent", "human"] as const) {
      for (const client of [null, "cli", "web", "x"]) {
        const v = deriveVia("/api", kind, client);
        if (kind === "agent") expect(VIAS_BY_KIND.agent).toContain(v);
      }
    }
  });
});

describe("request helpers", () => {
  it("parses tool names from /api paths", () => {
    expect(apiToolName("/api/bbs_post")).toBe("bbs_post");
    expect(apiToolName("/api/bbs_post/")).toBe("bbs_post");
    expect(apiToolName("/api/")).toBeUndefined();
    expect(apiToolName("/api/bbs-post")).toBeUndefined();
    expect(apiToolName("/api/a/b")).toBeUndefined();
  });

  it("parses bodies: empty is {}, invalid JSON is reported", () => {
    expect(parseArgs("")).toEqual({ ok: true, args: {} });
    expect(parseArgs('{"a":1}')).toEqual({ ok: true, args: { a: 1 } });
    expect(parseArgs("{nope")).toEqual({ ok: false });
  });

  it("reads a body under the byte cap and stops past it, whatever its length header says", async () => {
    const stream = (chunks: string[]) =>
      new ReadableStream<Uint8Array>({
        start(c) {
          for (const x of chunks) c.enqueue(new TextEncoder().encode(x));
          c.close();
        },
      });
    expect(await readCapped(null)).toEqual({ ok: true, text: "" });
    expect(await readCapped(stream(["ab", "cé"]), 5)).toEqual({ ok: true, text: "abcé" });
    expect(await readCapped(stream(["abc", "def"]), 5)).toEqual({ ok: false });
    // An endless stream is cut off, not read to the end.
    let pulls = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(c) {
        pulls++;
        c.enqueue(new Uint8Array(1024));
      },
    });
    expect(await readCapped(endless, 10 * 1024)).toEqual({ ok: false });
    expect(pulls).toBeLessThan(20);
    expect(MAX_BODY_BYTES).toBe(256 * 1024);
  });

  it("reads the session header", () => {
    expect(sessionFrom(null)).toBeUndefined();
    expect(sessionFrom("  ")).toBeUndefined();
    expect(sessionFrom(" s_1 ")).toBe("s_1");
    expect(sessionFrom("s".repeat(500))).toHaveLength(128);
  });

  it("maps tool errors to HTTP statuses", () => {
    const err = (code: string) => ({
      isError: true,
      content: [],
      structuredContent: { error: { code, message: "" } },
    });
    expect(statusFor({ isError: false, content: [], structuredContent: {} })).toBe(200);
    expect(statusFor(err("bad_request"))).toBe(400);
    expect(statusFor(err("unauthorized"))).toBe(401);
    expect(statusFor(err("forbidden"))).toBe(403);
    expect(statusFor(err("not_found"))).toBe(404);
    expect(statusFor(err("exists"))).toBe(409);
    expect(statusFor(err("internal"))).toBe(500);
    expect(statusFor(err("mystery"))).toBe(500);
  });
});

describe("error logging (security review of M1b)", () => {
  const token = "bbs_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_abcd";
  it("redacts board tokens, bearer values and long credential-shaped runs", () => {
    expect(redactSecrets(`bad token ${token} here`)).toBe("bad token bbs_[redacted] here");
    expect(redactSecrets("Authorization: Bearer human_s3cr3t")).toBe("Authorization: Bearer [redacted]");
    expect(redactSecrets("hash 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"))
      .toBe("hash [redacted]");
    expect(redactSecrets("no secrets in /api/bbs_task_unblock")).toBe("no secrets in /api/bbs_task_unblock");
    expect(redactSecrets("plain text")).toBe("plain text");
  });

  it("logs a reference and the error name, never the message", () => {
    const err = new TypeError(`could not parse ${token}`);
    const line = internalErrorLine("/api/x", "ref-1", err);
    expect(line).toBe("internal error on /api/x (ref ref-1): TypeError");
    expect(line).not.toContain("parse");
    const odd = new Error("x");
    odd.name = `Weird ${token}`;
    expect(internalErrorLine("/mcp", "r", odd)).toBe("internal error on /mcp (ref r): Weird bbs_[redacted]");
    expect(internalErrorLine("/mcp", "r", "a string")).toBe("internal error on /mcp (ref r): string");
  });
});

describe("leaseFromEnv", () => {
  it.each([
    [undefined, undefined],
    ["", undefined],
    ["abc", undefined],
    ["999", undefined],
    ["-5000", undefined],
    ["1.5", undefined],
    ["1000", 1000],
    [" 2500 ", 2500],
    ["1800000", 1_800_000],
    ["604800000", 604_800_000],
    ["604800001", undefined],
    ["99999999999999999999", undefined],
  ])("%j -> %j", (value, expected) => {
    expect(leaseFromEnv(value)).toBe(expected);
  });
});

describe("spansFromEnv (M4a)", () => {
  it("maps each span override to its config key and reports ignored ones", () => {
    expect(
      spansFromEnv({ BBS_TASK_LEASE_MS: "1500", BBS_LOBBY_WINDOW_MS: "2000", BBS_LOBBY_MUTE_MS: "abc" }),
    ).toEqual({ config: { taskLeaseMs: 1500, lobbyWindowMs: 2000 }, ignored: ["BBS_LOBBY_MUTE_MS"] });
    expect(spansFromEnv({})).toEqual({ config: {}, ignored: [] });
    expect(spansFromEnv({ BBS_LOBBY_MUTE_MS: "999" }).ignored).toEqual(["BBS_LOBBY_MUTE_MS"]);
  });
});

describe("wake budget settings (M4b)", () => {
  it("maps the window (at most 1 day) and the count (1 to 10000)", () => {
    expect(spansFromEnv({ BBS_WAKE_BUDGET_WINDOW_MS: "5000", BBS_WAKE_BUDGET: "2" })).toEqual({
      config: { wakeBudgetWindowMs: 5000, wakeBudgetPerHour: 2 },
      ignored: [],
    });
    expect(spansFromEnv({ BBS_WAKE_BUDGET_WINDOW_MS: String(86_400_000 + 1) }).ignored).toEqual([
      "BBS_WAKE_BUDGET_WINDOW_MS",
    ]);
    for (const bad of ["0", "10001", "-1", "2.5", "x"]) {
      expect(spansFromEnv({ BBS_WAKE_BUDGET: bad }).ignored).toEqual(["BBS_WAKE_BUDGET"]);
    }
  });
});

describe("audit export settings (M6a)", () => {
  it("maps the export interval and hot period; the hot period may exceed 7 days", () => {
    expect(spansFromEnv({ BBS_AUDIT_EXPORT_INTERVAL_MS: "1000", BBS_AUDIT_HOT_MS: String(60 * 86_400_000) })).toEqual({
      config: { auditExportIntervalMs: 1000, auditHotMs: 60 * 86_400_000 },
      ignored: [],
    });
    // Upper bounds match validateConfig (review n1): interval at most 1 day, hot at most 366 days.
    expect(spansFromEnv({ BBS_AUDIT_EXPORT_INTERVAL_MS: String(86_400_000 + 1) }).ignored).toEqual([
      "BBS_AUDIT_EXPORT_INTERVAL_MS",
    ]);
    expect(spansFromEnv({ BBS_AUDIT_HOT_MS: String(367 * 86_400_000) }).ignored).toEqual(["BBS_AUDIT_HOT_MS"]);
  });

  it("builds a GcsSink only from a bucket and a valid service-account key, never echoing the key", () => {
    const pem = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    }).privateKey;
    const key = JSON.stringify({ type: "service_account", client_email: "w@p.iam.gserviceaccount.com", private_key: pem });
    // Deliberately unconfigured: off, and nothing to log (review n2).
    expect(auditSinkFromEnv({})).toEqual({ sink: null });
    expect(auditSinkFromEnv({ BBS_AUDIT_GCS_BUCKET: " ", BBS_AUDIT_GCS_KEY: "" })).toEqual({ sink: null });
    expect(auditSinkFromEnv({ BBS_AUDIT_GCS_BUCKET: "b-audit" }).problem).toMatch(/set both/);
    expect(auditSinkFromEnv({ BBS_AUDIT_GCS_BUCKET: "b-audit", BBS_AUDIT_GCS_KEY: key }).sink).not.toBeNull();
    const secret = '{"type":"service_account","private_key":"SECRET-MATERIAL"';
    const bad = auditSinkFromEnv({ BBS_AUDIT_GCS_BUCKET: "b-audit", BBS_AUDIT_GCS_KEY: secret });
    expect(bad.sink).toBeNull();
    expect(bad.problem).not.toContain("SECRET");
    // Endpoint overrides only to this machine (review m5): anything else turns export off.
    for (const url of ["http://storage.example.com", "https://storage.example.com"]) {
      for (const name of ["BBS_AUDIT_GCS_STORAGE_URL", "BBS_AUDIT_GCS_TOKEN_URL"] as const) {
        const r = auditSinkFromEnv({ BBS_AUDIT_GCS_BUCKET: "b-audit", BBS_AUDIT_GCS_KEY: key, [name]: url });
        expect(r).toMatchObject({ sink: null, problem: expect.stringMatching(/^audit export off: .*localhost/) });
      }
    }
    const local = auditSinkFromEnv({
      BBS_AUDIT_GCS_BUCKET: "b-audit",
      BBS_AUDIT_GCS_KEY: key,
      BBS_AUDIT_GCS_STORAGE_URL: "http://127.0.0.1:9",
      BBS_AUDIT_GCS_TOKEN_URL: "http://localhost:9/token",
    });
    expect(local.sink).not.toBeNull();
    expect(local.problem).toBeUndefined();
  });
});

describe("sign-in source and rate limits (B5)", () => {
  it("keys failed sign-ins by the Cloudflare client address, or local", () => {
    expect(signInSource("203.0.113.7")).toBe("ip:203.0.113.7");
    expect(signInSource(null)).toBe("local");
    expect(signInSource("  ")).toBe("local");
    expect(signInSource("x".repeat(100))).toHaveLength(63);
  });

  it("derives Retry-After from the window's remaining time (review n2)", () => {
    expect([retryAfterSeconds(60_000), retryAfterSeconds(1_200), retryAfterSeconds(0), retryAfterSeconds(undefined)]).toEqual([
      60, 2, 1, 1,
    ]);
  });

  it("answers 429 for rate_limited", () => {
    expect(
      statusFor({ isError: true, content: [], structuredContent: { error: { code: "rate_limited" } } }),
    ).toBe(429);
  });
});

describe("API host rule", () => {
  it.each([
    ["api.example.com", true],
    ["API.EXAMPLE.COM", true],
    ["app.example.com", false],
    ["example.com", false],
    ["localhost", false],
    ["127.0.0.1", false],
    ["apiary.example", false],
  ])("isApiHost(%j) is %j", (host, expected) => {
    expect(isApiHost(host)).toBe(expected);
  });

  it.each([
    ["/health", true],
    ["/mcp", true],
    ["/ws", true],
    ["/api", true],
    ["/api/bbs_topics", true],
    ["/", false],
    ["/index.html", false],
    ["/app.js", false],
    ["/_headers", false],
    ["/mcp/extra", false],
    ["/apix", false],
  ])("isApiPath(%j) is %j", (path, expected) => {
    expect(isApiPath(path)).toBe(expected);
  });
});

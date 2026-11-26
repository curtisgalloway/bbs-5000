// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0

// The two-hostname rule through the Worker's fetch handler: the API host
// serves only the token endpoints and /health, the web host serves the static
// files too, and a local host (wrangler dev) behaves as the web host. The Board
// DO and the static-assets binding are faked.

import { describe, expect, it, vi } from "vitest";

vi.mock("../src/board-do.ts", () => ({
  BoardDO: class {},
  WS_HANDLE_HEADER: "x-h",
  WS_REQUEST_HEADER: "x-r",
  WS_TOKEN_HASH_HEADER: "x-t",
}));
vi.mock("agents/mcp/server", () => ({ createMcpHandler: () => () => new Response("mcp") }));

const { default: worker } = await import("../src/index.ts");

const exec = {} as ExecutionContext;

function makeEnv() {
  const authenticate = vi.fn(async () => ({ ok: false, reason: "missing" }));
  const assetPaths: string[] = [];
  const env = {
    BOARD: {
      idFromName: () => "id",
      get: () => ({ authenticate }),
    },
    ASSETS: {
      fetch: async (req: Request) => {
        const path = new URL(req.url).pathname;
        assetPaths.push(path);
        return path === "/" ? new Response("<html>web view</html>") : new Response(null, { status: 404 });
      },
    },
  };
  return { env: env as never, authenticate, assetPaths };
}

async function call(url: string, init?: RequestInit) {
  const { env, authenticate, assetPaths } = makeEnv();
  const res = await worker.fetch(new Request(url, init), env, exec);
  return { res, text: await res.text(), authenticate, assetPaths };
}

describe("API host (api.example.com)", () => {
  it("answers /health", async () => {
    const r = await call("https://api.example.com/health");
    expect(r.res.status).toBe(200);
    expect(r.text).toContain('"service":"bbs-5000"');
  });

  it("adds the build id to /health when BBS_BUILD_ID is set, and omits it when not", async () => {
    const { env } = makeEnv();
    const withId = await worker.fetch(new Request("https://api.example.com/health"), { ...(env as object), BBS_BUILD_ID: "abc123" } as never, exec);
    expect(await withId.json()).toEqual({ ok: true, service: "bbs-5000", build: "abc123" });
    const withCommit = await worker.fetch(new Request("https://api.example.com/health"), { ...(env as object), BBS_BUILD_ID: "abc123", BBS_GIT_COMMIT: "deadbeef-dirty" } as never, exec);
    expect(await withCommit.json()).toEqual({ ok: true, service: "bbs-5000", build: "abc123", commit: "deadbeef-dirty" });
    const without = await call("https://api.example.com/health");
    expect(JSON.parse(without.text)).toEqual({ ok: true, service: "bbs-5000" });
  });

  it("404s the web view and its files without touching the assets binding", async () => {
    for (const path of ["/", "/index.html", "/app.js", "/_headers", "/nope"]) {
      const r = await call(`https://api.example.com${path}`);
      expect(r.res.status, path).toBe(404);
      expect(r.text, path).toContain("no such route");
      expect(r.assetPaths, path).toEqual([]);
    }
  });

  it("sends /api to the board's sign-in check", async () => {
    const r = await call("https://api.example.com/api/bbs_topics", { method: "POST", body: "{}" });
    expect(r.res.status).toBe(401);
    expect(r.authenticate).toHaveBeenCalledOnce();
  });
});

describe.each(["https://app.example.com", "http://localhost:8787", "http://127.0.0.1:8787"])("web host %s", (origin) => {
  it("serves the web view from the assets binding", async () => {
    const r = await call(`${origin}/`);
    expect(r.res.status).toBe(200);
    expect(r.text).toContain("web view");
    expect(r.assetPaths).toEqual(["/"]);
  });

  it("keeps /health and /api, and answers a missing path with the JSON 404", async () => {
    expect((await call(`${origin}/health`)).res.status).toBe(200);
    const api = await call(`${origin}/api/bbs_topics`, { method: "POST", body: "{}" });
    expect(api.res.status).toBe(401);
    expect(api.assetPaths).toEqual([]);
    const missing = await call(`${origin}/nope`);
    expect(missing.res.status).toBe(404);
    expect(missing.text).toContain("no such route");
  });
});

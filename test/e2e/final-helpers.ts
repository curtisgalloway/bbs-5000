// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared helpers for the final system verification scenarios (F,
 * `final-*.test.ts`): one board under `wrangler dev` per file, a human admin
 * on the CLI or the web client, and small wait loops. Nothing here is
 * specific to one milestone.
 */

import { join } from "node:path";
import { expect } from "vitest";
import { api, groupAlive, makeRunDir, sleep, startWrangler, webSignIn, type RunDir, type Server } from "./harness.ts";

export const asCli = { "x-bbs-client": "cli" };

export interface Board {
  run: RunDir;
  server: Server;
  /** The human admin's credential. */
  human: string;
  /** The human admin's web session (issue #47): signed in by pairing once, then reused; send it with no token. */
  web(): Promise<Record<string, string>>;
  /** A call that must answer 200; returns `value`. */
  ok(token: string | undefined, tool: string, args?: unknown, headers?: Record<string, string>): Promise<any>;
  /** A raw call: status and body. */
  raw(token: string | undefined, tool: string, args?: unknown, headers?: Record<string, string>): Promise<{ status: number; body: any }>;
  /** `bbs_admin_user_add` as the human admin; returns the new token. */
  addUser(handle: string): Promise<string>;
  /** Audit rows (newest 1000 matching), oldest first. */
  audit(filter?: Record<string, unknown>): Promise<any[]>;
  /** `#admin-log` bodies. */
  adminLog(): Promise<string[]>;
  /** Restart `wrangler dev` over the same state directory and port (scenario e). */
  restart(): Promise<void>;
  stop(): Promise<void>;
}

export async function startBoard(extraEnv: Record<string, string> = {}): Promise<Board> {
  const run = makeRunDir("owner", extraEnv);
  const start = (port?: number) =>
    startWrangler({ stateDir: run.stateDir, envFile: run.envFile, logFile: join(run.dir, "wrangler.log"), ...(port ? { port } : {}) });
  let server = await start();
  let webHeaders: Record<string, string> | undefined;
  const b: Board = {
    run,
    get server() {
      return server;
    },
    human: run.humanToken,
    async web() {
      webHeaders ??= (await webSignIn(server.url, run.humanToken)).headers;
      return webHeaders;
    },
    raw: (token, tool, args = {}, headers = {}) => api(server.url, token, tool, args, headers),
    async ok(token, tool, args = {}, headers = {}) {
      const r = await api(server.url, token, tool, args, headers);
      expect(r.status, `${tool}: ${JSON.stringify(r.body)}`).toBe(200);
      return r.body.value;
    },
    async addUser(handle) {
      return (await b.ok(run.humanToken, "bbs_admin_user_add", { handle }, asCli)).token as string;
    },
    async audit(filter = {}) {
      return (await b.ok(run.humanToken, "bbs_audit", { limit: 1000, tail: true, ...filter }, asCli)).events;
    },
    async adminLog() {
      const v = await b.ok(run.humanToken, "bbs_read", { topic: "admin-log", limit: 200, tail: true }, asCli);
      return (v.messages as { body: string }[]).map((m) => m.body);
    },
    async restart() {
      const port = Number(new URL(server.url).port);
      await server.stop();
      expect(groupAlive(server.pid)).toBe(false);
      server = await start(port);
    },
    async stop() {
      await server.stop();
      expect(groupAlive(server.pid)).toBe(false);
      run.cleanup();
    },
  };
  return b;
}

/** Poll `fn` until it returns something truthy, or fail after `ms`. */
export async function until<T>(what: string, fn: () => Promise<T | undefined | false | null>, ms = 20_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(200);
  }
}

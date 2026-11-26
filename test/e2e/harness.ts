// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0

/**
 * e2e harness: runs `wrangler dev` for real on a free local port with its
 * own state directory and its own `.dev.vars`, and always stops it.
 *
 * - Each server is started in its own process group and stopped by signaling
 *   the whole group (SIGTERM, then SIGKILL after a grace period), so the
 *   `workerd` child cannot outlive the test. An exit hook kills any group
 *   still registered if the test process dies early, and SIGINT/SIGTERM
 *   handlers do the same before exiting (a Ctrl-C mid-run leaves nothing).
 * - `WRANGLER_SEND_METRICS=false` (B13); the interactive dev session is off.
 * - The human credential is generated per run; only its hash reaches wrangler,
 *   through an env file in the run's temporary directory.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TIME_KEYS } from "../../packages/core/src/iso-times.ts";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const WORKER_DIR = join(ROOT, "packages/worker");
const WRANGLER = join(ROOT, "node_modules/wrangler/bin/wrangler.js");

const live = new Set<ChildProcess>();

function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    // Already gone.
  }
}

function killAll(): void {
  for (const child of live) killGroup(child, "SIGKILL");
}

process.on("exit", killAll);
for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]] as const) {
  process.once(signal, () => {
    killAll();
    process.exit(code);
  });
}

/** True while any process in the group led by `pid` is alive. */
export function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      srv.close(() => {
        if (addr && typeof addr === "object") resolvePort(addr.port);
        else reject(new Error("no port"));
      });
    });
  });
}

export const sha256 = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

/** A run's temporary directory, human credential and env file. */
export interface RunDir {
  dir: string;
  stateDir: string;
  envFile: string;
  humanHandle: string;
  humanToken: string;
  cleanup(): void;
}

/** `extraEnv` adds lines to the env file (for example a short `BBS_TASK_LEASE_MS`). */
export function makeRunDir(humanHandle = "owner", extraEnv: Record<string, string> = {}): RunDir {
  const dir = mkdtempSync(join(tmpdir(), "bbs-e2e-"));
  const stateDir = join(dir, "state");
  mkdirSync(stateDir);
  const humanToken = `human_${randomBytes(24).toString("base64url")}`;
  const envFile = join(dir, "dev.vars");
  writeFileSync(
    envFile,
    `BBS_HUMAN_HANDLE=${humanHandle}\nBBS_HUMAN_TOKEN_SHA256=${sha256(humanToken)}\n` +
      Object.entries(extraEnv)
        .map(([k, v]) => `${k}=${v}\n`)
        .join(""),
    { mode: 0o600 },
  );
  return {
    dir,
    stateDir,
    envFile,
    humanHandle,
    humanToken,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

export interface Server {
  url: string;
  pid: number;
  logFile: string;
  stop(): Promise<void>;
}

/**
 * Start `wrangler dev` for a config (default: the board) and wait until it
 * answers HTTP. `stateDir` is passed as `--persist-to`; reuse it to restart
 * over the same state.
 */
export interface WranglerOptions {
  stateDir: string;
  envFile?: string;
  config?: string;
  logFile: string;
  timeoutMs?: number;
  /** `service` the Worker's `/health` must report (default: the board's). */
  service?: string;
  /** Listen on this port (a restart keeping its address, F); default a free one. */
  port?: number;
}

/** wrangler could not bind its port or inspector port (someone took it after `freePort`). */
class PortInUseError extends Error {}

const PORT_IN_USE = /EADDRINUSE|address already in use/i;

/**
 * Start `wrangler dev` and wait until it answers as this board. A port taken
 * between `freePort` and wrangler's bind (another test file starting at the
 * same moment) is retried with new ports, or the same port after a pause when
 * the caller fixed it (F review: flakiness).
 */
export async function startWrangler(opts: WranglerOptions): Promise<Server> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await startWranglerOnce(opts);
    } catch (err) {
      if (!(err instanceof PortInUseError) || attempt >= 4) throw err;
      writeFileSync(opts.logFile, `\n[harness] port in use; retrying (attempt ${attempt + 1})\n`, { flag: "a" });
      await sleep(opts.port ? 1000 : 100);
    }
  }
}

async function startWranglerOnce(opts: WranglerOptions): Promise<Server> {
  const logStart = existsSync(opts.logFile) ? readFileSync(opts.logFile, "utf8").length : 0;
  const newLog = (): string => (existsSync(opts.logFile) ? readFileSync(opts.logFile, "utf8").slice(logStart) : "");
  const port = opts.port ?? (await freePort());
  let inspector = await freePort();
  while (inspector === port) inspector = await freePort();
  const args = [
    WRANGLER,
    "dev",
    "--config",
    opts.config ?? join(WORKER_DIR, "wrangler.jsonc"),
    "--ip",
    "127.0.0.1",
    "--port",
    String(port),
    "--inspector-port",
    String(inspector),
    "--persist-to",
    opts.stateDir,
    "--show-interactive-dev-session=false",
    "--log-level",
    "info",
  ];
  if (opts.envFile) args.push("--env-file", opts.envFile);
  const log = openSync(opts.logFile, "a");
  let child: ChildProcess;
  try {
    child = spawn(process.execPath, args, {
      cwd: dirname(opts.config ?? join(WORKER_DIR, "wrangler.jsonc")),
      detached: true,
      stdio: ["ignore", log, log],
      env: { ...process.env, WRANGLER_SEND_METRICS: "false", NO_COLOR: "1", CI: "1" },
    });
  } finally {
    // The child holds its own copy of the descriptor.
    closeSync(log);
  }
  if (child.pid === undefined) throw new Error("wrangler did not start");
  live.add(child);
  const pid = child.pid;
  let exited = false;
  const exitPromise = new Promise<void>((r) =>
    child.on("exit", () => {
      exited = true;
      r();
    }),
  );

  const stop = async (): Promise<void> => {
    killGroup(child, "SIGTERM");
    const deadline = Date.now() + 10_000;
    while (groupAlive(pid) && Date.now() < deadline) await sleep(100);
    if (groupAlive(pid)) killGroup(child, "SIGKILL");
    while (groupAlive(pid)) await sleep(50);
    if (!exited) await exitPromise;
    live.delete(child);
  };

  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + (opts.timeoutMs ?? 60_000);
  for (;;) {
    if (exited) {
      live.delete(child);
      const text = newLog();
      if (PORT_IN_USE.test(text)) throw new PortInUseError(`port ${port} or ${inspector} in use`);
      throw new Error(`wrangler exited early:\n${text.slice(-3000)}`);
    }
    if (PORT_IN_USE.test(newLog())) {
      await stop();
      throw new PortInUseError(`port ${port} or ${inspector} in use`);
    }
    try {
      // Ready only when this port answers as the expected Worker, not just any HTTP.
      const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(1000) });
      const health = (await res.json().catch(() => null)) as { service?: string } | null;
      if (health?.service === (opts.service ?? "bbs-5000")) break;
      throw new Error("not this board yet");
    } catch {
      if (Date.now() > deadline) {
        await stop();
        throw new Error(`wrangler not ready:\n${readFileSync(opts.logFile, "utf8").slice(-3000)}`);
      }
      await sleep(200);
    }
  }
  return { url, pid, logFile: opts.logFile, stop };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** POST /api/<tool> with a token; returns status and parsed body. */
export async function api(
  url: string,
  token: string | undefined,
  tool: string,
  args: unknown = {},
  headers: Record<string, string> = {},
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${url}/api/${tool}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token !== undefined ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: typeof args === "string" ? args : JSON.stringify(args),
  });
  return { status: res.status, body: await res.json() };
}

/** A signed-in browser, as the web view has one: the cookie and the Origin it sends on every call. */
export interface WebSession {
  /** Headers for `api(url, undefined, tool, args, headers)`: the session cookie and the same-origin `Origin`. */
  headers: Record<string, string>;
  /** The cookie's name and value, as a `Cookie` header. */
  cookie: string;
  /** The raw `Set-Cookie` header the claim answered with. */
  setCookie: string;
}

/**
 * Sign a browser in by pairing, the way the web view does with the CLI's help
 * (issue #47): start a pairing, approve its code over `/api` with the person's
 * credential as `bbs web-login` does, then claim it with the poll secret. The
 * cookie value never appears in a response body, only in `Set-Cookie`.
 */
export async function webSignIn(url: string, humanToken: string): Promise<WebSession> {
  const origin = new URL(url).origin;
  const post = (path: string, body: unknown) =>
    fetch(`${url}${path}`, { method: "POST", headers: { "content-type": "application/json", origin }, body: JSON.stringify(body) });
  const started = (await (await post("/api/web/pair/start", {})).json()) as { ok: boolean; value: { code: string; poll_secret: string } };
  if (!started.ok) throw new Error(`pair start failed: ${JSON.stringify(started)}`);
  const approved = await api(url, humanToken, "bbs_web_pairing_approve", { code: started.value.code }, { "x-bbs-client": "cli" });
  if (approved.status !== 200) throw new Error(`approve failed: ${JSON.stringify(approved.body)}`);
  const res = await post("/api/web/pair/claim", { poll_secret: started.value.poll_secret });
  const setCookie = res.headers.get("set-cookie") ?? "";
  const body = (await res.json()) as { ok: boolean; value?: { status: string } };
  if (!body.ok || body.value?.status !== "approved" || !setCookie) throw new Error(`claim failed: ${JSON.stringify(body)}`);
  const cookie = (setCookie.split(";")[0] ?? "").trim();
  return { headers: { cookie, origin }, cookie, setCookie };
}

const ISO_TEXT = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;

/**
 * An audit row as `bbs_audit` returns it, back to the stored form: epoch
 * milliseconds under the time keys, and `detail` as the stored text. The
 * chain hashes that text, so a row can be checked against it or the archive
 * only in this form (the tool converts times to ISO text on the way out).
 */
export function storedAuditRow(e: any): any {
  const back = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(back);
    if (v === null || typeof v !== "object") return v;
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) {
      const time = k.endsWith("_at") || TIME_KEYS.has(k);
      out[k] = time && typeof x === "string" && ISO_TEXT.test(x) ? Date.parse(x) : back(x);
    }
    return out;
  };
  const detail = typeof e.detail === "string" ? e.detail : JSON.stringify(back(e.detail));
  return { ...e, ts: Date.parse(e.ts), detail };
}

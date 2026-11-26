#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0
//
// G3 real-session wake test for Codex (A3G.1–A3G.5, A3G.7) with a real, idle
// Codex TUI attached to a Codex app-server. Uses the Codex subscription for a
// few short model turns.
//
// What it does, all in a temporary directory:
//   1. starts `wrangler dev` (test/e2e/harness.ts) with a fresh board; creates agents
//      A and B (B with harness `codex`); A makes #t; B joins #t at `wake`;
//   2. starts an app-server: by default the local daemon (`codex app-server daemon
//      start`, refused when one is already running, stopped at the end); with
//      `--private`, a foreground `codex app-server --listen unix://<tmp>/as.sock`;
//   3. starts a second Codex TUI WITHOUT the board in a sibling folder (a decoy
//      thread, so thread selection has two loaded threads), then agent B: `codex
//      --remote unix://<sock> -C <dir>` with the adapter as MCP server `bbs` in that
//      folder's own `.codex/config.toml` (the user's Codex config is not edited, except
//      that Codex records the trust answer for the temp folders); answers the
//      folder-trust prompt for the temp folders and "Continue without trusting" for the
//      hooks prompt;
//   4. acts as agent A over /api and checks, with no keypress into B:
//      phase find (A3G.1): the adapter names its thread by the resource handshake
//              before any tool call, and attaches to the board;
//      phase idle (A3G.2): A posts in #t; the ring is `turn_started` confirmed and B's
//              bbs_inbox returns the post; the decoy thread gets no turn;
//      phase busy (A3G.3, A3G.5): B is made busy by a typed prompt (a foreground
//              `node wait25.mjs`); A posts while busy; the doorbell is held (audited
//              `held_busy`), rung and confirmed only after the turn ends, and bbs_inbox
//              returns the post;
//   5. prints a JSON summary and a RESULT line; exit 0 only when every phase passed.
//
// Usage: node test/manual/run-codex-wake.ts [--private] [--keep] [-- <extra codex args>]

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { api, makeRunDir, ROOT, sleep, startWrangler } from "../e2e/harness.ts";
import { codexSocketPath } from "../../packages/adapter/src/main.ts";

const BIN = join(ROOT, "packages/adapter/bin/bbs-adapter.js");
const argv = process.argv.slice(2);
const dashdash = argv.indexOf("--");
const own = dashdash === -1 ? argv : argv.slice(0, dashdash);
const extra = dashdash === -1 ? [] : argv.slice(dashdash + 1);
const opt = { keep: own.includes("--keep"), private: own.includes("--private") };
const now = (): number => Date.now();
const q = (s: string): string => `'${s.replaceAll("'", `'\\''`)}'`;
const sh = (cmd: string, args: string[]): string => execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const shOk = (cmd: string, args: string[]): string => {
  try {
    return sh(cmd, args);
  } catch (err) {
    return String((err as { stdout?: unknown }).stdout ?? "") + String((err as { stderr?: unknown }).stderr ?? "");
  }
};

// --- board and agents ------------------------------------------------------------
const run = makeRunDir("owner");
const human = run.humanToken;
console.log(`run dir: ${run.dir}`);
const server = await startWrangler({ stateDir: run.stateDir, envFile: run.envFile, logFile: join(run.dir, "wrangler.log") });
const asCli = { "x-bbs-client": "cli" };
async function call(token: string, tool: string, args: unknown = {}, headers: Record<string, string> = {}): Promise<any> {
  const r = await api(server.url, token, tool, args, headers);
  if (r.status !== 200) throw new Error(`${tool}: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.value;
}
const A = "wake-a";
const B = "codex-b";
const tokA = (await call(human, "bbs_admin_user_add", { handle: A }, asCli)).token as string;
const tokB = (await call(human, "bbs_admin_user_add", { handle: B, harness: "codex" }, asCli)).token as string;
await call(tokA, "bbs_join", { role: "test driver" });
await call(tokA, "bbs_topic_create", { name: "t", description: "G3 Codex wake test" });
await call(tokB, "bbs_subscribe", { topic: "t", level: "wake" });

const bDir = join(run.dir, "agent-b");
mkdirSync(bDir);
const bConfig = join(bDir, "bbs-config.json");
writeFileSync(bConfig, JSON.stringify({ url: server.url, token: tokB }), { mode: 0o600 });
writeFileSync(join(bDir, "wait25.mjs"), `setTimeout(() => console.log("ok"), 25000);\n`);
const adapterLog = join(run.dir, "adapter.jsonl");

// --- app-server ------------------------------------------------------------------
// A unix socket path must stay short (104 bytes on macOS): its own temp dir.
const sockDir = opt.private ? mkdtempSync(join(tmpdir(), "bbs-cx-")) : undefined;
const sock = sockDir ? join(sockDir, "as.sock") : codexSocketPath(process.env);
const tag = `bbs-cx-${process.pid}`;
const sessions = { server: `${tag}-as`, decoy: `${tag}-decoy`, b: `${tag}-b` };
let daemonStarted = false;
if (opt.private) {
  sh("tmux", ["new-session", "-d", "-s", sessions.server, "-c", bDir, `codex app-server --listen ${q(`unix://${sock}`)}`]);
} else {
  const before = shOk("codex", ["app-server", "daemon", "version"]);
  if (!/failed to connect|No such file/i.test(before)) {
    console.error("A Codex app-server daemon is already running; refusing to use it. Stop it or pass --private.");
    await server.stop();
    process.exit(2);
  }
  console.log(shOk("codex", ["app-server", "daemon", "start"]).trim().slice(0, 300));
  daemonStarted = true;
}
for (let i = 0; i < 40 && !existsSync(sock); i++) await sleep(250);
console.log(`app-server socket ${existsSync(sock) ? "ready" : "MISSING"}`);

function cleanup(): void {
  for (const s of Object.values(sessions)) shOk("tmux", ["kill-session", "-t", s]);
  if (daemonStarted) {
    daemonStarted = false;
    console.log(`daemon stop: ${shOk("codex", ["app-server", "daemon", "stop"]).trim().slice(0, 200)}`);
  }
  if (sockDir) rmSync(sockDir, { recursive: true, force: true });
}
process.on("exit", cleanup);
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.once(sig, () => {
    cleanup();
    void server.stop().finally(() => process.exit(130));
  });
}

// --- TUIs ------------------------------------------------------------------------
const toml = (s: string): string => JSON.stringify(s);
const mcpEnv = {
  BBS_CONFIG: bConfig,
  BBS_HARNESS: "codex",
  BBS_ADAPTER_LOG: adapterLog,
  BBS_MACHINE: "workstation-1",
  ...(opt.private ? { BBS_CODEX_SOCKET: sock } : {}),
};
// The board's MCP server goes in the folder's own `.codex/config.toml` (read for a
// trusted folder). `-c mcp_servers.bbs.*` on `codex --remote` does not reach the
// app-server's thread (first real run, 2026-11-21: no adapter process started).
mkdirSync(join(bDir, ".codex"));
writeFileSync(
  join(bDir, ".codex", "config.toml"),
  [
    "[mcp_servers.bbs]",
    `command = ${toml(process.execPath)}`,
    `args = [${toml(BIN)}]`,
    `env = { ${Object.entries(mcpEnv)
      .map(([k, v]) => `${k} = ${toml(v)}`)
      .join(", ")} }`,
    `default_tools_approval_mode = "approve"`,
    "",
  ].join("\n"),
);
// The decoy runs in a sibling folder without that file.
const decoyDir = join(run.dir, "decoy");
mkdirSync(decoyDir);
const tui = (dir: string): string => ["codex", "--remote", `unix://${sock}`, "-C", dir, ...extra].map(q).join(" ");
const screen = (s: string): string => shOk("tmux", ["capture-pane", "-p", "-J", "-t", s]);
const pane = (s: string): string => shOk("tmux", ["capture-pane", "-p", "-J", "-S", "-400", "-t", s]);
const snapshot = (s: string, name: string): void => writeFileSync(join(run.dir, `pane-${name}.txt`), pane(s));
const keysSent: { t: number; session: string; keys: string[] }[] = [];
function sendKeys(s: string, ...keys: string[]): void {
  keysSent.push({ t: now(), session: s, keys });
  sh("tmux", ["send-keys", "-t", s, ...keys]);
}
const dialogs = [
  { id: "folder-trust", re: /(\d+)\.\s*Trust and continue/ },
  { id: "hooks-review", re: /(\d+)\.\s*Continue without trusting/ },
];
const dialogsSeen: string[] = [];
/** Answer the startup prompts until the composer shows. */
async function settle(s: string, ms: number): Promise<boolean> {
  const end = now() + ms;
  while (now() < end) {
    await sleep(1000);
    const text = screen(s);
    let open = false;
    for (const d of dialogs) {
      const m = text.match(d.re);
      if (!m) continue;
      open = true;
      dialogsSeen.push(`${s}:${d.id}`);
      sendKeys(s, m[1]!);
      await sleep(500);
      sendKeys(s, "Enter");
      await sleep(1500);
    }
    if (!open && /Ask Codex to do anything|›/.test(text) && /OpenAI Codex/.test(text)) return true;
  }
  return false;
}

function jsonl(path: string): Record<string, any>[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, any>);
}
const adapter = (): Record<string, any>[] => jsonl(adapterLog);
async function waitFor<T>(fn: () => T | undefined | false, ms: number): Promise<T | undefined> {
  const deadline = now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (now() > deadline) return undefined;
    await sleep(250);
  }
}
const ringAfter = (t: number, result?: string) =>
  adapter().find((l) => l.ev === "ring" && l.t > t && (result === undefined || l.result === result));
const inboxWith = (seq: number, t: number) =>
  adapter().find((l) => l.ev === "tool" && l.name === "bbs_inbox" && l.t > t && (l.wake_seqs ?? []).includes(seq));

interface Phase {
  pass: boolean;
  [k: string]: unknown;
}
const phases: Record<string, Phase> = {};

// Decoy first: a thread in the same folder without the board.
sh("tmux", ["new-session", "-d", "-s", sessions.decoy, "-x", "180", "-y", "50", "-c", decoyDir, tui(decoyDir)]);
const decoyReady = await settle(sessions.decoy, 60_000);
const tLaunch = now();
sh("tmux", ["new-session", "-d", "-s", sessions.b, "-x", "180", "-y", "50", "-c", bDir, tui(bDir)]);
console.log(`tmux: ${sessions.b} (agent B), ${sessions.decoy} (decoy)${opt.private ? `, ${sessions.server} (app-server)` : ""}`);
const bReady = await settle(sessions.b, 90_000);

// --- phase find (A3G.1) -------------------------------------------------------------
const found = await waitFor(() => adapter().find((l) => l.ev === "codex_thread"), 30_000);
const attached = await waitFor(() => adapter().find((l) => l.ev === "attached"), 30_000);
const toolBefore = adapter().find((l) => l.ev === "tool" && found !== undefined && l.t < found.t);
phases.find = {
  pass: found?.how === "resource" && attached !== undefined && toolBefore === undefined,
  how: found?.how ?? null,
  ms_after_launch: found ? found.t - tLaunch : null,
  attached: attached !== undefined,
  decoy_ready: decoyReady,
  b_ready: bReady,
};
snapshot(sessions.b, "b-idle");
await call(tokB, "bbs_inbox", {});

// --- phase idle (A3G.2) -------------------------------------------------------------
{
  const t = now();
  const post = await call(tokA, "bbs_post", { topic: "t", body: "G3 idle wake check" });
  const ring = await waitFor(() => ringAfter(t), 20_000);
  const inbox = await waitFor(() => inboxWith(post.seq, t), 90_000);
  await waitFor(() => adapter().find((l) => l.ev === "state" && l.state === "idle" && l.t > (inbox?.t ?? t)), 60_000);
  snapshot(sessions.b, "b-after-idle");
  snapshot(sessions.decoy, "decoy-after-idle");
  const decoyTurn = /BBS-5000:/.test(pane(sessions.decoy));
  phases.idle = {
    pass: ring?.result === "turn_started" && ring?.confirmed === true && inbox !== undefined && !decoyTurn,
    ring: ring ? { result: ring.result, confirmed: ring.confirmed, ms: ring.t - t } : null,
    inbox_ms: inbox ? inbox.t - t : null,
    decoy_got_doorbell: decoyTurn,
  };
}

// --- phase busy (A3G.3, A3G.5) --------------------------------------------------------
{
  await sleep(3000);
  const t = now();
  sendKeys(sessions.b, "-l", "Run the shell command `node wait25.mjs` in the foreground and wait for it to finish, then reply DONE.");
  await sleep(500);
  sendKeys(sessions.b, "Enter");
  const busy = await waitFor(() => adapter().find((l) => l.ev === "state" && l.state === "busy" && l.t > t), 20_000);
  await sleep(4000);
  const tPost = now();
  const post = await call(tokA, "bbs_post", { topic: "t", body: "G3 busy hold check" });
  // The board holds a due doorbell while the session reports busy (it never reaches
  // the adapter), audited as `doorbell_due` with ring result `held_busy`; the adapter
  // answers `held_busy` itself only if a doorbell reaches it while busy.
  const idleAgain = await waitFor(() => adapter().find((l) => l.ev === "state" && l.state === "idle" && l.t > tPost), 120_000);
  const firstRing = ringAfter(tPost);
  const rung = await waitFor(() => adapter().find((l) => l.ev === "ring" && l.t > tPost && l.result === "turn_started"), 30_000);
  const inbox = await waitFor(() => inboxWith(post.seq, tPost), 120_000);
  const dueRows = (await call(human, "bbs_audit", { action: "doorbell_due", limit: 50 }, asCli)).events as any[];
  const heldAudited = dueRows.some((e) => e.target_id === B && e.ts >= tPost && e.detail?.ring?.result === "held_busy");
  const heldByAdapter = firstRing?.result === "held_busy";
  const earlyTurn = rung !== undefined && idleAgain !== undefined && rung.t < idleAgain.t;
  snapshot(sessions.b, "b-after-busy");
  phases.busy = {
    pass: busy !== undefined && (heldAudited || heldByAdapter) && !earlyTurn && rung?.confirmed === true && inbox !== undefined,
    busy_seen: busy !== undefined,
    held_audited: heldAudited,
    held_by_adapter: heldByAdapter,
    idle_ms_after_post: idleAgain ? idleAgain.t - tPost : null,
    rung_after_idle: rung ? { result: rung.result, confirmed: rung.confirmed, ms_after_idle: idleAgain ? rung.t - idleAgain.t : null } : null,
    inbox_ms_after_post: inbox ? inbox.t - tPost : null,
  };
}

// --- summary -------------------------------------------------------------------------
const audit = (await call(human, "bbs_audit", { action: "ring_result", limit: 50 }, asCli)) as { events?: { detail?: unknown }[] };
const ringResults = (audit.events ?? []).map((e) => e.detail);
const summary = {
  socket: opt.private ? "private app-server" : "daemon",
  phases,
  dialogs: dialogsSeen,
  keys_after_setup: keysSent.filter((k) => k.t > tLaunch).length,
  ring_results_audited: ringResults,
  adapter_events: adapter().map((l) => l.ev).filter((e, i, all) => all.indexOf(e) === i),
};
writeFileSync(join(run.dir, "summary.json"), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
const failed = Object.entries(phases)
  .filter(([, p]) => !p.pass)
  .map(([n]) => n);
if (opt.keep) {
  console.log("--keep: press Enter to stop");
  await new Promise((r) => process.stdin.once("data", r));
}
cleanup();
rmSync(bConfig, { force: true });
await server.stop();
console.log(failed.length === 0 ? "RESULT: pass" : `RESULT: fail (${failed.join(", ")})`);
process.exit(failed.length === 0 ? 0 : 1);

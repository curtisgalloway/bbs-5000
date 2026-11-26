#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0
//
// Helper for surfaces-checklist.md: starts a local board under `wrangler dev`
// and prepares a project folder that any Claude surface can open, with the
// adapter as its `bbs` MCP server and the hooks in `.claude/settings.json`.
// Creates agents A and B, topic #t (B at wake), and prints the command that
// posts as A. Runs until Enter or Ctrl-C, then stops the board.
//
// Usage: node test/manual/surface-board.ts [<project folder>]
//   default folder: a new temporary directory (printed). Never writes tokens
//   into the folder: the configs live in the run directory, mode 600.

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { api, makeRunDir, ROOT, startWrangler } from "../e2e/harness.ts";

const BIN = join(ROOT, "packages/adapter/bin/bbs-adapter.js");
const CLI = join(ROOT, "packages/cli/bin/bbs.js");
const project = resolve(process.argv[2] ?? mkdtempSync(join(tmpdir(), "bbs-surface-")));
// Never overwrite a project's own MCP or Claude Code settings (review m8).
for (const f of [".mcp.json", join(".claude", "settings.json")]) {
  if (existsSync(join(project, f))) {
    console.error(`refusing: ${join(project, f)} already exists; give an empty folder (or none for a temporary one)`);
    process.exit(2);
  }
}
mkdirSync(join(project, ".claude"), { recursive: true });

const run = makeRunDir("owner");
const server = await startWrangler({ stateDir: run.stateDir, envFile: run.envFile, logFile: join(run.dir, "wrangler.log") });
const asCli = { "x-bbs-client": "cli" };
async function call(token: string, tool: string, args: unknown = {}, headers: Record<string, string> = {}): Promise<any> {
  const r = await api(server.url, token, tool, args, headers);
  if (r.status !== 200) throw new Error(`${tool}: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.value;
}
const tokA = (await call(run.humanToken, "bbs_admin_user_add", { handle: "surface-a" }, asCli)).token as string;
const tokB = (await call(run.humanToken, "bbs_admin_user_add", { handle: "surface-b" }, asCli)).token as string;
await call(tokA, "bbs_join", { role: "posts test messages" });
await call(tokA, "bbs_topic_create", { name: "t", description: "surface check" });
await call(tokB, "bbs_subscribe", { topic: "t", level: "wake" });

const configA = join(run.dir, "config-a.json");
const configB = join(run.dir, "config-b.json");
writeFileSync(configA, JSON.stringify({ url: server.url, token: tokA }), { mode: 0o600 });
writeFileSync(configB, JSON.stringify({ url: server.url, token: tokB }), { mode: 0o600 });
const adapterLog = join(run.dir, "adapter.jsonl");
writeFileSync(
  join(project, ".mcp.json"),
  JSON.stringify(
    {
      mcpServers: {
        bbs: {
          command: process.execPath,
          args: [BIN],
          env: { BBS_CONFIG: configB, BBS_ADAPTER_LOG: adapterLog, BBS_MACHINE: "workstation-1" },
        },
      },
    },
    null,
    2,
  ),
);
const hook = (event: string) => [{ hooks: [{ type: "command", command: `"${process.execPath}" "${BIN}" hook ${event}` }] }];
writeFileSync(
  join(project, ".claude", "settings.json"),
  JSON.stringify(
    {
      enableAllProjectMcpServers: true,
      permissions: { allow: ["mcp__bbs__bbs_inbox", "mcp__bbs__bbs_read"] },
      hooks: { UserPromptSubmit: hook("UserPromptSubmit"), Stop: hook("Stop"), StopFailure: hook("StopFailure"),
        Notification: [{ matcher: "idle_prompt", ...hook("idle_prompt")[0] }] },
    },
    null,
    2,
  ),
);

console.log(`
Board running at ${server.url}
Project folder for the surface: ${project}
Adapter log (doorbells, rings, tool calls; no message text): ${adapterLog}

Post as agent A (run in another terminal while the session is idle):
  BBS_CONFIG=${configA} node ${CLI} post t "Hello from agent A. No action needed beyond reading this."

Press Enter here to stop the board.`);
await new Promise((r) => process.stdin.once("data", r));
await server.stop();
// The tokens die with this board, but do not leave them on disk.
rmSync(configA, { force: true });
rmSync(configB, { force: true });
console.log(`stopped. Logs: ${run.dir}`);
process.exit(0);

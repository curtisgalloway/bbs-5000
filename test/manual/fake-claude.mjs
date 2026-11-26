#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0
//
// Stand-in for an interactive Claude Code session, for dry runs of
// run-wake.ts only (BBS_CLAUDE_BIN=test/manual/fake-claude.mjs). Not evidence
// about Claude Code. It imitates what the driver depends on:
// - the folder-trust arrow menu (cursor on "No") and the development-channels
//   warning, answered through the terminal;
// - starting the `bbs` MCP server from .mcp.json over stdio, with
//   CLAUDE_CODE_MESSAGING_SOCKET set for it and for the hooks; or (G2) with
//   `--plugin-dir <dir>` and `plugin:<name>@inline`, the plugin's channel
//   server from its manifest, `${CLAUDE_PLUGIN_ROOT}` and `${user_config.*}`
//   substituted (options from the settings file's `pluginConfigs`; a required
//   option unset means no server, as Claude Code 2.1.330 does), and its
//   hooks/hooks.json run in exec form beside the settings hooks;
// - running the settings file's hook commands (UserPromptSubmit, Stop);
// - a channel event in an idle session starts a "turn" that calls bbs_inbox;
// - (G4) unless FAKE_CLAUDE_NO_INBOX=1, with no development-channels flag, the channel is not loaded (its
//   events are dropped) and the dev-channels warning does not show; the
//   session's inbox socket is bound and CLAUDE_CODE_MESSAGING_TOKEN set, and a
//   user message posted there (after an optional auth line) starts a turn
//   whose UserPromptSubmit prompt is exactly the message text, as Claude Code
//   2.1.330 did in the G4 spike;
// - a typed prompt starts a turn. Like Claude Code 2.1.329, a standalone
//   "sleep N" is refused and pushed to the background, so the turn stops in
//   about 3 s (the real phase 2 reruns failed on this). "node <file>" runs
//   that file in the foreground (PreToolUse hook first) and the turn lasts
//   until it exits;
// - like Claude Code, an Enter that arrives within 50 ms of typed text is part
//   of a paste and does not submit (the real run's phase 2 failed on this).
import { execFile, execFileSync, execSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const args = process.argv.slice(2);
const settings = JSON.parse(readFileSync(args[args.indexOf("--settings") + 1], "utf8"));
const channelAt = args.indexOf("--dangerously-load-development-channels");
const channel = channelAt === -1 ? "" : (args[channelAt + 1] ?? "");
// Short enough for a unix socket path; bound for real (G4).
const messaging = join(tmpdir(), `fake-claude-${process.pid}.sock`);
const messagingToken = randomBytes(12).toString("hex");
// FAKE_CLAUDE_NO_INBOX=1: an older Claude Code with no inbox socket (the adapter
// must ring by the channel). The messaging path is still exported for the hooks.
const noInbox = process.env.FAKE_CLAUDE_NO_INBOX === "1";
const env = {
  ...process.env,
  CLAUDE_CODE_MESSAGING_SOCKET: messaging,
  ...(noInbox ? {} : { CLAUDE_CODE_MESSAGING_TOKEN: messagingToken }),
};
let serverName;
let mcp;
let pluginHooks = {};
const pluginAt = args.indexOf("--plugin-dir");
const plugin =
  /^plugin:([^@]+)@inline$/.exec(channel) ??
  (channel === "" && pluginAt !== -1
    ? [null, JSON.parse(readFileSync(join(args[pluginAt + 1], ".claude-plugin", "plugin.json"), "utf8")).name]
    : null);
if (plugin) {
  const root = args[args.indexOf("--plugin-dir") + 1];
  const manifest = JSON.parse(readFileSync(join(root, ".claude-plugin", "plugin.json"), "utf8"));
  if (manifest.name !== plugin[1]) throw new Error(`fake-claude: plugin ${plugin[1]} not loaded`);
  const options = settings.pluginConfigs?.[`${plugin[1]}@inline`]?.options ?? {};
  const missing = Object.entries(manifest.userConfig ?? {}).filter(([k, o]) => o.required && !options[k]);
  const sub = (v) =>
    v.replaceAll("${CLAUDE_PLUGIN_ROOT}", root).replace(/\$\{user_config\.([A-Za-z0-9_]+)\}/g, (_, k) => String(options[k] ?? ""));
  const key = manifest.channels[0].server;
  serverName = `plugin:${manifest.name}:${key}`;
  const m = manifest.mcpServers[key];
  mcp = missing.length
    ? undefined
    : { command: m.command, args: m.args.map(sub), env: Object.fromEntries(Object.entries(m.env ?? {}).map(([k, v]) => [k, sub(v)])) };
  env.CLAUDE_PLUGIN_ROOT = root;
  const hooksFile = JSON.parse(readFileSync(join(root, "hooks", "hooks.json"), "utf8"));
  pluginHooks = JSON.parse(JSON.stringify(hooksFile.hooks).replaceAll("${CLAUDE_PLUGIN_ROOT}", root));
} else {
  serverName = channel.replace(/^server:/, "") || "bbs";
  mcp = JSON.parse(readFileSync(".mcp.json", "utf8")).mcpServers[serverName];
}
if (mcp?.command === "node") mcp.command = process.execPath;

function runHook(name, input) {
  for (const group of [...(settings.hooks?.[name] ?? []), ...(pluginHooks[name] ?? [])]) {
    for (const h of group.hooks) {
      try {
        const stdin = JSON.stringify({ hook_event_name: name, session_id: "fake", ...input });
        if (h.args) execFileSync(h.command === "node" ? process.execPath : h.command, h.args, { input: stdin, env });
        else execSync(h.command, { input: stdin, env });
      } catch {
        // A failed hook does not stop the session.
      }
    }
  }
}

// Raw keyboard input, so the timing of an Enter can be seen.
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.setEncoding("utf8");
const PASTE_MS = 50;
let buffer = "";
let lastTextAt = 0;
let onLine = null;
process.stdin.on("data", (chunk) => {
  for (const ch of chunk) {
    if (ch === "\u0003") process.exit(130);
    if (ch === "\r" || ch === "\n") {
      if (Date.now() - lastTextAt < PASTE_MS) {
        buffer += "\n"; // part of a paste: not submitted
        continue;
      }
      const line = buffer;
      buffer = "";
      onLine?.(line);
      continue;
    }
    buffer += ch;
    if (ch >= " ") {
      lastTextAt = Date.now();
      process.stdout.write(ch);
    }
  }
});
const nextLine = () => new Promise((resolve) => {
  onLine = (line) => {
    onLine = null;
    resolve(line);
  };
});
console.log("Do you trust the files in this folder?");
console.log(" ❯ No, exit");
console.log("   Yes, I trust this folder");
const trust = await nextLine();
if (!trust.includes("\u001b[B")) {
  console.log("not trusted; exiting");
  process.exit(1);
}
console.clear();
if (channel) {
  console.log("WARNING: Loading development channels");
  console.log("  1. I am using this for local development");
  console.log("  2. Exit");
  await nextLine();
  console.clear();
  console.log(`Channels (experimental) messages from ${channel} inject directly in this session`);
} else {
  console.log("No channels loaded; inbox socket bound");
}

const client = new Client({ name: "fake-claude", version: "0" });
const queue = [];
let busy = false;
client.fallbackNotificationHandler = async (n) => {
  // Without the flag the channel is not loaded: its events go nowhere.
  if (n.method !== "notifications/claude/channel" || !channel) return;
  queue.push({ kind: "channel", content: String(n.params?.content ?? ""), meta: n.params?.meta ?? {} });
  if (!busy) void drain();
};
if (!mcp) {
  console.log(`${serverName}: not started (a required plugin option is not set)`);
  await new Promise(() => {});
}
// The session's inbox socket (cross-session messaging): newline-delimited JSON,
// an optional {"type":"auth"} line, then {"type":"user","message":{...}} lines.
rmSync(messaging, { force: true });
const inbox = createServer((sock) => {
  let buf = "";
  sock.setEncoding("utf8");
  sock.on("data", (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      try {
        const m = JSON.parse(line);
        if (m.type === "user" && typeof m.message?.content === "string") {
          queue.push({ kind: "inbox", content: m.message.content });
          if (!busy) void drain();
        }
      } catch {
        // Not JSON: ignored.
      }
    }
  });
  sock.on("error", () => {});
});
if (!noInbox) inbox.listen(messaging);
process.on("exit", () => rmSync(messaging, { force: true }));
for (const sig of ["SIGHUP", "SIGTERM"]) process.on(sig, () => process.exit(0));
await client.connect(
  new StdioClientTransport({ command: mcp.command, args: mcp.args, env: { ...env, ...mcp.env }, stderr: "ignore" }),
);
runHook("SessionStart", {});
console.log("> ");

onLine = (line) => {
  process.stdout.write("\n");
  const text = line.trim();
  if (!text) return;
  queue.push({ kind: "prompt", content: text });
  if (!busy) void drain();
};

async function drain() {
  busy = true;
  while (queue.length) {
    const item = queue.shift();
    // Like Claude Code: a channel turn's prompt is the event as a <channel> tag,
    // each meta entry an attribute (I0; the adapter reads its doorbell id, B57).
    const attrs = Object.entries(item.meta ?? {}).map(([k, v]) => ` ${k}="${v}"`).join("");
    const prompt = item.kind === "channel" ? `<channel source="${serverName}"${attrs}>${item.content}</channel>` : item.content;
    runHook("UserPromptSubmit", { prompt });
    if (item.kind === "channel" || item.kind === "inbox") {
      console.log(item.kind === "channel" ? `← ${serverName}: ${item.content}` : `Another Claude session sent a message: ${item.content}`);
      const r = await client.callTool({ name: "bbs_inbox", arguments: {} });
      const v = r.structuredContent ?? {};
      console.log(`read ${(v.wake ?? []).length} wake, ${(v.digest ?? []).length} digest, ${(v.notices ?? []).length} notices`);
    } else {
      console.log(`> ${item.content}`);
      const node = /\bnode (\S+\.mjs)\b/.exec(item.content);
      if (/\bsleep \d+/.test(item.content)) {
        console.log("Blocked: standalone sleep. Running it in the background instead.");
        await new Promise((r) => setTimeout(r, 3000));
        console.log("Started in the background.");
      } else if (node) {
        const command = `node ${node[1]}`;
        runHook("PreToolUse", { tool_name: "Bash", tool_input: { command } });
        console.log(`Bash(${command})`);
        // FAKE_CLAUDE_BACKGROUND=1: the model backgrounds the command anyway and
        // stops in 3 s (to check the driver calls that a driver problem).
        if (process.env.FAKE_CLAUDE_BACKGROUND === "1") await new Promise((r) => setTimeout(r, 3000));
        else await new Promise((r) => execFile(process.execPath, [node[1]], () => r()));
        console.log("DONE");
      } else {
        console.log("DONE");
      }
    }
    runHook("Stop", {});
  }
  busy = false;
}

// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0

/**
 * G2 (B12): the Claude Code plugin manifests agree with the adapter. The
 * repository root is a local marketplace (`.claude-plugin/marketplace.json`)
 * listing `packages/adapter` as the plugin `bbs`; the plugin declares the
 * adapter as MCP server and channel `bbs` and its hooks (the busy/idle ones,
 * `SessionStart`, `PostToolBatch`; issue #100). Claude Code's
 * own check is `claude plugin validate`, run by hand (CI has no `claude`).
 * Manifest fields: https://code.claude.com/docs/en/plugins-reference (read
 * 2026-11-21).
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { INSTRUCTIONS } from "../src/claude-ring.ts";
import { HOOK_EVENTS, HOOK_EXTRA_EVENTS } from "../src/hooks.ts";
import { VERSION } from "../src/main.ts";

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = resolve(PLUGIN_ROOT, "..", "..");
const json = (path: string): any => JSON.parse(readFileSync(path, "utf8"));
const marketplace = json(join(REPO_ROOT, ".claude-plugin", "marketplace.json"));
const manifest = json(join(PLUGIN_ROOT, ".claude-plugin", "plugin.json"));
const hooksFile = json(join(PLUGIN_ROOT, "hooks", "hooks.json"));
const pkg = json(join(PLUGIN_ROOT, "package.json"));

/** `${CLAUDE_PLUGIN_ROOT}` substituted the way Claude Code does for a plugin loaded in place. */
const atRoot = (s: string): string => s.replaceAll("${CLAUDE_PLUGIN_ROOT}", PLUGIN_ROOT);
const BIN_ARG = "${CLAUDE_PLUGIN_ROOT}/bin/bbs-adapter.js";

describe("plugin packaging (G2, B12)", () => {
  it("the repository root is the bbs-5000 marketplace, listing packages/adapter as bbs", () => {
    expect(marketplace.name).toBe("bbs-5000");
    expect(typeof marketplace.owner?.name).toBe("string");
    expect(marketplace.plugins).toHaveLength(1);
    const entry = marketplace.plugins[0];
    expect(entry.name).toBe("bbs");
    expect(entry.source).toBe("./packages/adapter");
    // A relative path resolves from the marketplace root, not from .claude-plugin/.
    expect(resolve(REPO_ROOT, entry.source)).toBe(PLUGIN_ROOT);
    // The entry name (install key) and the manifest name (namespace) agree.
    expect(manifest.name).toBe(entry.name);
  });

  it("the manifest's metadata matches the package", () => {
    expect(manifest.license).toBe(pkg.license);
    expect(manifest.version).toBe(VERSION);
    expect(manifest.version).toBe(pkg.version);
  });

  it("declares the adapter as MCP server and channel bbs, started from the plugin's own bin", () => {
    expect(Object.keys(manifest.mcpServers)).toEqual(["bbs"]);
    const server = manifest.mcpServers.bbs;
    expect(server.command).toBe("node");
    expect(server.args).toEqual([BIN_ARG]);
    expect(atRoot(server.args[0])).toBe(join(PLUGIN_ROOT, pkg.bin["bbs-adapter"]));
    expect(existsSync(atRoot(server.args[0]))).toBe(true);
    // Claude by default: the plugin never selects the Codex ring.
    expect(server.env.BBS_HARNESS).toBeUndefined();
    expect(manifest.channels).toEqual([{ server: "bbs", displayName: expect.any(String) }]);
    expect(Object.keys(manifest.mcpServers)).toContain(manifest.channels[0].server);
  });

  it("every user option is used, every use is declared, and the token never is one", () => {
    const options = Object.keys(manifest.userConfig).sort();
    const used = [...JSON.stringify(manifest.mcpServers).matchAll(/\$\{user_config\.([A-Za-z0-9_]+)\}/g)].map((m) => m[1]!);
    expect([...new Set(used)].sort()).toEqual(options);
    expect(manifest.mcpServers.bbs.env).toEqual({
      BBS_CONFIG: "${user_config.config_path}",
      BBS_MACHINE: "${user_config.machine}",
      BBS_PLUGIN_AUTO_JOIN: "${user_config.auto_join}",
    });
    // Unset and required, Claude Code does not start the server (G2 probe), so
    // the adapter never falls back to the person's own ~/.config/bbs/config.json.
    expect(manifest.userConfig.config_path).toMatchObject({ type: "file", required: true });
    expect(manifest.userConfig.machine.type).toBe("string");
    expect(manifest.userConfig.machine.required).toBeUndefined();
    // Auto-join: a plain string (no `options` list, which older Claude Code versions refuse to load), "git" unless set.
    expect(manifest.userConfig.auto_join).toMatchObject({ type: "string", default: "git" });
    expect(manifest.userConfig.auto_join.required).toBeUndefined();
    expect(manifest.userConfig.auto_join.options).toBeUndefined();
    for (const [key, opt] of Object.entries<any>(manifest.userConfig)) {
      expect(key).not.toMatch(/token|secret|key/i);
      expect(opt.sensitive).toBeUndefined();
    }
  });

  it("hooks.json runs the adapter's hook command, exec form, for every event the adapter handles", () => {
    expect(Object.keys(hooksFile)).toEqual(["hooks"]);
    const seen: string[] = [];
    for (const [event, groups] of Object.entries<any[]>(hooksFile.hooks)) {
      expect(groups).toHaveLength(1);
      const group = groups[0]!;
      expect(group.hooks).toHaveLength(1);
      const { timeout, async: background, ...h } = group.hooks[0];
      // Exec form (args set): no shell, so a plugin path with spaces stays one argument.
      expect(h).toEqual({ type: "command", command: "node", args: [BIN_ARG, "hook", expect.any(String)] });
      const name = h.args[2] as string;
      if (event === "Notification") {
        expect(group.matcher).toBe("idle_prompt");
        expect(name).toBe("idle_prompt");
      } else {
        expect(group.matcher).toBeUndefined();
        expect(name).toBe(event);
      }
      // The two that answer the model wait for the adapter, so they carry a timeout (seconds); the tool-batch one never blocks the model.
      if (event === "SessionStart" || event === "Stop") expect(timeout).toBeGreaterThan(5);
      else expect(timeout).toBeUndefined();
      if (event === "PostToolBatch") expect(background).toBe(true);
      else expect(background).toBeUndefined();
      seen.push(name);
    }
    expect(seen.sort()).toEqual([...Object.keys(HOOK_EVENTS), ...HOOK_EXTRA_EVENTS].sort());
  });

  it("every file the manifest and the hooks name exists, and every user option the hooks use is declared", () => {
    for (const rel of [".claude-plugin/plugin.json", "hooks/hooks.json", "bin/bbs-adapter.js"]) {
      expect(existsSync(join(PLUGIN_ROOT, rel)), rel).toBe(true);
    }
    for (const groups of Object.values<any[]>(hooksFile.hooks)) {
      for (const g of groups) {
        for (const h of g.hooks) {
          for (const arg of h.args as string[]) {
            if (arg.includes("${CLAUDE_PLUGIN_ROOT}")) expect(existsSync(atRoot(arg)), arg).toBe(true);
          }
          expect(JSON.stringify(h)).not.toContain("user_config");
        }
      }
    }
  });

  it("the plugin's commands run from another project folder (workspace packages load in place)", () => {
    const cwd = mkdtempSync(join(tmpdir(), "bbs-plugin-"));
    try {
      const server = manifest.mcpServers.bbs;
      const v = spawnSync(server.command === "node" ? process.execPath : server.command, [...server.args.map(atRoot), "--version"], {
        cwd,
        encoding: "utf8",
        timeout: 10_000,
      });
      expect(v.status).toBe(0);
      expect(v.stdout).toContain(VERSION);
      // A hook with no adapter listening prints nothing and exits 0.
      const h = hooksFile.hooks.Stop[0].hooks[0];
      const r = spawnSync(process.execPath, h.args.map(atRoot), {
        cwd,
        input: "{}",
        env: { ...process.env, BBS_ADAPTER_SOCKET_DIR: cwd, CLAUDE_CODE_MESSAGING_SOCKET: join(cwd, "none.sock") },
        encoding: "utf8",
        timeout: 10_000,
      });
      expect(r.status).toBe(0);
      expect(r.stdout).toBe("");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("the channel instructions do not assume the .mcp.json source name", () => {
    expect(INSTRUCTIONS).not.toMatch(/<channel source="bbs"/);
    expect(INSTRUCTIONS).toContain("plugin:bbs:bbs");
  });
});

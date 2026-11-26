// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0

/**
 * Entry point for `npm run setup -- [--domain <name>] [--handle <name>]
 * [--dry-run] [--rotate-admin-token] [--change-hosts] [--link-cli] [--json]`. Wires the real effects into
 * `runSetup`; the logic and its tests live in setup.ts.
 */

import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { configPath, run as bbs } from "../../packages/cli/src/main.ts";
import { parseArgs } from "./args.ts";
import { EXIT, runSetup, type Deps, type RunResult, type WhoamiResult } from "./setup.ts";

function realRun(cmd: string, args: readonly string[], opts: { stdin?: string; cwd: string }): Promise<RunResult> {
  return new Promise((resolveRun) => {
    // An argument array, never a shell string; stdin carries secrets.
    const child = spawn(cmd, [...args], { cwd: opts.cwd, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", (err) => resolveRun({ code: 127, stdout, stderr: `${stderr}${err.message}` }));
    child.on("close", (code) => resolveRun({ code: code ?? 1, stdout, stderr }));
    child.stdin.on("error", () => undefined);
    child.stdin.end(opts.stdin ?? "");
  });
}

async function realWhoami(path: string): Promise<WhoamiResult> {
  let out = "";
  const code = await bbs(["whoami"], { ...process.env, BBS_CONFIG: path, BBS_URL: "", BBS_TOKEN: "" }, {
    out: (t) => (out += t),
    err: () => undefined,
  });
  try {
    return { code, value: JSON.parse(out) as WhoamiResult["value"] & object };
  } catch {
    return { code };
  }
}

/** HEAD, plus `-dirty` when tracked files differ from it; undefined without git or a repository. */
async function realGitCommit(cwd: string): Promise<string | undefined> {
  const head = await realRun("git", ["rev-parse", "HEAD"], { cwd });
  const hash = head.stdout.trim();
  if (head.code !== 0 || !/^[0-9a-f]{40,64}$/.test(hash)) return undefined;
  const status = await realRun("git", ["status", "--porcelain", "--untracked-files=no"], { cwd });
  if (status.code !== 0) return undefined;
  return status.stdout.trim() === "" ? hash : `${hash}-dirty`;
}

const repoRoot = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), "../.."));

/**
 * Where `name` resolves on the PATH, as a real path. `npm run` puts every
 * `node_modules/.bin` on the PATH it hands its scripts, which would make the
 * checkout's own `bbs` look installed; those entries are skipped.
 */
function realResolve(name: string): string | undefined {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (dir === "" || dir.endsWith(`${join("node_modules", ".bin")}`)) continue;
    const candidate = join(dir, name);
    if (!existsSync(candidate)) continue;
    try {
      return realpathSync(candidate);
    } catch {
      // A dangling link: keep looking.
    }
  }
  return undefined;
}
const parsed = parseArgs(process.argv.slice(2));
if (typeof parsed === "string") {
  process.stderr.write(`setup: ${parsed}\n`);
  process.exit(EXIT.usage);
}

const toStderr = parsed.json;
const deps: Deps = {
  run: realRun,
  fetch: (url) => fetch(url, { signal: AbortSignal.timeout(10_000) }),
  fs: {
    readText: (p) => {
      try {
        return readFileSync(p, "utf8");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw err;
      }
    },
    writeText: (p, text, mode = 0o644) => {
      mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
      writeFileSync(p, text, { mode });
      chmodSync(p, mode);
    },
  },
  random: (n) => randomBytes(n),
  log: (line) => (toStderr ? process.stderr : process.stdout).write(`${line}\n`),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => Date.now(),
  whoami: realWhoami,
  gitCommit: realGitCommit,
  resolveCommand: realResolve,
};

const outcome = await runSetup(
  {
    ...(parsed.domain === undefined ? {} : { domain: parsed.domain }),
    handle: parsed.handle,
    dryRun: parsed.dryRun,
    rotateAdminToken: parsed.rotateAdminToken,
    changeHosts: parsed.changeHosts,
    linkCli: parsed.linkCli,
    ...(parsed.requireApproval ? { requireApproval: true } : {}),
    ...(parsed.approverAllowSynced ? { approverAllowSynced: true } : {}),
    repoRoot,
    cliConfigPath: configPath(process.env),
  },
  deps,
);
if (parsed.json) process.stdout.write(`${JSON.stringify(outcome.summary, null, 2)}\n`);
process.exitCode = outcome.code;

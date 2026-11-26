// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { generateConfig, renderConfig } from "../config.ts";
import { parseJsonc } from "../jsonc.ts";
import { BUCKET, EXIT, parseBucketNames, parseWorkersDevUrl, runSetup, sha256Hex, type Deps, type Options, type RunResult } from "../setup.ts";

const ROOT = "/repo";
const CLI_CONFIG = "/cfg/bbs/config.json";
const CHECKED_IN = readFileSync(new URL("../../../packages/worker/wrangler.jsonc", import.meta.url), "utf8");
const DEPLOY_OUT = "Uploaded bbs-5000\nDeployed bbs-5000 triggers\n  https://bbs-5000.some-account.workers.dev\n";
const OK: RunResult = { code: 0, stdout: "", stderr: "" };
const marker = (build?: string): string => JSON.stringify({ ok: true, service: "bbs-5000", ...(build === undefined ? {} : { build }) });
const LIST_WITH = `name:           ${BUCKET}\ncreation_date:  2026-11-21\n`;

interface Call {
  cmd: string;
  args: string[];
  stdin: string | undefined;
}

interface World {
  deps: Deps;
  calls: Call[];
  logs: string[];
  writes: { path: string; text: string; mode: number | undefined }[];
  files: Map<string, string>;
  fetches: string[];
  clock: { t: number };
  sleeps: number[];
}

interface Script {
  signedIn?: boolean;
  buckets?: string;
  listFail?: RunResult;
  createFail?: RunResult;
  deploy?: RunResult;
  /** `build` is the id setup wrote into the generated config before the deploy. */
  health?: (ctx: { build: string; polls: number }) => { status: number; body: string };
  whoami?: (configText: string | undefined) => { code: number; value?: Record<string, unknown> };
  files?: Record<string, string>;
  secrets?: string;
  secretsFail?: RunResult;
  /** What the git calls give: the commit (default a clean one), or undefined for no git. */
  commit?: string | undefined;
  /** Where `bbs` resolves on the PATH before setup runs (default: nowhere). */
  bbsPath?: string;
  /** What `npm link` returns (default: success, which puts `bbs` on the PATH). */
  link?: RunResult;
  /** Whether a successful `npm link` makes `bbs` resolve to this checkout (default true). */
  linkOnPath?: boolean;
}

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const CLI_BIN = `${ROOT}/packages/cli/bin/bbs.js`;

function world(script: Script = {}): World {
  const files = new Map<string, string>([[`${ROOT}/packages/worker/wrangler.jsonc`, CHECKED_IN], ...Object.entries(script.files ?? {})]);
  const calls: Call[] = [];
  const logs: string[] = [];
  const writes: World["writes"] = [];
  const fetches: string[] = [];
  const sleeps: number[] = [];
  const clock = { t: 1000 };
  let bbsPath = script.bbsPath;
  const deps: Deps = {
    async run(cmd, args, { stdin }) {
      calls.push({ cmd, args: [...args], stdin });
      if (cmd === "npm") {
        const r = script.link ?? OK;
        if (r.code === 0 && script.linkOnPath !== false) bbsPath = CLI_BIN;
        return r;
      }
      const sub = args.slice(2, 5).join(" ");
      if (sub.startsWith("whoami")) return script.signedIn === false ? { code: 1, stdout: "", stderr: "not authenticated" } : OK;
      if (sub.startsWith("r2 bucket list")) return script.listFail ?? { ...OK, stdout: script.buckets ?? "" };
      if (sub.startsWith("r2 bucket create")) return script.createFail ?? OK;
      if (sub.startsWith("deploy")) return script.deploy ?? { ...OK, stdout: DEPLOY_OUT };
      if (sub.startsWith("secret list")) return script.secretsFail ?? { ...OK, stdout: script.secrets ?? "[]" };
      if (sub.startsWith("secret bulk")) return OK;
      throw new Error(`unexpected command ${args.join(" ")}`);
    },
    async fetch(url) {
      fetches.push(url);
      const deployed = files.get(`${ROOT}/packages/worker/wrangler.deploy.jsonc`);
      const build = deployed === undefined ? "" : String((parseJsonc(deployed).vars as { BBS_BUILD_ID?: string }).BBS_BUILD_ID);
      const r = (script.health ?? ((c) => ({ status: 200, body: marker(c.build) })))({ build, polls: fetches.length });
      return { status: r.status, text: async () => r.body };
    },
    fs: {
      readText: (p) => files.get(p),
      writeText: (path, text, mode) => {
        writes.push({ path, text, mode });
        files.set(path, text);
      },
    },
    random: (n) => new Uint8Array(n).fill(7),
    log: (l) => logs.push(l),
    sleep: async (ms) => {
      sleeps.push(ms);
      clock.t += ms;
    },
    now: () => clock.t,
    gitCommit: async () => ("commit" in script ? script.commit : COMMIT),
    resolveCommand: (name) => (name === "bbs" ? bbsPath : undefined),
    async whoami() {
      const r = (script.whoami ?? (() => ({ code: 0, value: { handle: "admin", kind: "human", admin: true } })))(files.get(CLI_CONFIG));
      return r;
    },
  };
  return { deps, calls, logs, writes, files, fetches, clock, sleeps };
}

const opts = (o: Partial<Options> = {}): Options => ({
  handle: "admin",
  dryRun: false,
  rotateAdminToken: false,
  changeHosts: false,
  linkCli: false,
  repoRoot: ROOT,
  cliConfigPath: CLI_CONFIG,
  ...o,
});

const sub = (c: Call): string => c.args.slice(2).join(" ");
const savedToken = (w: World): string => (JSON.parse(w.files.get(CLI_CONFIG) as string) as { token: string }).token;

describe("setup: a fresh run", () => {
  it("domain mode runs the steps in order and ends with the pairing instructions", async () => {
    const w = world();
    const r = await runSetup(opts({ domain: "example.com" }), w.deps);
    expect(r.code).toBe(EXIT.ok);
    expect(w.calls.map(sub)).toEqual([
      "whoami --json",
      "r2 bucket list",
      `r2 bucket create ${BUCKET}`,
      "deploy -c packages/worker/wrangler.deploy.jsonc",
      "secret list -c packages/worker/wrangler.deploy.jsonc --format json",
      "secret bulk -c packages/worker/wrangler.deploy.jsonc",
    ]);
    expect(w.calls.every((c) => c.cmd === "npx" && c.args[0] === "--no-install" && c.args[1] === "wrangler")).toBe(true);
    const gen = parseJsonc(w.files.get(`${ROOT}/packages/worker/wrangler.deploy.jsonc`) as string);
    expect((gen.routes as { pattern: string }[]).map((x) => x.pattern)).toEqual(["app.example.com", "api.example.com"]);
    expect(JSON.parse(w.files.get(CLI_CONFIG) as string).url).toBe("https://api.example.com");
    expect(w.fetches).toEqual(["https://api.example.com/health"]);
    const text = w.logs.join("\n");
    expect(text).toContain("https://app.example.com");
    expect(text).toContain("web-login");
    expect(text).toContain("Cloudflare Access");
    expect(r.summary).toMatchObject({ web_url: "https://app.example.com", api_url: "https://api.example.com", bucket_created: true, token: "created" });
  });

  it("no-domain mode takes the workers.dev URL from the deploy output for both hosts", async () => {
    const w = world();
    const r = await runSetup(opts(), w.deps);
    expect(r.code).toBe(EXIT.ok);
    const gen = parseJsonc(w.files.get(`${ROOT}/packages/worker/wrangler.deploy.jsonc`) as string);
    expect(gen.routes).toBeUndefined();
    expect(gen.workers_dev).toBe(true);
    expect(JSON.parse(w.files.get(CLI_CONFIG) as string).url).toBe("https://bbs-5000.some-account.workers.dev");
    expect(w.fetches).toEqual(["https://bbs-5000.some-account.workers.dev/health"]);
    expect(w.logs.join("\n")).not.toContain("Cloudflare Access");
  });

  it("fails clearly when the deploy output has no workers.dev address", async () => {
    const w = world({ deploy: { ...OK, stdout: "Deployed bbs-5000\n" } });
    const r = await runSetup(opts(), w.deps);
    expect(r.code).toBe(EXIT.failed);
    expect(w.logs.join("\n")).toMatch(/no workers\.dev address/);
    expect(w.calls.some((c) => sub(c).startsWith("secret"))).toBe(false);
    expect(w.files.has(CLI_CONFIG)).toBe(false);
  });

  it("writes the CLI config with mode 600 and sends the secrets on standard input only", async () => {
    const w = world();
    await runSetup(opts({ domain: "example.com", handle: "ann" }), w.deps);
    expect(w.writes.find((x) => x.path === CLI_CONFIG)?.mode).toBe(0o600);
    const token = savedToken(w);
    expect(token).toMatch(/^bbs_[A-Za-z0-9_-]{43}$/);
    const put = w.calls.find((c) => sub(c).startsWith("secret bulk")) as Call;
    expect(JSON.parse(put.stdin as string)).toEqual({ BBS_HUMAN_HANDLE: "ann", BBS_HUMAN_TOKEN_SHA256: sha256Hex(token) });
    expect(put.args.join(" ")).not.toContain("ann");
  });

  it("never lets the token reach a log line, an argument array, a fetch URL or a file but the CLI config", async () => {
    const w = world();
    await runSetup(opts({ domain: "example.com" }), w.deps);
    const token = savedToken(w);
    expect(w.logs.join("\n")).not.toContain(token);
    expect(w.calls.some((c) => c.args.join(" ").includes(token))).toBe(false);
    expect(w.calls.some((c) => (c.stdin ?? "").includes(token))).toBe(false);
    expect(w.fetches.join(" ")).not.toContain(token);
    expect(w.writes.filter((x) => x.text.includes(token)).map((x) => x.path)).toEqual([CLI_CONFIG]);
  });
});

describe("setup: stops before changing anything", () => {
  it("when wrangler is not signed in", async () => {
    const w = world({ signedIn: false });
    const r = await runSetup(opts({ domain: "example.com" }), w.deps);
    expect(r.code).toBe(EXIT.auth);
    expect(w.calls.map(sub)).toEqual(["whoami --json"]);
    expect(w.writes).toEqual([]);
    expect(w.logs.join("\n")).toContain("npx wrangler login");
  });

  it("with a bad domain or handle, before running anything", async () => {
    for (const o of [opts({ domain: "https://example.com" }), opts({ handle: "system" })]) {
      const w = world();
      const r = await runSetup(o, w.deps);
      expect(r.code).toBe(EXIT.usage);
      expect(w.calls).toEqual([]);
    }
  });

  it("when R2 is not enabled, saying to enable it and run again", async () => {
    const w = world({ listFail: { code: 1, stdout: "", stderr: "Please enable R2 through the Cloudflare Dashboard. [code: 10042]" } });
    const r = await runSetup(opts({ domain: "example.com" }), w.deps);
    expect(r.code).toBe(EXIT.precondition);
    expect(w.logs.join("\n")).toMatch(/Enable R2 in the dashboard.*run setup again/);
    expect(w.writes).toEqual([]);
    expect(w.calls.some((c) => sub(c).startsWith("deploy"))).toBe(false);
  });
});

describe("setup: running it twice", () => {
  it("creates the bucket only when it is missing", async () => {
    const w = world({ buckets: LIST_WITH });
    await runSetup(opts({ domain: "example.com" }), w.deps);
    expect(w.calls.some((c) => sub(c).startsWith("r2 bucket create"))).toBe(false);
    expect(parseBucketNames(`name: other\nname: ${BUCKET}\n`)).toContain(BUCKET);
    expect(parseBucketNames("name: bbs-5000-cold-old\n")).not.toContain(BUCKET);
  });

  it("reuses the saved token for the same API URL and does not rewrite the CLI config", async () => {
    const w = world({ buckets: LIST_WITH, files: { [CLI_CONFIG]: JSON.stringify({ url: "https://api.example.com/", token: "bbs_saved" }) } });
    const r = await runSetup(opts({ domain: "example.com" }), w.deps);
    expect(r.code).toBe(EXIT.ok);
    expect(r.summary.token).toBe("reused");
    expect(w.writes.some((x) => x.path === CLI_CONFIG)).toBe(false);
    const put = w.calls.find((c) => sub(c).startsWith("secret bulk")) as Call;
    expect(JSON.parse(put.stdin as string).BBS_HUMAN_TOKEN_SHA256).toBe(sha256Hex("bbs_saved"));
  });

  it("--rotate-admin-token replaces it", async () => {
    const w = world({ files: { [CLI_CONFIG]: JSON.stringify({ url: "https://api.example.com", token: "bbs_saved" }) } });
    const r = await runSetup(opts({ domain: "example.com", rotateAdminToken: true }), w.deps);
    expect(r.summary.token).toBe("rotated");
    expect(savedToken(w)).not.toBe("bbs_saved");
    const put = w.calls.find((c) => sub(c).startsWith("secret bulk")) as Call;
    expect(JSON.parse(put.stdin as string).BBS_HUMAN_TOKEN_SHA256).toBe(sha256Hex(savedToken(w)));
  });

  it("copies a config for another URL aside, mode 600, before writing the new one", async () => {
    const old = JSON.stringify({ url: "https://api.other.example", token: "bbs_other" });
    const w = world({ files: { [CLI_CONFIG]: old } });
    await runSetup(opts({ domain: "example.com" }), w.deps);
    const backup = w.writes.find((x) => x.path.startsWith(`${CLI_CONFIG}.bak-`));
    expect(backup).toMatchObject({ text: old, mode: 0o600 });
    expect(w.writes.findIndex((x) => x === backup)).toBeLessThan(w.writes.findIndex((x) => x.path === CLI_CONFIG));
    expect(w.logs.join("\n")).toMatch(/no token for this board; copied it to/);
    expect(JSON.parse(w.files.get(CLI_CONFIG) as string).url).toBe("https://api.example.com");
  });

  it("also backs up a config that is not valid JSON", async () => {
    const w = world({ files: { [CLI_CONFIG]: "not json" } });
    await runSetup(opts({ domain: "example.com" }), w.deps);
    expect(w.writes.some((x) => x.path.includes(".bak-") && x.text === "not json")).toBe(true);
  });
});

const ADMIN_LISTED = JSON.stringify([{ name: "BBS_HUMAN_HANDLE", type: "secret_text" }, { name: "BBS_HUMAN_TOKEN_SHA256", type: "secret_text" }]);
const SAVED = { [CLI_CONFIG]: JSON.stringify({ url: "https://api.example.com", token: "bbs_saved" }) };
/** A stop during admin validation: the deploy ran, no secret or CLI credential was written, and the message says both. */
function expectDeployedAdminUnchanged(w: World): void {
  expect(w.calls.some((c) => sub(c).startsWith("deploy"))).toBe(true);
  expect(noBulk(w)).toBe(true);
  expect(w.writes.some((x) => x.path === CLI_CONFIG || x.path.includes(".bak-"))).toBe(false);
  const text = w.logs.join("\n");
  expect(text).toContain("The Worker was already deployed");
  expect(text).toContain("the admin credentials were not changed");
  expect(text).not.toMatch(/nothing was changed|Nothing about/i);
}

const noBulk = (w: World): boolean => !w.calls.some((c) => sub(c).startsWith("secret bulk"));

describe("setup: a board that already has an admin", () => {
  it("with no saved token: stops, changing nothing (no secrets, no config write)", async () => {
    const w = world({ secrets: ADMIN_LISTED });
    const r = await runSetup(opts({ domain: "example.com" }), w.deps);
    expect(r.code).toBe(EXIT.precondition);
    expect(noBulk(w)).toBe(true);
    expect(w.writes.some((x) => x.path === CLI_CONFIG || x.path.includes(".bak-"))).toBe(false);
    expect(w.logs.join("\n")).toMatch(/already has an admin.*--rotate-admin-token/);
    expectDeployedAdminUnchanged(w);
  });

  it("with no saved token for this URL but a config for another: still changes nothing", async () => {
    const w = world({ secrets: ADMIN_LISTED, files: { [CLI_CONFIG]: JSON.stringify({ url: "https://api.other.example", token: "bbs_o" }) } });
    expect((await runSetup(opts({ domain: "example.com" }), w.deps)).code).toBe(EXIT.precondition);
    expectDeployedAdminUnchanged(w);
  });

  it("with a saved token that whoami confirms for the same handle: sets no secrets", async () => {
    const w = world({ secrets: ADMIN_LISTED, files: SAVED });
    const r = await runSetup(opts({ domain: "example.com" }), w.deps);
    expect(r.code).toBe(EXIT.ok);
    expect(noBulk(w)).toBe(true);
    expect(w.writes.some((x) => x.path === CLI_CONFIG)).toBe(false);
    expect(r.summary.token).toBe("kept");
    expect(w.fetches).toHaveLength(1);
  });

  it("with a different handle on the board: stops with a usage exit before any write", async () => {
    const w = world({ secrets: ADMIN_LISTED, files: SAVED, whoami: () => ({ code: 0, value: { handle: "boss", kind: "human", admin: true } }) });
    const r = await runSetup(opts({ domain: "example.com", handle: "admin" }), w.deps);
    expect(r.code).toBe(EXIT.usage);
    expect(noBulk(w)).toBe(true);
    expect(w.writes.some((x) => x.path === CLI_CONFIG)).toBe(false);
    const text = w.logs.join("\n");
    expect(text).toContain("`--handle boss` keeps it");
    expect(text).toContain("--rotate-admin-token together with the new handle");
    expectDeployedAdminUnchanged(w);
  });

  it("with a saved token the board refuses: stops, saying to rotate", async () => {
    const w = world({ secrets: ADMIN_LISTED, files: SAVED, whoami: () => ({ code: 10 }) });
    const r = await runSetup(opts({ domain: "example.com" }), w.deps);
    expect(r.code).toBe(EXIT.auth);
    expect(noBulk(w)).toBe(true);
    expect(w.logs.join("\n")).toMatch(/does not match.*--rotate-admin-token/);
    expectDeployedAdminUnchanged(w);
  });

  it("--rotate-admin-token makes a new token and sets both secrets, even with a different handle", async () => {
    const w = world({ secrets: ADMIN_LISTED, files: SAVED, whoami: () => ({ code: 0, value: { handle: "newboss", kind: "human", admin: true } }) });
    const r = await runSetup(opts({ domain: "example.com", rotateAdminToken: true, handle: "newboss" }), w.deps);
    expect(r.code).toBe(EXIT.ok);
    expect(r.summary.token).toBe("rotated");
    const put = w.calls.find((c) => sub(c).startsWith("secret bulk")) as Call;
    expect(JSON.parse(put.stdin as string)).toEqual({ BBS_HUMAN_HANDLE: "newboss", BBS_HUMAN_TOKEN_SHA256: sha256Hex(savedToken(w)) });
    expect(savedToken(w)).not.toBe("bbs_saved");
  });

  it("stops when the secret list call fails or is unreadable, before touching the admin", async () => {
    for (const w of [world({ secretsFail: { code: 1, stdout: "", stderr: "boom" } }), world({ secrets: "not json" })]) {
      const r = await runSetup(opts({ domain: "example.com" }), w.deps);
      expect(r.code).toBe(EXIT.failed);
      expectDeployedAdminUnchanged(w);
    }
  });

  it("with a saved token whoami cannot confirm (generic failure): says deployed, admin unchanged", async () => {
    const w = world({ secrets: ADMIN_LISTED, files: SAVED, whoami: () => ({ code: 4 }) });
    const r = await runSetup(opts({ domain: "example.com" }), w.deps);
    expect(r.code).toBe(EXIT.failed);
    expect(w.logs.join("\n")).toMatch(/could not confirm the saved token.*exit 4/);
    expectDeployedAdminUnchanged(w);
  });

  it("a board with other secrets but no admin is a fresh install", async () => {
    const w = world({ secrets: JSON.stringify([{ name: "BBS_AUDIT_GCS_KEY", type: "secret_text" }]) });
    expect((await runSetup(opts({ domain: "example.com" }), w.deps)).summary.token).toBe("created");
    expect(noBulk(w)).toBe(false);
  });
});

describe("setup: hostnames of an earlier deploy", () => {
  const GEN = `${ROOT}/packages/worker/wrangler.deploy.jsonc`;
  const earlier = (domain: string | undefined): string => renderConfig(generateConfig(CHECKED_IN, domain));

  it("refuses a different domain, a switch to or from workers.dev, before the deploy call", async () => {
    for (const [was, want] of [["old.example", "example.com"], [undefined, "example.com"], ["example.com", undefined]] as const) {
      const w = world({ files: { [GEN]: earlier(was) } });
      const r = await runSetup(opts(want === undefined ? {} : { domain: want }), w.deps);
      expect(r.code, `${was} -> ${want}`).toBe(EXIT.usage);
      expect(w.calls.some((c) => sub(c).startsWith("deploy"))).toBe(false);
      expect(w.writes).toEqual([]);
      expect(w.logs.join("\n")).toContain("--change-hosts");
    }
  });

  it("allows the change with --change-hosts", async () => {
    const w = world({ files: { [GEN]: earlier("old.example") } });
    const r = await runSetup(opts({ domain: "example.com", changeHosts: true }), w.deps);
    expect(r.code).toBe(EXIT.ok);
    expect(w.calls.some((c) => sub(c).startsWith("deploy"))).toBe(true);
  });

  it("proceeds when mode and domain are the same", async () => {
    const w = world({ files: { [GEN]: earlier("example.com") } });
    expect((await runSetup(opts({ domain: "example.com" }), w.deps)).code).toBe(EXIT.ok);
  });

  it("says the mode, and warns in no-domain mode when there is no local record", async () => {
    const w = world();
    await runSetup(opts(), w.deps);
    expect(w.logs.join("\n")).toMatch(/Mode: workers\.dev.*\n.*custom domains, this deploy removes them/);
  });

  it("refuses an unreadable earlier config without --change-hosts", async () => {
    const w = world({ files: { [GEN]: "garbage" } });
    expect((await runSetup(opts({ domain: "example.com" }), w.deps)).code).toBe(EXIT.usage);
  });
});

describe("setup: health checks", () => {
  it("retries until the marker appears", async () => {
    const w = world({ health: (c) => (c.polls < 3 ? { status: 404, body: "" } : { status: 200, body: marker(c.build) }) });
    const r = await runSetup(opts({ domain: "example.com" }), w.deps);
    expect(r.code).toBe(EXIT.ok);
    expect(w.fetches).toHaveLength(3);
    expect(w.sleeps).toHaveLength(2);
  });

  it("writes a fresh 16-hex build id into the generated config, and a different one on the next run", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 2; i++) {
      const w = world();
      w.deps.random = (n) => new Uint8Array(n).fill(i === 0 ? 0xab : 0x12);
      await runSetup(opts({ domain: "example.com" }), w.deps);
      const gen = parseJsonc(w.files.get(`${ROOT}/packages/worker/wrangler.deploy.jsonc`) as string);
      ids.push((gen.vars as { BBS_BUILD_ID: string }).BBS_BUILD_ID);
    }
    expect(ids[0]).toMatch(/^[0-9a-f]{16}$/);
    expect(ids[0]).not.toBe(ids[1]);
  });

  it("writes the checkout's commit beside the build id, with -dirty as given", async () => {
    for (const commit of [COMMIT, `${COMMIT}-dirty`]) {
      const w = world({ commit });
      await runSetup(opts({ domain: "example.com" }), w.deps);
      const gen = parseJsonc(w.files.get(`${ROOT}/packages/worker/wrangler.deploy.jsonc`) as string);
      expect(gen.vars).toMatchObject({ BBS_GIT_COMMIT: commit });
      expect(gen.vars).toHaveProperty("BBS_BUILD_ID");
    }
  });

  it("writes the approval vars when asked, and none on a later run without the flags", async () => {
    const gen = (w: World) => parseJsonc(w.files.get(`${ROOT}/packages/worker/wrangler.deploy.jsonc`) as string);
    const plain = world();
    await runSetup(opts({ domain: "example.com" }), plain.deps);
    expect(gen(plain).vars).not.toHaveProperty("BBS_REQUIRE_APPROVAL");

    const on = world();
    const r = await runSetup(opts({ domain: "example.com", requireApproval: true }), on.deps);
    expect(r.code).toBe(EXIT.ok);
    expect(gen(on).vars).toMatchObject({ BBS_REQUIRE_APPROVAL: "1" });
    expect(gen(on).vars).not.toHaveProperty("BBS_APPROVER_ALLOW_SYNCED");
    expect(on.logs.join("\n")).toContain("Passkey approval is required on this board (device-bound passkeys only)");

    const synced = world();
    await runSetup(opts({ domain: "example.com", requireApproval: true, approverAllowSynced: true }), synced.deps);
    expect(gen(synced).vars).toMatchObject({ BBS_REQUIRE_APPROVAL: "1", BBS_APPROVER_ALLOW_SYNCED: "1" });

    // The generated file is rewritten from the checked-in config every run: no flag, approval off again.
    await runSetup(opts({ domain: "example.com" }), on.deps);
    expect(gen(on).vars).not.toHaveProperty("BBS_REQUIRE_APPROVAL");
  });

  it("refuses --approver-allow-synced without --require-approval, before running anything", async () => {
    const w = world();
    const r = await runSetup(opts({ domain: "example.com", approverAllowSynced: true }), w.deps);
    expect(r.code).toBe(EXIT.usage);
    expect(w.calls).toEqual([]);
  });

  it("warns when --require-approval is combined with --rotate-admin-token", async () => {
    const w = world();
    await runSetup(opts({ domain: "example.com", requireApproval: true, rotateAdminToken: true }), w.deps);
    expect(w.logs.join("\n")).toMatch(/warning: --rotate-admin-token removes every passkey .* without --require-approval/);
    const quiet = world();
    await runSetup(opts({ domain: "example.com", requireApproval: true }), quiet.deps);
    expect(quiet.logs.join("\n")).not.toContain("removes every passkey");
  });

  it("the dry run shows the approval vars it would write", async () => {
    const w = world();
    await runSetup(opts({ domain: "example.com", dryRun: true, requireApproval: true }), w.deps);
    expect(w.logs.join("\n")).toContain('"BBS_REQUIRE_APPROVAL": "1"');
  });

  it("writes no commit var when git is not available", async () => {
    const w = world({ commit: undefined });
    const r = await runSetup(opts({ domain: "example.com" }), w.deps);
    expect(r.code).toBe(EXIT.ok);
    const gen = parseJsonc(w.files.get(`${ROOT}/packages/worker/wrangler.deploy.jsonc`) as string);
    expect(gen.vars).not.toHaveProperty("BBS_GIT_COMMIT");
    expect(gen.vars).toHaveProperty("BBS_BUILD_ID");
  });

  it("passes at once when the new version answers, saying so", async () => {
    const w = world();
    const r = await runSetup(opts({ domain: "example.com" }), w.deps);
    expect(r.code).toBe(EXIT.ok);
    expect(w.fetches).toHaveLength(1);
    expect(w.logs.join("\n")).toMatch(/Health check: .* answered with build [0-9a-f]{16}; the new version is answering/);
  });

  it("waits while the old version answers (with and without a build id), then passes", async () => {
    const w = world({
      health: (c) => {
        if (c.polls === 1) return { status: 200, body: marker() };
        if (c.polls === 2) return { status: 200, body: marker("oldbuild") };
        if (c.polls === 3) return { status: 200, body: marker("oldbuild") };
        return { status: 200, body: marker(c.build) };
      },
    });
    const r = await runSetup(opts({ domain: "example.com" }), w.deps);
    expect(r.code).toBe(EXIT.ok);
    expect(w.fetches).toHaveLength(4);
    expect(w.sleeps).toHaveLength(3);
  });

  it("says the Worker was deployed but the old version still answers, when the budget runs out", async () => {
    const w = world({ health: () => ({ status: 200, body: marker("oldbuild") }) });
    const r = await runSetup(opts({ domain: "example.com" }), w.deps);
    expect(r.code).toBe(EXIT.failed);
    const text = w.logs.join("\n");
    expect(text).toMatch(/Worker was deployed, but the previous version is still answering/);
    expect(text).toContain("usually clears within a minute or two");
    expect(text).toMatch(/curl https:\/\/api\.example\.com\/health.*"build":"[0-9a-f]{16}"/);
    expect(w.clock.t - 1000).toBeGreaterThanOrEqual(120_000);
    expect(w.clock.t - 1000).toBeLessThan(130_000);
    expect(w.calls.some((c) => sub(c).startsWith("deploy"))).toBe(true);
  });

  it("an old version with no build id at all gets the same message", async () => {
    const w = world({ health: () => ({ status: 200, body: marker() }) });
    const r = await runSetup(opts({ domain: "example.com" }), w.deps);
    expect(r.code).toBe(EXIT.failed);
    expect(w.logs.join("\n")).toMatch(/previous version is still answering.*no build id/);
  });

  it("gives up after about two minutes with a clear message when /health is unreachable", async () => {
    const w = world({ health: () => ({ status: 200, body: '{"ok":true,"service":"other"}' }) });
    const r = await runSetup(opts({ domain: "example.com" }), w.deps);
    expect(r.code).toBe(EXIT.unreachable);
    expect(w.logs.join("\n")).toMatch(/did not answer correctly within 120 s/);
    expect(w.clock.t - 1000).toBeGreaterThanOrEqual(120_000);
    expect(w.clock.t - 1000).toBeLessThan(130_000);
  });

  it("fails when whoami does not report the handle as human admin", async () => {
    const w = world({ whoami: () => ({ code: 0, value: { handle: "someone", kind: "human", admin: true } }) });
    const r = await runSetup(opts({ domain: "example.com" }), w.deps);
    expect(r.code).toBe(EXIT.failed);
    expect(w.logs.join("\n")).toContain("did not report admin as human admin");
  });
});

const NPM_LINK = "npm link --workspace packages/cli";
const npmCalls = (w: World): string[] => w.calls.filter((c) => c.cmd === "npm").map((c) => `${c.cmd} ${c.args.join(" ")}`);

describe("setup: the bbs command on the PATH (#57)", () => {
  it("--link-cli runs npm link from the repository root, then uses bbs in the closing text", async () => {
    const w = world();
    const r = await runSetup(opts({ domain: "example.com", linkCli: true }), w.deps);
    expect(r.code).toBe(EXIT.ok);
    expect(npmCalls(w)).toEqual([NPM_LINK]);
    expect(w.calls.find((c) => c.cmd === "npm")?.stdin).toBeUndefined();
    const text = w.logs.join("\n");
    expect(text).toContain("Linked the bbs command");
    expect(text).toContain("Run `bbs web-login <code>`");
    expect(text).not.toContain("node packages/cli/bin/bbs.js");
    expect(r.summary.cli_link).toBe("linked");
  });

  it("--link-cli with a failing npm link warns with the manual command and still succeeds", async () => {
    const w = world({ link: { code: 243, stdout: "", stderr: "npm error code EACCES\nnpm error path /usr/lib/node_modules" } });
    const r = await runSetup(opts({ domain: "example.com", linkCli: true }), w.deps);
    expect(r.code).toBe(EXIT.ok);
    const text = w.logs.join("\n");
    expect(text).toMatch(/Warning: npm link --workspace packages\/cli failed \(exit 243\).*EACCES.*The deploy is done/);
    expect(text).toContain("Run `node packages/cli/bin/bbs.js web-login <code>`");
    expect(r.summary.cli_link).toBe("failed");
  });

  it("--link-cli where the link works but bbs is still not on the PATH warns and uses the node form", async () => {
    const w = world({ linkOnPath: false });
    const r = await runSetup(opts({ domain: "example.com", linkCli: true }), w.deps);
    expect(r.code).toBe(EXIT.ok);
    expect(w.logs.join("\n")).toMatch(/succeeded, but `bbs` still does not resolve.*npm prefix -g/);
    expect(w.logs.join("\n")).toContain("Run `node packages/cli/bin/bbs.js web-login <code>`");
  });

  it("without the flag and bbs not on the PATH: links nothing, prints the link command and the node form", async () => {
    const w = world();
    const r = await runSetup(opts({ domain: "example.com" }), w.deps);
    expect(r.code).toBe(EXIT.ok);
    expect(npmCalls(w)).toEqual([]);
    const text = w.logs.join("\n");
    expect(text).toContain("Run `node packages/cli/bin/bbs.js web-login <code>`");
    expect(text).toContain(`run this once from the repository root: ${NPM_LINK}`);
    expect(text).toContain("`bbs web-login <code>` works from any directory");
  });

  it("with bbs already on the PATH for this checkout: uses bbs and says nothing more, even with --link-cli", async () => {
    for (const linkCli of [false, true]) {
      const w = world({ bbsPath: CLI_BIN });
      const r = await runSetup(opts({ domain: "example.com", linkCli }), w.deps);
      expect(r.code).toBe(EXIT.ok);
      expect(npmCalls(w)).toEqual([]);
      const text = w.logs.join("\n");
      expect(text).toContain("Run `bbs web-login <code>`");
      expect(text).not.toMatch(/npm link|node packages\/cli|PATH/);
      expect(r.summary.cli_link).toBe("already");
    }
  });

  it("a bbs on the PATH that is another program does not count", async () => {
    const w = world({ bbsPath: "/usr/local/lib/node_modules/other/bin/bbs.js" });
    await runSetup(opts({ domain: "example.com" }), w.deps);
    expect(w.logs.join("\n")).toContain("Run `node packages/cli/bin/bbs.js web-login <code>`");
  });

  it("--dry-run lists npm link only when asked, and runs nothing", async () => {
    const w = world();
    await runSetup(opts({ domain: "example.com", dryRun: true, linkCli: true }), w.deps);
    expect(w.logs.join("\n")).toContain(`  ${NPM_LINK}`);
    expect(w.calls).toEqual([]);
    const w2 = world();
    await runSetup(opts({ domain: "example.com", dryRun: true }), w2.deps);
    expect(w2.logs.join("\n")).not.toContain("npm link");
  });
});

describe("setup: --dry-run", () => {
  it("runs nothing, fetches nothing, writes nothing, and shows secrets as [redacted]", async () => {
    const w = world();
    const r = await runSetup(opts({ domain: "example.com", dryRun: true }), w.deps);
    expect(r.code).toBe(EXIT.ok);
    expect(w.calls).toEqual([]);
    expect(w.fetches).toEqual([]);
    expect(w.writes).toEqual([]);
    const text = w.logs.join("\n");
    expect(text).toContain("npx --no-install wrangler deploy -c packages/worker/wrangler.deploy.jsonc");
    expect(text).toContain("[redacted]");
    expect(text).toContain("secret list -c packages/worker/wrangler.deploy.jsonc --format json");
    expect(text).toContain("--change-hosts");
    expect(text).toContain("app.example.com");
    expect(text).not.toMatch(/bbs_[A-Za-z0-9_-]{20,}/);
  });

  it("still validates its input", async () => {
    const w = world();
    expect((await runSetup(opts({ domain: "bad domain", dryRun: true }), w.deps)).code).toBe(EXIT.usage);
  });
});

describe("output parsing", () => {
  it("finds the workers.dev URL, preferring this Worker's own name", () => {
    expect(parseWorkersDevUrl(DEPLOY_OUT)).toBe("https://bbs-5000.some-account.workers.dev");
    expect(parseWorkersDevUrl("see https://x.workers.dev and https://bbs-5000.acct.workers.dev/")).toBe("https://bbs-5000.acct.workers.dev");
    expect(parseWorkersDevUrl("nothing here")).toBeUndefined();
  });
});

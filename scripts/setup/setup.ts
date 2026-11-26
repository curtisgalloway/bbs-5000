// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0

/**
 * `npm run setup`: deploy a new copy of the board to the caller's own
 * Cloudflare account (issue #49). All effects arrive through `Deps`, so the
 * tests run the whole sequence with fakes. Each step checks before it changes
 * anything, so a second run is safe.
 */

import { createHash } from "node:crypto";
import { parseJsonc } from "./jsonc.ts";
import { domainError, domainHosts, generateConfig, handleError, renderConfig, type Hosts } from "./config.ts";

/** Exit codes (cli-conventions bands, as the `bbs` command uses them). */
export const EXIT = { ok: 0, usage: 2, precondition: 3, unreachable: 4, auth: 10, failed: 20 } as const;

export const BUCKET = "bbs-5000-cold";
const WORKER_CONFIG = "packages/worker/wrangler.jsonc";
const CLI_BIN = "packages/cli/bin/bbs.js";
/** From the repository root; `--workspace` links the CLI package's `bin` into npm's global prefix. */
const LINK_ARGS = ["link", "--workspace", "packages/cli"] as const;
const LINK_COMMAND = `npm ${LINK_ARGS.join(" ")}`;
const DEPLOY_CONFIG = "packages/worker/wrangler.deploy.jsonc";
/** Random bytes in a build id (16 hex characters). */
const BUILD_ID_BYTES = 8;
const HEALTH_BUDGET_MS = 120_000;
const HEALTH_EVERY_MS = 5_000;
const WHOAMI_BUDGET_MS = 30_000;

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface SetupFs {
  /** The file's text, or undefined when it does not exist. */
  readText(path: string): string | undefined;
  /** Write a file (creating its directory at mode 700); `mode` applies to the file. */
  writeText(path: string, text: string, mode?: number): void;
}

export interface WhoamiResult {
  code: number;
  value?: { handle?: unknown; kind?: unknown; admin?: unknown };
}

export interface Deps {
  run(cmd: string, args: readonly string[], opts: { stdin?: string; cwd: string }): Promise<RunResult>;
  fetch(url: string): Promise<{ status: number; text(): Promise<string> }>;
  fs: SetupFs;
  random(bytes: number): Uint8Array;
  log(line: string): void;
  sleep(ms: number): Promise<void>;
  now(): number;
  /** `bbs whoami`, run through the CLI's own code path against the config file. */
  whoami(configPath: string): Promise<WhoamiResult>;
  /**
   * The checkout's full commit hash, with `-dirty` after it when tracked files
   * have changes; undefined when git is missing or `repoRoot` is not a repository.
   */
  gitCommit(repoRoot: string): Promise<string | undefined>;
  /** Where `name` resolves on the PATH, as a real path (symlinks followed), or undefined. */
  resolveCommand(name: string): string | undefined;
}

export interface Options {
  domain?: string;
  handle: string;
  dryRun: boolean;
  rotateAdminToken: boolean;
  /** Allow a deploy whose hostnames differ from the existing generated config. */
  changeHosts: boolean;
  /** Run `npm link` for the CLI package so `bbs` is on the PATH. */
  linkCli: boolean;
  /** Require a passkey's approval for the gated human-only actions; written as the var `BBS_REQUIRE_APPROVAL`. */
  requireApproval?: boolean;
  /** Let a passkey that syncs between devices approve too (`BBS_APPROVER_ALLOW_SYNCED`); needs `requireApproval`. */
  approverAllowSynced?: boolean;
  repoRoot: string;
  /** Where the `bbs` CLI keeps its config. */
  cliConfigPath: string;
}

export interface Outcome {
  code: number;
  /** Machine-readable summary (never holds the token). */
  summary: Record<string, unknown>;
}

class StepError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

/** Ends every message of a stop during admin validation, which comes after the deploy step ran. */
const DEPLOYED_ADMIN_UNCHANGED = "The Worker was already deployed; the admin credentials were not changed.";

const wrangler = (...args: string[]): string[] => ["--no-install", "wrangler", ...args];

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

/** The first `workers.dev` URL in deploy output, preferring this Worker's own name. */
export function parseWorkersDevUrl(output: string): string | undefined {
  const all = output.match(/https:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)*\.workers\.dev/gi) ?? [];
  const own = all.find((u) => u.toLowerCase().startsWith("https://bbs-5000."));
  return (own ?? all[0])?.toLowerCase();
}

/** Bucket names in `wrangler r2 bucket list` output (`name: <bucket>` lines, or a JSON array). */
export function parseBucketNames(output: string): string[] {
  const names = [...output.matchAll(/^\s*name:\s*(\S+)\s*$/gim)].map((m) => m[1] as string);
  if (names.length > 0) return names;
  try {
    const parsed: unknown = JSON.parse(output);
    if (Array.isArray(parsed)) {
      return parsed.flatMap((b) => (typeof (b as { name?: unknown })?.name === "string" ? [(b as { name: string }).name] : []));
    }
  } catch {
    // Not JSON: no names.
  }
  return [];
}

const r2Disabled = (r: RunResult): boolean => /10042|enable R2|R2 is not enabled|purchase R2/i.test(`${r.stdout}\n${r.stderr}`);

function parseConfigFile(text: string | undefined): { url?: string; token?: string } | undefined {
  if (text === undefined) return undefined;
  try {
    const v: unknown = JSON.parse(text);
    if (v !== null && typeof v === "object" && !Array.isArray(v)) return v as { url?: string; token?: string };
  } catch {
    // Unreadable: treated as a config for something else (backed up, not lost).
  }
  return {};
}

/** Names in `wrangler secret list --format json` output: an array of `{name, type}`. */
export function parseSecretNames(output: string): string[] | undefined {
  try {
    const v: unknown = JSON.parse(output);
    if (!Array.isArray(v)) return undefined;
    return v.flatMap((e) => (typeof (e as { name?: unknown })?.name === "string" ? [(e as { name: string }).name] : []));
  } catch {
    return undefined;
  }
}

/** What an existing generated config says about hostnames: a domain, "workers.dev", or "unreadable". */
export function previousHosts(text: string): string {
  try {
    const c = parseJsonc(text.replace(/^\s*\/\/.*$/gm, ""));
    const routes = Array.isArray(c.routes) ? (c.routes as { pattern?: unknown }[]) : [];
    const app = routes.map((r) => r.pattern).find((p): p is string => typeof p === "string" && p.startsWith("app."));
    if (app) return app.slice("app.".length);
    if (c.workers_dev === true && routes.length === 0) return "workers.dev";
  } catch {
    // Falls through.
  }
  return "unreadable";
}

/** Refuse a hostname change unless allowed; says what the board is deployed as. Logs the mode. */
function checkHosts(opts: Options, deps: Deps): void {
  const want = opts.domain ?? "workers.dev";
  const text = deps.fs.readText(`${opts.repoRoot}/${DEPLOY_CONFIG}`);
  if (text === undefined) {
    deps.log(`Mode: ${opts.domain ? `domain ${opts.domain}` : "workers.dev (no domain)"}; no earlier ${DEPLOY_CONFIG} on this machine.`);
    if (opts.domain === undefined) {
      deps.log("Note: if a deployment already exists with custom domains, this deploy removes them.");
    }
    return;
  }
  const was = previousHosts(text);
  if (was === want) {
    deps.log(`Mode: ${opts.domain ? `domain ${opts.domain}` : "workers.dev (no domain)"}, same as the earlier deploy.`);
    return;
  }
  if (!opts.changeHosts) {
    throw new StepError(
      EXIT.usage,
      `the earlier deploy from this machine used ${was === "workers.dev" ? "the workers.dev address" : was === "unreadable" ? "an unreadable config" : `the domain ${was}`}; this run asks for ${want === "workers.dev" ? "the workers.dev address" : `the domain ${want}`}. Deploying would change the board's hostnames. Pass --change-hosts to allow it.`,
    );
  }
  deps.log(`Changing hostnames from ${was} to ${want} (--change-hosts).`);
}

/** The approval settings the options ask for; a board redeployed without them has approval off. */
const approvalOf = (opts: Options): { required: boolean; allowSynced: boolean } => ({
  required: opts.requireApproval === true,
  allowSynced: opts.approverAllowSynced === true,
});

const trimSlash = (u: string): string => u.replace(/\/+$/, "");

/** Dry run: say what would happen. Touches nothing but reading the checked-in config. */
function dryRun(opts: Options, deps: Deps): Outcome {
  const { log } = deps;
  const text = deps.fs.readText(`${opts.repoRoot}/${WORKER_CONFIG}`);
  if (text === undefined) throw new StepError(EXIT.failed, `cannot read ${WORKER_CONFIG}`);
  const config = generateConfig(text, opts.domain, "<a fresh random id on every run>", "<the checkout's commit>", approvalOf(opts));
  checkHosts(opts, deps);
  log("setup: dry run; nothing is run, written or contacted.");
  log("");
  log("Commands, run from the repository root:");
  const cmds: [string[], string?][] = [
    [wrangler("whoami", "--json")],
    [wrangler("r2", "bucket", "list")],
    [wrangler("r2", "bucket", "create", BUCKET)],
    [wrangler("deploy", "-c", DEPLOY_CONFIG)],
    [wrangler("secret", "list", "-c", DEPLOY_CONFIG, "--format", "json")],
    [wrangler("secret", "bulk", "-c", DEPLOY_CONFIG), "standard input: {BBS_HUMAN_HANDLE: [redacted], BBS_HUMAN_TOKEN_SHA256: [redacted]}"],
  ];
  if (opts.linkCli) cmds.push([[...LINK_ARGS]]);
  for (const [args, stdin] of cmds) {
    log(`  ${args[0] === "link" ? "npm " : "npx "}${args.join(" ")}${stdin ? `   (${stdin})` : ""}`);
  }
  log("  (the bucket is created only if the list lacks it)");
  log("  Admin rules: a board with no BBS_HUMAN_TOKEN_SHA256 secret is a fresh install (token made, secrets set).");
  log("  A board that has one is left alone: with a saved token for its API URL, `bbs whoami` must show the same handle");
  log("  (secrets are then not set); with no saved token setup stops. --rotate-admin-token replaces the admin on purpose.");
  log("  The hostnames of an earlier generated config are kept unless --change-hosts is given.");
  log("  After the deploy, setup waits for /health to report the build id it wrote (BBS_BUILD_ID), so it");
  log("  knows the new version is the one answering.");
  log("");
  log("Files it would write:");
  log(`  ${DEPLOY_CONFIG}:`);
  for (const line of renderConfig(config).trimEnd().split("\n")) log(`    ${line}`);
  log(`  ${opts.cliConfigPath} (mode 600): {"url": <api URL>, "token": "[redacted]"}`);
  log("  An existing token for the same API URL is reused unless --rotate-admin-token is given;");
  log("  a config for a different URL is copied aside first.");
  log("");
  const hosts = opts.domain === undefined ? undefined : domainHosts(opts.domain);
  log(hosts ? `Web view: ${hosts.web}   API: ${hosts.api}` : "Web view and API: the workers.dev address in the deploy output");
  log(`Admin handle: ${opts.handle}`);
  return { code: EXIT.ok, summary: { dry_run: true, mode: opts.domain ? "domain" : "workers.dev" } };
}

export async function runSetup(opts: Options, deps: Deps): Promise<Outcome> {
  try {
    if (opts.domain !== undefined) {
      const e = domainError(opts.domain);
      if (e) throw new StepError(EXIT.usage, e);
    }
    const he = handleError(opts.handle);
    if (he) throw new StepError(EXIT.usage, he);
    if (opts.approverAllowSynced && !opts.requireApproval) {
      throw new StepError(EXIT.usage, "--approver-allow-synced only means something with --require-approval");
    }
    if (opts.requireApproval && opts.rotateAdminToken) {
      deps.log(
        "setup: warning: --rotate-admin-token removes every passkey of the admin, and the board refuses the gated actions " +
          "until it is deployed again without --require-approval and an approver passkey is registered (then deploy with --require-approval).",
      );
    }
    if (opts.dryRun) return dryRun(opts, deps);
    return await live(opts, deps);
  } catch (err) {
    if (err instanceof StepError) {
      deps.log(`setup: ${err.message}`);
      return { code: err.code, summary: { ok: false, error: err.message } };
    }
    throw err;
  }
}

async function wr(deps: Deps, opts: Options, args: string[], stdin?: string): Promise<RunResult> {
  return deps.run("npx", args, { cwd: opts.repoRoot, ...(stdin === undefined ? {} : { stdin }) });
}

async function live(opts: Options, deps: Deps): Promise<Outcome> {
  const { log } = deps;
  const summary: Record<string, unknown> = { ok: true, mode: opts.domain ? "domain" : "workers.dev", handle: opts.handle };

  // a. Signed in?
  const who = await wr(deps, opts, wrangler("whoami", "--json"));
  if (who.code !== 0) {
    throw new StepError(
      EXIT.auth,
      "wrangler is not signed in to Cloudflare. Run `npx wrangler login` yourself, then run setup again. Setup never signs in for you.",
    );
  }
  log("Cloudflare: signed in.");
  checkHosts(opts, deps);

  // b. Cold-storage bucket.
  const list = await wr(deps, opts, wrangler("r2", "bucket", "list"));
  if (list.code !== 0) {
    if (r2Disabled(list)) {
      throw new StepError(EXIT.precondition, "R2 is not enabled on this Cloudflare account. Enable R2 in the dashboard (R2 Object Storage), then run setup again.");
    }
    throw new StepError(EXIT.failed, `could not list R2 buckets (exit ${list.code}): ${firstLine(list.stderr || list.stdout)}`);
  }
  if (parseBucketNames(list.stdout).includes(BUCKET)) {
    log(`R2 bucket ${BUCKET}: already exists.`);
    summary.bucket_created = false;
  } else {
    const made = await wr(deps, opts, wrangler("r2", "bucket", "create", BUCKET));
    if (made.code !== 0 && !/already exists|10004/i.test(`${made.stdout}\n${made.stderr}`)) {
      if (r2Disabled(made)) {
        throw new StepError(EXIT.precondition, "R2 is not enabled on this Cloudflare account. Enable R2 in the dashboard (R2 Object Storage), then run setup again.");
      }
      throw new StepError(EXIT.failed, `could not create bucket ${BUCKET} (exit ${made.code}): ${firstLine(made.stderr || made.stdout)}`);
    }
    log(`R2 bucket ${BUCKET}: created.`);
    summary.bucket_created = true;
  }

  // c. Generated config.
  const checkedIn = deps.fs.readText(`${opts.repoRoot}/${WORKER_CONFIG}`);
  if (checkedIn === undefined) throw new StepError(EXIT.failed, `cannot read ${WORKER_CONFIG}`);
  const buildId = Buffer.from(deps.random(BUILD_ID_BYTES)).toString("hex");
  const commit = await deps.gitCommit(opts.repoRoot);
  deps.fs.writeText(`${opts.repoRoot}/${DEPLOY_CONFIG}`, renderConfig(generateConfig(checkedIn, opts.domain, buildId, commit, approvalOf(opts))));
  log(`Wrote ${DEPLOY_CONFIG} (build ${buildId}${commit === undefined ? "" : `, commit ${commit}`}).`);
  if (opts.requireApproval) {
    log(
      `Passkey approval is required on this board${opts.approverAllowSynced ? " (synced passkeys may approve too)" : " (device-bound passkeys only)"}. ` +
        "Redeploy without --require-approval to turn it off.",
    );
  }

  // d. Deploy.
  const dep = await wr(deps, opts, wrangler("deploy", "-c", DEPLOY_CONFIG));
  if (dep.code !== 0) {
    throw new StepError(EXIT.failed, `wrangler deploy failed (exit ${dep.code}): ${firstLine(dep.stderr || dep.stdout)}`);
  }
  log("Deployed the Worker.");

  // f (before e, because the CLI config needs the API URL). Where is it?
  let hosts: Hosts;
  if (opts.domain !== undefined) {
    hosts = domainHosts(opts.domain);
  } else {
    const url = parseWorkersDevUrl(`${dep.stdout}\n${dep.stderr}`);
    if (!url) {
      throw new StepError(
        EXIT.failed,
        "the deploy output named no workers.dev address. If this account has no workers.dev subdomain yet, choose one in the Cloudflare dashboard (Workers & Pages), then run setup again.",
      );
    }
    hosts = { web: url, api: url };
  }
  summary.web_url = hosts.web;
  summary.api_url = hosts.api;

  // e. Admin credential. Look at the board before touching its admin.
  const listed = await wr(deps, opts, wrangler("secret", "list", "-c", DEPLOY_CONFIG, "--format", "json"));
  const names = listed.code === 0 ? parseSecretNames(listed.stdout) : undefined;
  if (names === undefined) {
    throw new StepError(EXIT.failed, `could not list the Worker's secrets (exit ${listed.code}): ${firstLine(listed.stderr || listed.stdout)}. ${DEPLOYED_ADMIN_UNCHANGED}`);
  }
  const hasAdmin = names.includes("BBS_HUMAN_TOKEN_SHA256");
  const saved = savedToken(opts, deps, hosts.api);
  let verified = false;
  let token: string | undefined;
  if (opts.rotateAdminToken) {
    token = makeToken(opts, deps, hosts.api);
    summary.token = "rotated";
  } else if (!hasAdmin) {
    if (saved) {
      deps.log(`Admin token: reusing the one in ${opts.cliConfigPath}.`);
      token = saved;
      summary.token = "reused";
    } else {
      token = makeToken(opts, deps, hosts.api);
      summary.token = "created";
    }
  } else if (saved === undefined) {
    throw new StepError(
      EXIT.precondition,
      `this board already has an admin. Run setup from the machine that holds its token, or pass --rotate-admin-token to replace the admin credential (the old token stops working, and a changed handle retires the old admin and their web sessions). ${DEPLOYED_ADMIN_UNCHANGED}`,
    );
  } else {
    const r = await deps.whoami(opts.cliConfigPath);
    if (r.code === 10) {
      throw new StepError(EXIT.auth, `the board has an admin, but the token saved in the bbs config does not match it. --rotate-admin-token replaces the board's admin credential. ${DEPLOYED_ADMIN_UNCHANGED}`);
    }
    const v = r.value;
    if (r.code !== 0 || !v || v.kind !== "human" || v.admin !== true) {
      throw new StepError(EXIT.failed, `could not confirm the saved token against the board (\`bbs whoami\` exit ${r.code}). ${DEPLOYED_ADMIN_UNCHANGED}`);
    }
    if (v.handle !== opts.handle) {
      throw new StepError(
        EXIT.usage,
        `the board's admin is ${String(v.handle)}, not ${opts.handle}. \`--handle ${String(v.handle)}\` keeps it; --rotate-admin-token together with the new handle replaces the admin on purpose. ${DEPLOYED_ADMIN_UNCHANGED}`,
      );
    }
    log(`Admin credential: the saved token already matches ${opts.handle}; secrets left as they are.`);
    summary.token = "kept";
    verified = true;
  }
  if (token !== undefined) {
    const secrets = JSON.stringify({ BBS_HUMAN_HANDLE: opts.handle, BBS_HUMAN_TOKEN_SHA256: sha256Hex(token) });
    const put = await wr(deps, opts, wrangler("secret", "bulk", "-c", DEPLOY_CONFIG), secrets);
    if (put.code !== 0) {
      throw new StepError(EXIT.failed, `could not set the admin secrets (exit ${put.code}): ${firstLine(put.stderr || put.stdout)}. Run setup again; it reuses the token it already saved.`);
    }
    log("Set the Worker secrets BBS_HUMAN_HANDLE and BBS_HUMAN_TOKEN_SHA256.");
  }

  // g. Health, then whoami.
  await waitForHealth(hosts.api, buildId, deps);
  log(`Health check: ${hosts.api}/health answered with build ${buildId}; the new version is answering.`);
  if (!verified) {
    await checkWhoami(opts, deps);
    log(`Signed in as ${opts.handle}: human, admin.`);
  }

  // h. The bbs command, then the next step.
  const bbsCmd = await bbsOnPath(opts, deps, summary);

  log("");
  log("Done. Next:");
  log(`  1. Open ${hosts.web} in a browser; it shows a sign-in code.`);
  log(`  2. Run \`${bbsCmd} web-login <code>\` to approve it.`);
  if (bbsCmd !== "bbs") {
    log(`To get \`bbs\` on your PATH, run this once from the repository root: ${LINK_COMMAND}`);
    log("  From then on, `bbs web-login <code>` works from any directory.");
  }
  if (opts.domain !== undefined) {
    log("Cloudflare Access on the web host is optional; docs/deploy.md (\"Adding Cloudflare Access\") says how to add it by hand.");
  }
  return { code: EXIT.ok, summary };
}

/**
 * Settle whether `bbs` is a command on the PATH that runs this checkout, linking
 * it first when `--link-cli` asks. Never fails setup: the deploy is done by now,
 * so a failed link is a warning with the manual command. Returns the command
 * the closing text should show.
 */
async function bbsOnPath(opts: Options, deps: Deps, summary: Record<string, unknown>): Promise<string> {
  const here = (): boolean => deps.resolveCommand("bbs") === `${opts.repoRoot}/${CLI_BIN}`;
  const fallback = `node ${CLI_BIN}`;
  if (here()) {
    summary.cli_link = "already";
    return "bbs";
  }
  if (!opts.linkCli) {
    summary.cli_link = "not linked";
    return fallback;
  }
  const r = await deps.run("npm", LINK_ARGS, { cwd: opts.repoRoot });
  if (r.code !== 0) {
    summary.cli_link = "failed";
    deps.log(
      `Warning: ${LINK_COMMAND} failed (exit ${r.code}): ${firstLine(r.stderr || r.stdout)}. The deploy is done. To put \`bbs\` on your PATH, fix npm's global prefix permissions (\`npm config get prefix\`) and run ${LINK_COMMAND} from the repository root; until then, use \`${fallback}\`.`,
    );
    return fallback;
  }
  if (here()) {
    summary.cli_link = "linked";
    deps.log("Linked the bbs command: `bbs` now runs this checkout.");
    return "bbs";
  }
  summary.cli_link = "linked, not on PATH";
  deps.log(
    `Warning: ${LINK_COMMAND} succeeded, but \`bbs\` still does not resolve to this checkout on your PATH. Add npm's global bin directory (see \`npm prefix -g\`) to your PATH, or use \`${fallback}\`.`,
  );
  return fallback;
}

const firstLine = (text: string): string => (text.trim().split("\n")[0] ?? "").slice(0, 300);

/** The token in the CLI config when it is for this API URL. */
function savedToken(opts: Options, deps: Deps, apiUrl: string): string | undefined {
  const c = parseConfigFile(deps.fs.readText(opts.cliConfigPath));
  if (typeof c?.url === "string" && trimSlash(c.url) === apiUrl && typeof c.token === "string" && c.token !== "") return c.token;
  return undefined;
}

/** Make a token and save it in the CLI config, copying a config for another URL aside first. */
function makeToken(opts: Options, deps: Deps, apiUrl: string): string {
  const existingText = deps.fs.readText(opts.cliConfigPath);
  const sameUrl = savedToken({ ...opts, rotateAdminToken: false }, deps, apiUrl) !== undefined;
  if (existingText !== undefined && !sameUrl) {
    const backup = `${opts.cliConfigPath}.bak-${deps.now()}`;
    deps.fs.writeText(backup, existingText, 0o600);
    deps.log(`The bbs config at ${opts.cliConfigPath} had no token for this board; copied it to ${backup} before replacing it.`);
  }
  const token = `bbs_${base64url(deps.random(32))}`;
  deps.fs.writeText(opts.cliConfigPath, `${JSON.stringify({ url: apiUrl, token }, null, 2)}\n`, 0o600);
  deps.log(`Admin token: ${sameUrl ? "replaced" : "made"}; saved only in ${opts.cliConfigPath}.`);
  return token;
}

/**
 * Poll `/health` until it carries `buildId`. `/health` answers the same on the
 * old and the new version, so the marker alone proves nothing after a redeploy.
 */
async function waitForHealth(api: string, buildId: string, deps: Deps): Promise<void> {
  const start = deps.now();
  let last = "no answer yet";
  let oldVersion = false;
  for (;;) {
    try {
      const res = await deps.fetch(`${api}/health`);
      const body = await res.text();
      let marker = false;
      let build: unknown;
      try {
        const v = JSON.parse(body) as { ok?: unknown; service?: unknown; build?: unknown };
        marker = res.status === 200 && v.ok === true && v.service === "bbs-5000";
        build = v.build;
      } catch {
        // Not the marker.
      }
      if (marker && build === buildId) return;
      if (marker) {
        oldVersion = true;
        last = typeof build === "string" ? `answering with build ${build}, not ${buildId}` : `answering with no build id, not ${buildId}`;
      } else {
        oldVersion = false;
        last = `HTTP ${res.status}, not the bbs-5000 marker`;
      }
    } catch (err) {
      oldVersion = false;
      last = (err as Error).message;
    }
    if (deps.now() - start >= HEALTH_BUDGET_MS) {
      if (oldVersion) {
        // Exits 20 like the whoami wait: the board answers, so it is not "unreachable".
        throw new StepError(
          EXIT.failed,
          `the Worker was deployed, but the previous version is still answering ${api}/health (${last}) after ${HEALTH_BUDGET_MS / 1000} s. This usually clears within a minute or two. To check, run \`curl ${api}/health\` and look for "build":"${buildId}"; run setup again if it never appears.`,
        );
      }
      throw new StepError(EXIT.unreachable, `${api}/health did not answer correctly within ${HEALTH_BUDGET_MS / 1000} s (${last}). New hostnames can take a few minutes; run setup again to check.`);
    }
    await deps.sleep(HEALTH_EVERY_MS);
  }
}

async function checkWhoami(opts: Options, deps: Deps): Promise<void> {
  const start = deps.now();
  for (;;) {
    const r = await deps.whoami(opts.cliConfigPath);
    const v = r.value;
    if (r.code === 0 && v && v.handle === opts.handle && v.kind === "human" && v.admin === true) return;
    if (deps.now() - start >= WHOAMI_BUDGET_MS) {
      throw new StepError(EXIT.failed, `\`bbs whoami\` did not report ${opts.handle} as human admin (exit ${r.code}). The new secrets may still be taking effect; run setup again to check.`);
    }
    await deps.sleep(HEALTH_EVERY_MS);
  }
}

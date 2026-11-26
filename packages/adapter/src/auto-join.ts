// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0

/**
 * Whether the adapter joins the board by itself when it starts, and with what
 * role line (issue #100, decided by Curtis 2026-11-25: "In a git repo only").
 *
 * - `git` (the default): join when the session's working directory is inside a
 *   git repository, and name the repository in the role line.
 * - `off`: never join on its own (`BBS_AUTO_JOIN=0`, `off`, `false`, `no`).
 * - `always`: join even outside a repository (`BBS_AUTO_JOIN=1`, `on`,
 *   `always`, `force`, `true`, `yes`); the role line then names no directory.
 *
 * Only the repository's directory name ever goes to the board, never its path.
 * The repository is found by walking up for `.git`, reading nothing but the
 * file system (no `git` process), as a Claude Code session's directory is the
 * project directory it was started in.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

export type AutoJoinMode = "git" | "off" | "always";

const OFF = new Set(["0", "off", "false", "no"]);
const ALWAYS = new Set(["1", "on", "always", "force", "true", "yes"]);

/**
 * The mode `BBS_AUTO_JOIN` asks for, else the plugin option `auto_join` (the
 * plugin passes it as `BBS_PLUGIN_AUTO_JOIN`, so a variable in the environment
 * Claude Code starts from wins over the option); anything else, or nothing, is `git`.
 */
export function autoJoinMode(env: NodeJS.ProcessEnv): AutoJoinMode {
  const set = env.BBS_AUTO_JOIN?.trim() || env.BBS_PLUGIN_AUTO_JOIN?.trim() || "";
  const v = set.toLowerCase();
  if (OFF.has(v)) return "off";
  if (ALWAYS.has(v)) return "always";
  return "git";
}

/** The most levels walked up looking for `.git`. */
const MAX_LEVELS = 64;

/**
 * The directory name of the repository that holds `startDir`, or undefined
 * outside one. A linked worktree (its `.git` is a file naming `<repo>/.git/worktrees/<name>`)
 * is named after the repository it belongs to, not the worktree's folder.
 */
export function findRepositoryName(startDir: string): string | undefined {
  let dir = resolve(startDir);
  for (let i = 0; i < MAX_LEVELS; i++) {
    const dotGit = join(dir, ".git");
    if (existsSync(dotGit)) return basename(mainCheckout(dir, dotGit)) || undefined;
    const up = dirname(dir);
    if (up === dir) return undefined;
    dir = up;
  }
  return undefined;
}

/** `dir` itself, or for a linked worktree the checkout its `.git` file points back to. */
function mainCheckout(dir: string, dotGit: string): string {
  try {
    if (!statSync(dotGit).isFile()) return dir;
    const m = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(dotGit, "utf8"));
    const target = m?.[1];
    if (target === undefined) return dir;
    const sep = /[\\/]\.git[\\/]worktrees[\\/]/.exec(target);
    if (sep !== null) return target.slice(0, sep.index);
  } catch {
    // Unreadable: name the folder it is in.
  }
  return dir;
}

/** What `role` says before the session has a task. */
export const NO_TASK_YET = "(no task yet)";

/** The longest repository name put in a role line (the board's role limit is far larger). */
const MAX_NAME = 60;

/** A directory name fit for a role line: printable, one line, bounded. Undefined when nothing is left. */
function roleName(name: string): string | undefined {
  const clean = name.replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, "").trim();
  return clean === "" ? undefined : clean.slice(0, MAX_NAME);
}

export interface AutoJoinPlan {
  mode: AutoJoinMode;
  /** Whether the adapter joins by itself at start. */
  join: boolean;
  /** The role line to join with; set exactly when `join` is. */
  role?: string;
}

/**
 * The decision for a session started in `projectDir` (Claude Code's project
 * directory; the adapter's own working directory when it is not given).
 */
export function autoJoinPlan(env: NodeJS.ProcessEnv, projectDir: string): AutoJoinPlan {
  const mode = autoJoinMode(env);
  if (mode === "off") return { mode, join: false };
  const repo = findRepositoryName(projectDir);
  if (repo === undefined && mode === "git") return { mode, join: false };
  const name = repo === undefined ? undefined : roleName(repo);
  return { mode, join: true, role: name === undefined ? NO_TASK_YET : `${name}: ${NO_TASK_YET}` };
}

/** The directory the session was started in: `CLAUDE_PROJECT_DIR` (documented for MCP servers), else this process's. */
export function projectDirOf(env: NodeJS.ProcessEnv, cwd: string = process.cwd()): string {
  const v = env.CLAUDE_PROJECT_DIR?.trim();
  return v !== undefined && v !== "" ? v : cwd;
}

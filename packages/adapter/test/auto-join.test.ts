// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0

/**
 * Auto-join (issue #100, decided by Curtis 2026-11-25: "In a git repo only"):
 * which sessions join by themselves and with what role line, on real
 * directories.
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { autoJoinMode, autoJoinPlan, findRepositoryName, NO_TASK_YET, projectDirOf } from "../src/auto-join.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "bbs-autojoin-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function repo(name: string): string {
  const dir = join(root, name);
  mkdirSync(join(dir, ".git"), { recursive: true });
  return dir;
}

function plain(name: string): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("finding the repository", () => {
  it("names the directory that holds .git, from the repository itself or any folder below it", () => {
    const dir = repo("widget-app");
    const deep = join(dir, "src", "ui");
    mkdirSync(deep, { recursive: true });
    expect(findRepositoryName(dir)).toBe("widget-app");
    expect(findRepositoryName(deep)).toBe("widget-app");
  });

  it("finds nothing outside a repository", () => {
    // The temporary directory is not inside a git repository on any machine that runs the tests.
    expect(findRepositoryName(plain("just-a-folder"))).toBeUndefined();
  });

  it("names a linked worktree after the repository it belongs to, not the worktree's folder", () => {
    const main = repo("main-checkout");
    mkdirSync(join(main, ".git", "worktrees", "feature-x"), { recursive: true });
    const wt = plain("feature-x");
    writeFileSync(join(wt, ".git"), `gitdir: ${join(main, ".git", "worktrees", "feature-x")}\n`);
    expect(findRepositoryName(wt)).toBe("main-checkout");
  });

  it("treats a .git file it cannot make sense of as the folder's own repository", () => {
    const wt = plain("odd-gitfile");
    writeFileSync(join(wt, ".git"), "not a gitdir line\n");
    expect(findRepositoryName(wt)).toBe("odd-gitfile");
  });
});

describe("the setting", () => {
  it("is git by default and for anything it does not know", () => {
    for (const v of [undefined, "", "git", "GIT", "maybe"]) {
      expect(autoJoinMode(v === undefined ? {} : { BBS_AUTO_JOIN: v })).toBe("git");
    }
  });

  it("turns off with 0, off, false or no, and forces on with 1, on, always, force, true or yes", () => {
    for (const v of ["0", "off", "OFF", "false", "no", " 0 "]) expect(autoJoinMode({ BBS_AUTO_JOIN: v })).toBe("off");
    for (const v of ["1", "on", "always", "force", "true", "yes", "ALWAYS"]) expect(autoJoinMode({ BBS_AUTO_JOIN: v })).toBe("always");
  });
});

describe("the plugin option", () => {
  it("is read from BBS_PLUGIN_AUTO_JOIN, and a BBS_AUTO_JOIN in the environment wins over it", () => {
    expect(autoJoinMode({ BBS_PLUGIN_AUTO_JOIN: "off" })).toBe("off");
    expect(autoJoinMode({ BBS_PLUGIN_AUTO_JOIN: "always" })).toBe("always");
    expect(autoJoinMode({ BBS_PLUGIN_AUTO_JOIN: "git" })).toBe("git");
    expect(autoJoinMode({ BBS_PLUGIN_AUTO_JOIN: "off", BBS_AUTO_JOIN: "1" })).toBe("always");
    expect(autoJoinMode({ BBS_PLUGIN_AUTO_JOIN: "off", BBS_AUTO_JOIN: "" })).toBe("off");
  });
});

describe("the plan for a session", () => {
  it("joins in a repository with a role line that names the repository and no path", () => {
    const dir = repo("gizmo");
    const plan = autoJoinPlan({}, join(dir, "packages"));
    expect(plan).toEqual({ mode: "git", join: true, role: `gizmo: ${NO_TASK_YET}` });
    expect(plan.role).toBe("gizmo: (no task yet)");
    expect(plan.role).not.toContain(root);
    expect(plan.role).not.toContain("/");
  });

  it("does not join outside a repository", () => {
    expect(autoJoinPlan({}, plain("no-repo-here"))).toEqual({ mode: "git", join: false });
  });

  it("off never joins, even in a repository", () => {
    expect(autoJoinPlan({ BBS_AUTO_JOIN: "0" }, repo("quiet"))).toEqual({ mode: "off", join: false });
  });

  it("always joins outside a repository too, with a role line that names no directory", () => {
    const dir = plain("anywhere-at-all");
    const plan = autoJoinPlan({ BBS_AUTO_JOIN: "always" }, dir);
    expect(plan).toEqual({ mode: "always", join: true, role: NO_TASK_YET });
    expect(plan.role).not.toContain("anywhere");
    // Inside a repository it still names it.
    expect(autoJoinPlan({ BBS_AUTO_JOIN: "1" }, repo("named")).role).toBe("named: (no task yet)");
  });

  it("strips control characters from the name and bounds its length", () => {
    const dir = repo("tab\there\u202e");
    expect(autoJoinPlan({}, dir).role).toBe("tabhere: (no task yet)");
    const long = repo("x".repeat(200));
    expect(autoJoinPlan({}, long).role).toBe(`${"x".repeat(60)}: (no task yet)`);
  });

  it("starts from CLAUDE_PROJECT_DIR when Claude Code gives it, else the process's own directory", () => {
    expect(projectDirOf({ CLAUDE_PROJECT_DIR: "/some/project" }, "/elsewhere")).toBe("/some/project");
    expect(projectDirOf({ CLAUDE_PROJECT_DIR: "  " }, "/elsewhere")).toBe("/elsewhere");
    expect(projectDirOf({}, "/elsewhere")).toBe("/elsewhere");
  });
});

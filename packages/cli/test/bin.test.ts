// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0

// `npm link` puts a symlink to bin/bbs.js on the PATH, so the command must
// start, and find its own modules, through a symlink from another directory.

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const BIN = fileURLToPath(new URL("../bin/bbs.js", import.meta.url));
let dir: string | undefined;

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

describe("bin/bbs.js", () => {
  it("has a node shebang and the executable bit", () => {
    expect(readFileSync(BIN, "utf8").startsWith("#!/usr/bin/env node\n")).toBe(true);
    expect(statSync(BIN).mode & 0o111).not.toBe(0);
  });

  it("runs through a symlink from another directory", () => {
    dir = mkdtempSync(join(tmpdir(), "bbs-link-"));
    const link = join(dir, "bbs");
    symlinkSync(BIN, link);
    const r = spawnSync(process.execPath, [link, "--help"], { cwd: dir, encoding: "utf8", env: { ...process.env, BBS_CONFIG: join(dir, "none.json") } });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("BBS-5000 board client");
  });
});

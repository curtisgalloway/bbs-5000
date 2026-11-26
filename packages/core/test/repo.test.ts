// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0

/**
 * Repository conventions that no other test checked (F traceability):
 * every source file carries the two-line SPDX header (Q2, decided by Curtis:
 * Apache 2.0 with SPDX headers; AGENTS.md "Code rules").
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const SOURCE_DIRS = ["packages", "test", "scripts", ".github"];
const SOURCE_EXT = new Set([".ts", ".js", ".mjs", ".cjs", ".css", ".html", ".jsonc", ".yml", ".yaml", ".sh"]);
const SKIP = new Set(["node_modules", ".wrangler", "coverage", "dist"]);

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (SOURCE_EXT.has(extname(name)) || name === "_headers" || name === ".dev.vars.example") out.push(p);
  }
}

describe("SPDX headers (Q2)", () => {
  it("every source file names the copyright holder and the Apache-2.0 license near its top", () => {
    const files: string[] = [];
    for (const d of SOURCE_DIRS) walk(join(ROOT, d), files);
    expect(files.length).toBeGreaterThan(80);
    const missing = files.filter((f) => {
      const head = readFileSync(f, "utf8").split("\n").slice(0, 6).join("\n");
      return !head.includes("SPDX-FileCopyrightText: 2026 Curtis Galloway") || !head.includes("SPDX-License-Identifier: Apache-2.0");
    });
    expect(missing.map((f) => relative(ROOT, f))).toEqual([]);
  });
});

describe("public-repository rule (decided by Curtis: no private details in the repo)", () => {
  it("no tracked text file holds a home-directory path or a private LAN address", () => {
    const files: string[] = [];
    for (const d of [...SOURCE_DIRS, "docs"]) walk(join(ROOT, d), files);
    const docs: string[] = [];
    const walkDocs = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walkDocs(p);
        else if ([".md", ".json", ".txt"].includes(extname(name))) docs.push(p);
      }
    };
    walkDocs(join(ROOT, "docs"));
    for (const f of ["README.md", "AGENTS.md", "package.json"]) docs.push(join(ROOT, f));
    // Private IPv4 ranges (RFC 1918) and home directories; loopback is fine.
    const bad = /\/Users\/[A-Za-z]|\/home\/[a-z]|\b10\.\d+\.\d+\.\d+\b|\b192\.168\.\d+\.\d+\b|\b172\.(1[6-9]|2\d|3[01])\.\d+\.\d+\b/;
    const hits = [...files, ...docs].filter((f) => bad.test(readFileSync(f, "utf8"))).map((f) => relative(ROOT, f));
    expect(hits).toEqual([]);
  });
});

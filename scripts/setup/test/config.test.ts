// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { domainError, generateConfig, handleError, renderConfig } from "../config.ts";
import { parseJsonc } from "../jsonc.ts";

const checkedIn = readFileSync(new URL("../../../packages/worker/wrangler.jsonc", import.meta.url), "utf8");

describe("domain validation", () => {
  it("accepts plain hostnames", () => {
    for (const d of ["example.com", "my-board.example.co.uk", "a1.b2.io"]) expect(domainError(d), d).toBeUndefined();
  });

  it("rejects a scheme, path, port, wildcard, uppercase, address, single label and stray dots", () => {
    for (const d of [
      "https://example.com",
      "example.com/path",
      "example.com:8080",
      "*.example.com",
      "Example.com",
      "example",
      "1.2.3.4",
      "-a.example.com",
      "a..example.com",
      "example.com.",
      "exa mple.com",
      "",
      `${"a".repeat(64)}.com`,
    ]) {
      expect(domainError(d), d).toBeTruthy();
    }
  });
});

describe("handle validation", () => {
  it("uses the board's own rule", () => {
    expect(handleError("admin")).toBeUndefined();
    expect(handleError("a_b-9")).toBeUndefined();
    for (const h of ["", "-x", "has space", "system", "Me", "x".repeat(33)]) expect(handleError(h), h).toBeTruthy();
  });
});

describe("generated config", () => {
  const base = parseJsonc(checkedIn);

  it("domain mode: the checked-in config plus two Custom Domains and no workers.dev", () => {
    const c = generateConfig(checkedIn, "example.com");
    expect(c.routes).toEqual([
      { pattern: "app.example.com", custom_domain: true },
      { pattern: "api.example.com", custom_domain: true },
    ]);
    expect(c.workers_dev).toBe(false);
    const { routes, ...rest } = c;
    expect(routes).toBeDefined();
    expect(rest).toEqual(base);
  });

  it("no-domain mode: the checked-in config with workers.dev on, no routes, no previews", () => {
    const c = generateConfig(checkedIn, undefined);
    expect(c.routes).toBeUndefined();
    expect(c.workers_dev).toBe(true);
    expect(c.preview_urls).toBe(false);
    expect({ ...c, workers_dev: false }).toEqual(base);
  });

  it("writes the approval vars only when asked, and the synced stopgap only with approval required", () => {
    const vars = (approval?: { required?: boolean; allowSynced?: boolean }) =>
      (generateConfig(checkedIn, "example.com", "b", "c", approval).vars ?? {}) as Record<string, string>;
    expect(vars()).not.toHaveProperty("BBS_REQUIRE_APPROVAL");
    expect(vars({ required: false, allowSynced: false })).not.toHaveProperty("BBS_REQUIRE_APPROVAL");
    expect(vars({ required: true })).toMatchObject({ BBS_REQUIRE_APPROVAL: "1" });
    expect(vars({ required: true })).not.toHaveProperty("BBS_APPROVER_ALLOW_SYNCED");
    expect(vars({ required: true, allowSynced: true })).toMatchObject({ BBS_REQUIRE_APPROVAL: "1", BBS_APPROVER_ALLOW_SYNCED: "1" });
    expect(vars({ required: false, allowSynced: true })).not.toHaveProperty("BBS_APPROVER_ALLOW_SYNCED");
  });

  it("renders as JSONC that reads back to the same object, with an SPDX header", () => {
    const c = generateConfig(checkedIn, "example.com");
    const text = renderConfig(c);
    expect(text).toContain("SPDX-License-Identifier: Apache-2.0");
    expect(parseJsonc(text)).toEqual(c);
  });
});

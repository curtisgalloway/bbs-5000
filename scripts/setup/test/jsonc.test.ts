// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseJsonc, stripJsonc } from "../jsonc.ts";

describe("JSONC reader", () => {
  it("drops line and block comments and trailing commas but keeps strings intact", () => {
    const text = `// head
{
  "a": "x // not a comment", /* block */
  "b": [1, 2,],
  "c": "quote \\" // still a string", // tail
}`;
    expect(parseJsonc(text)).toEqual({ a: "x // not a comment", b: [1, 2], c: 'quote " // still a string' });
    expect(stripJsonc("{}")).toBe("{}");
  });

  it("rejects an unterminated block comment and a non-object", () => {
    expect(() => stripJsonc("{ /* open")).toThrow(/unterminated/);
    expect(() => parseJsonc("[1]")).toThrow(/not an object/);
  });

  it("reads the checked-in worker config", () => {
    const text = readFileSync(new URL("../../../packages/worker/wrangler.jsonc", import.meta.url), "utf8");
    const c = parseJsonc(text);
    expect(c.name).toBe("bbs-5000");
    expect(c.routes).toBeUndefined();
    expect(c.workers_dev).toBe(false);
    expect(c.preview_urls).toBe(false);
  });
});

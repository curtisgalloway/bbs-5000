// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { deriveVia, provisionalVia } from "../src/http.ts";
import { anySocketFault, closeReason, MAX_SOCKET_MESSAGE, messageBytes, parseAdapterMessage, parseSocketFaults, socketFaultsFromEnv } from "../src/ws-protocol.ts";
import { COUNT_OVERRIDES, SPAN_OVERRIDES } from "../src/env.ts";

describe("adapter protocol (spec §4.3)", () => {
  it("parses the spec's messages and the recorded additions", () => {
    expect(parseAdapterMessage('{"type":"hello","session":"s_abc","harness":"claude-code","machine":"workstation-1"}')).toEqual({
      type: "hello",
      session: "s_abc",
      harness: "claude-code",
      machine: "workstation-1",
    });
    expect(parseAdapterMessage('{"type":"hello","session":"s_abc","state":"busy"}')).toEqual({
      type: "hello",
      session: "s_abc",
      state: "busy",
    });
    expect(parseAdapterMessage('{"type":"state","state":"idle"}')).toEqual({ type: "state", state: "idle" });
    expect(parseAdapterMessage('{"type":"ring_result","id":"d_123","result":"turn_started"}')).toEqual({
      type: "ring_result",
      id: "d_123",
      result: "turn_started",
    });
    expect(parseAdapterMessage('{"type":"ring_result","id":"d_1","result":"failed","confirmed":false}')).toMatchObject({
      confirmed: false,
    });
  });

  it("refuses everything else", () => {
    for (const bad of [
      "nope",
      "[]",
      "null",
      '{"type":"doorbell"}',
      '{"type":"hello"}',
      '{"type":"hello","session":""}',
      '{"type":"hello","session":"s","state":"asleep"}',
      '{"type":"hello","session":"s","harness":5}',
      '{"type":"state","state":"gone"}',
      '{"type":"ring_result","id":"d","result":"maybe"}',
      '{"type":"ring_result","result":"failed"}',
      '{"type":"ring_result","id":"d","result":"failed","confirmed":"yes"}',
      `{"type":"state","state":"idle","pad":"${"x".repeat(MAX_SOCKET_MESSAGE)}"}`,
    ]) {
      expect(parseAdapterMessage(bad), bad.slice(0, 60)).toHaveProperty("error");
    }
    expect(parseAdapterMessage(new ArrayBuffer(4))).toHaveProperty("error");
  });

  it("keeps close reasons short and printable", () => {
    expect(closeReason("a\u0000b".padEnd(300, "z"))).toMatch(/^a\?bz+$/);
    expect(closeReason("x".repeat(300))).toHaveLength(120);
  });

  it("/ws is via ws for everyone (core refuses a person)", () => {
    expect(provisionalVia("/ws")).toBe("ws");
    expect(deriveVia("/ws", "agent", null)).toBe("ws");
    expect(deriveVia("/ws", "human", "cli")).toBe("ws");
  });

  it("measures the limit in bytes, not UTF-16 units", () => {
    // 1,400 three-byte characters: 1,400 string units, 4,200 bytes.
    const msg = `{"type":"state","state":"idle","pad":"${"\u20ac".repeat(1400)}"}`;
    expect(msg.length).toBeLessThan(MAX_SOCKET_MESSAGE);
    expect(messageBytes(msg)).toBeGreaterThan(MAX_SOCKET_MESSAGE);
    expect(parseAdapterMessage(msg)).toEqual({ error: "message too large" });
  });
});

describe("test-only socket faults (M4b review m2)", () => {
  it("parse to nothing when unset, and each fault when named", () => {
    expect(anySocketFault(parseSocketFaults(undefined))).toBe(false);
    expect(anySocketFault(parseSocketFaults(""))).toBe(false);
    const f = parseSocketFaults("keep_kicked, no_hash=nh ,bad_hash=bh,unknown");
    expect(f.keepKicked).toBe(true);
    expect([...f.noHash]).toEqual(["nh"]);
    expect([...f.badHash]).toEqual(["bh"]);
    expect(anySocketFault(f)).toBe(true);
  });
});

describe("test-only settings never reach a deployment (F, B55)", () => {
  it("socket faults are refused without BBS_ALLOW_TEST_FAULTS=1, and honored with it", () => {
    const set = { BBS_TEST_SOCKET_FAULTS: "keep_kicked,no_hash=nh,bad_hash=bh" };
    for (const allow of [undefined, "", "0", "true", "yes", " 2"]) {
      const r = socketFaultsFromEnv({ ...set, ...(allow !== undefined ? { BBS_ALLOW_TEST_FAULTS: allow } : {}) });
      expect(r.refused, String(allow)).toBe(true);
      expect(anySocketFault(r.faults), String(allow)).toBe(false);
    }
    const allowed = socketFaultsFromEnv({ ...set, BBS_ALLOW_TEST_FAULTS: "1" });
    expect(allowed.refused).toBe(false);
    expect(allowed.faults.keepKicked).toBe(true);
    expect([...allowed.faults.badHash]).toEqual(["bh"]);
    // Nothing set: nothing refused, nothing on (the flag alone turns nothing on).
    expect(socketFaultsFromEnv({})).toEqual({ faults: parseSocketFaults(undefined), refused: false });
    expect(anySocketFault(socketFaultsFromEnv({ BBS_ALLOW_TEST_FAULTS: "1" }).faults)).toBe(false);
  });

  it("wrangler.jsonc sets no vars at all, so no test-only or span setting ships in the config", () => {
    const text = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
    // Strip // comments (the file is JSONC; no string in it contains "//" except URLs, which it has none of).
    const config = JSON.parse(text.replace(/^\s*\/\/.*$/gm, "")) as Record<string, unknown>;
    expect(config.vars).toBeUndefined();
    expect(config.env).toBeUndefined();
    expect(text).not.toMatch(/BBS_TEST_|BBS_ALLOW_TEST|_MS"|BBS_WAKE_BUDGET"/);
  });

  it(".dev.vars.example leaves every test-only and span setting commented out, and marks test-only ones", () => {
    const text = readFileSync(new URL("../.dev.vars.example", import.meta.url), "utf8");
    const active = text.split("\n").filter((l) => /^\s*[A-Z]/.test(l)).map((l) => l.split("=")[0]!.trim());
    expect(active.sort()).toEqual(["BBS_HUMAN_HANDLE", "BBS_HUMAN_TOKEN_SHA256"]);
    const testOnly = text.slice(text.indexOf("Test only: must not be set outside the e2e suite"));
    expect(testOnly.length).toBeLessThan(text.length);
    for (const name of ["BBS_TEST_SOCKET_FAULTS", "BBS_ALLOW_TEST_FAULTS", "BBS_AUDIT_GCS_STORAGE_URL", "BBS_AUDIT_GCS_TOKEN_URL"]) {
      expect(testOnly, name).toContain(`# ${name}=`);
    }
    // Every override the Board DO reads is documented there.
    for (const name of [...Object.keys(SPAN_OVERRIDES), ...Object.keys(COUNT_OVERRIDES)]) expect(text, name).toContain(name);
  });
});

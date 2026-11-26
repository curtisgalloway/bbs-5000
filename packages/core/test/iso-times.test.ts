// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0

// Times in tool results are ISO 8601 text; everything stored keeps epoch
// milliseconds (design §9, AGENTS.md). The converter's rules, a guard that
// calls a spread of tools and fails on any epoch-looking number left in a
// result, the `since` input, and `bbs_whoami` on /mcp.

import { describe, expect, it } from "vitest";
import { isoTimes, parseTimeInput } from "../src/iso-times.ts";
import { callTool, TOOLS } from "../src/tools.ts";
import type { CallContext, RuntimeFacts } from "../src/types.ts";
import { ADMIN, makeBoard, type Fixture } from "./helpers.ts";

const MS = Date.UTC(2026, 10, 23, 4, 4, 50, 79);
const ISO = "2026-11-23T04:04:50.079Z";
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe("isoTimes", () => {
  it("converts keys ending _at", () => {
    expect(isoTimes({ created_at: MS, lease_expires_at: MS, x_at: MS })).toEqual({
      created_at: ISO,
      lease_expires_at: ISO,
      x_at: ISO,
    });
  });

  it("converts each allowlisted key", () => {
    const keys = [
      "ts", "at", "now", "last_seen", "busy_since", "failing_since", "rings_failing_since",
      "pending_since", "muted_until", "budget_until", "until", "next", "due", "window_start",
      "archive_after", "last_activity",
    ];
    for (const k of keys) expect(isoTimes({ [k]: MS }), k).toEqual({ [k]: ISO });
  });

  it("walks nested objects and arrays", () => {
    expect(isoTimes({ a: [{ b: { ts: MS } }, [{ at: MS }]], c: { d: [{ created_at: MS }] } })).toEqual({
      a: [{ b: { ts: ISO } }, [{ at: ISO }]],
      c: { d: [{ created_at: ISO }] },
    });
  });

  it("leaves null, strings, booleans and a time key holding text alone", () => {
    const v = { last_seen: null, ts: "yesterday", at: true, body: "created_at 1795406690079", n: undefined };
    expect(isoTimes(v)).toEqual(v);
  });

  it("leaves durations, sequence numbers and counts alone", () => {
    const v = {
      expires_in_ms: 300_000, window_ms: MS, max_age_ms: MS, age_ms: MS, seq: 12, next_since: 41,
      after_seq: 3, lobby_seq: 9, wake_through_seq: MS, count: MS, id: MS, since: 7,
    };
    expect(isoTimes(v)).toEqual(v);
  });

  it("leaves a number that is not finite, or not a date, alone", () => {
    const v = { ts: Number.NaN, at: Number.POSITIVE_INFINITY, created_at: 8.64e15 + 1 };
    expect(isoTimes(v)).toEqual({ ts: Number.NaN, at: Number.POSITIVE_INFINITY, created_at: 8.64e15 + 1 });
  });

  it("treats `since` as a time only for the tools that name it", () => {
    expect(isoTimes({ since: MS })).toEqual({ since: MS });
    expect(isoTimes({ needs_you: [{ since: MS }] }, "admin_status")).toEqual({ needs_you: [{ since: ISO }] });
  });

  it("does not change its input", () => {
    const v = { ts: MS, rows: [{ at: MS }] };
    isoTimes(v);
    expect(v).toEqual({ ts: MS, rows: [{ at: MS }] });
  });
});

describe("parseTimeInput", () => {
  it("takes milliseconds and ISO 8601 text", () => {
    expect(parseTimeInput(MS, "since")).toBe(MS);
    expect(parseTimeInput(ISO, "since")).toBe(MS);
    expect(parseTimeInput("2026-11-23T04:04:50Z", "since")).toBe(MS - 79);
    expect(parseTimeInput("2026-11-22T20:04:50.079-08:00", "since")).toBe(MS);
    expect(parseTimeInput("2026-11-23", "since")).toBe(Date.UTC(2026, 10, 23));
  });

  it("refuses anything else as a bad request", () => {
    for (const bad of ["garbage", "", "2026-13-45T00:00:00Z", "2026-11-23T04:04:50", "12345", -1, 1.5, true, {}]) {
      expect(() => parseTimeInput(bad, "since"), String(bad)).toThrow(/since must be epoch milliseconds or an ISO 8601 time/);
    }
  });
});

/** Keys whose numbers are durations or sequence numbers, never times. */
const EXEMPT = (key: string): boolean => key.endsWith("_ms") || key.endsWith("seq") || key === "seq";

function stragglers(value: unknown, path = "$"): string[] {
  if (Array.isArray(value)) return value.flatMap((v, i) => stragglers(v, `${path}[${i}]`));
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([k, v]) => {
    if (typeof v === "number") return v >= 1e12 && v < 1e13 && !EXEMPT(k) ? [`${path}.${k}=${v}`] : [];
    return stragglers(v, `${path}.${k}`);
  });
}

class FakeRuntime implements RuntimeFacts {
  openSockets(): number {
    return 1;
  }
  auditExportConfigured(): boolean {
    return true;
  }
}

/** Flood the Lobby until the first refusal. */
function flood(f: Fixture, h: string): void {
  for (let i = 0; i < 50; i++) {
    if (!f.board.act(f.ctx(h), "post", { topic: "Lobby", body: `m${i}` }).ok) return;
  }
  throw new Error("never refused");
}

type Results = Record<string, ReturnType<typeof callTool>>;

/** Call the read tools as the right callers; every call must succeed. */
function collect(f: Fixture, into: Results, tag: string, readers: { agent: string; other: string }): void {
  const admin = f.ctx(ADMIN, "cli");
  const run = (label: string, ctx: CallContext, name: string, args: unknown = {}) => {
    const r = callTool(f.board, ctx, name, args, ctx.via === "mcp" ? "mcp" : "cli");
    expect(r.isError, `${tag} ${label}: ${r.content[0]?.text}`).toBe(false);
    into[`${tag} ${label}`] = r;
  };
  run("whoami", f.ctx(readers.agent), "bbs_whoami");
  run("who", f.ctx(readers.agent), "bbs_who", { topic: "work" });
  run("read", f.ctx(readers.other), "bbs_read", { topic: "work" });
  run("topics", f.ctx(readers.agent), "bbs_topics");
  run("tasks", f.ctx(readers.agent), "bbs_task_list", { topic: "work" });
  run("audit", admin, "bbs_audit", { limit: 500 });
  run("audit-tail", admin, "bbs_audit", { tail: true, limit: 500 });
  run("admin-status", admin, "bbs_admin_status");
  run("web-sessions", admin, "bbs_web_sessions");
  run("oauth-grants", admin, "bbs_oauth_grants");
  // Inbox last: it clears the notices it returns.
  run("inbox", f.ctx(readers.other), "bbs_inbox");
}

/** A web session and a connector grant, made the way the Worker makes them. */
function signIns(f: Fixture): void {
  const admin = f.ctx(ADMIN, "cli");
  const p = f.board.webPairStart({ source: "ip:1.1.1.1", label: "Chrome" });
  if (!p.ok) throw new Error("pair start");
  f.board.act(admin, "web_pairing_approve", { code: p.value.code });
  f.board.webPairClaim({ pollSecret: p.value.poll_secret, source: "ip:1.1.1.1" });
  const res = "https://api.example/mcp";
  const web: CallContext = { handle: ADMIN, via: "web", webSession: "ws_x" };
  const req = f.board.oauthRequest(web, {
    response_type: "code",
    client_id: "https://client.example/c.json",
    redirect_uri: "https://client.example/cb",
    code_challenge: "A".repeat(43),
    code_challenge_method: "S256",
    resource: res,
    resource_expected: res,
    client_doc: { client_id: "https://client.example/c.json", client_name: "C", redirect_uris: ["https://client.example/cb"] },
  });
  if (!req.ok) throw new Error(`oauth request: ${req.error.message}`);
  const rid = (req.value as { request_id: string }).request_id;
  const dec = f.board.oauthDecide(web, { request_id: rid, approve: true, handle: "claude-ai" });
  if (!dec.ok) throw new Error(`oauth decide: ${dec.error.message}`);
}

/** Tasks, a mute, an idle topic and its archive notice; a snapshot before and after the notice. */
function scenarioMute(into: Results): Fixture {
  const f = makeBoard({ runtime: new FakeRuntime() });
  for (const h of ["alice", "bob", "carol"]) f.addUser(h);
  const call = (h: string, name: string, args: unknown = {}) => {
    const r = callTool(f.board, f.ctx(h), name, args, "mcp");
    if (r.isError) throw new Error(`${name}: ${r.content[0]?.text}`);
  };
  call("alice", "bbs_join", { role: "builder" });
  call("bob", "bbs_join", {});
  call("alice", "bbs_topic_create", { name: "work" });
  call("alice", "bbs_topic_create", { name: "idle" });
  call("bob", "bbs_subscribe", { topic: "work", level: "wake" });
  call("alice", "bbs_post", { topic: "work", body: "hello @bob" });
  call("alice", "bbs_task_create", { topic: "work", title: "t1" });
  call("bob", "bbs_task_claim", { task: 1 });
  call("bob", "bbs_task_comment", { task: 1, body: "on it" });
  signIns(f);
  flood(f, "carol");
  f.clock.advance(11 * MIN);
  flood(f, "carol");
  // A failed audit export, so the export state carries failing_since and retry_at.
  f.clock.advance(5 * MIN);
  const batch = f.board.beginAuditExport();
  if (!batch) throw new Error("no audit batch");
  f.board.failAuditExport(batch, "HTTP 503");
  collect(f, into, "muted", { agent: "alice", other: "bob" });
  f.board.ensureArchiveScan();
  f.clock.advance(27 * DAY);
  f.board.runDueTimers();
  collect(f, into, "scanned", { agent: "alice", other: "alice" });
  return f;
}

/** A busy session, failing rings, a pending doorbell and an exhausted wake budget. */
function scenarioRings(into: Results, tag: string, budget: number, results: ("turn_started" | "failed")[]): Fixture {
  const f = makeBoard({
    runtime: new FakeRuntime(),
    config: { wakeBudgetPerHour: budget, doorbellDebounceMs: 1000 },
  });
  for (const h of ["alice", "bob"]) f.addUser(h);
  const ok = (r: { ok: boolean }) => expect(r.ok).toBe(true);
  ok(f.board.act(f.ctx("alice"), "join", {}));
  const session = (f.board.act<{ session: string }>(f.ctx("bob"), "join", {}) as { value: { session: string } }).value.session;
  ok(f.board.act(f.ctx("alice"), "topic_create", { name: "work" }));
  ok(f.board.act(f.ctx("bob"), "subscribe", { topic: "work", level: "wake" }));
  ok(f.board.act(f.ctx("bob"), "inbox", {}));
  const ws: CallContext = { handle: "bob", via: "ws", session };
  ok(f.board.socketAct({ handle: "bob", via: "ws" }, "socket_open", {}));
  ok(f.board.socketAct(ws, "socket_hello", { harness: "claude-code", state: "idle" }));
  for (let i = 0; i < results.length; i++) {
    ok(f.board.act(f.ctx("alice"), "post", { topic: "work", body: `m${i}` }));
    f.clock.advance(1000);
    const rung = f.board.runDueTimers().flatMap((r) => r.notifications).find((n) => n.type === "ring");
    if (rung?.type === "ring") ok(f.board.socketAct(ws, "ring_result", { id: rung.id, result: results[i] }));
    ok(f.board.act(f.ctx("bob"), "inbox", {}));
  }
  ok(f.board.socketAct(ws, "session_state", { state: "busy" }));
  ok(f.board.act(f.ctx("alice"), "post", { topic: "work", body: "while busy" }));
  collect(f, into, tag, { agent: "alice", other: "bob" });
  return f;
}

describe("no epoch time is left in a tool result (guard)", () => {
  const results: Results = {};
  const muted = scenarioMute(results);
  scenarioRings(results, "budget", 2, ["turn_started", "turn_started", "turn_started"]);
  scenarioRings(results, "failing", 20, ["turn_started", "failed", "failed", "failed"]);

  it("covers who, read, inbox, audit, topics, task list, web sessions, oauth grants and admin status", () => {
    expect(Object.keys(results).length).toBeGreaterThanOrEqual(30);
    for (const [label, r] of Object.entries(results)) {
      expect(stragglers(r.structuredContent), label).toEqual([]);
      expect(r.content[0]?.text, label).not.toMatch(/\b1[0-9]{12}\b(?!")/);
    }
  });

  it("sees the time keys it guards: each shows up as ISO text somewhere", () => {
    const seen = new Set<string>();
    const walk = (v: unknown): void => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v !== null && typeof v === "object") {
        for (const [k, x] of Object.entries(v)) {
          if (typeof x === "string" && /^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(x)) seen.add(k);
          walk(x);
        }
      }
    };
    for (const r of Object.values(results)) walk(r.structuredContent);
    for (const k of ["ts", "at", "now", "last_seen", "created_at", "expires_at", "muted_until", "since", "until",
      "busy_since", "failing_since", "retry_at", "rings_failing_since", "pending_since", "window_ends_at", "archive_after", "last_activity",
      "budget_until", "window_start", "next", "due"]) {
      expect(seen.has(k), k).toBe(true);
    }
    const status = results["muted admin-status"]?.structuredContent as { now: string };
    expect(status.now).toBe(new Date(muted.clock.t - 27 * DAY).toISOString());
  });

  it("keeps the stored rows in milliseconds", () => {
    const f = muted;
    const row = f.auditRows()[0] as { ts: unknown };
    expect(typeof row.ts).toBe("number");
    const user = f.sql.one<{ last_seen: unknown }>("SELECT last_seen FROM users WHERE handle = 'alice'");
    expect(typeof user?.last_seen).toBe("number");
  });
});

describe("bbs_read paging stays numeric", () => {
  it("returns since-style cursors as integers", () => {
    const f = makeBoard();
    f.addUser("alice");
    callTool(f.board, f.ctx("alice"), "bbs_join", {});
    callTool(f.board, f.ctx("alice"), "bbs_topic_create", { name: "work" });
    callTool(f.board, f.ctx("alice"), "bbs_post", { topic: "work", body: "hi" });
    const r = callTool(f.board, f.ctx("alice"), "bbs_read", { topic: "work", since: 0 });
    const v = r.structuredContent as { next_since: number; messages: { seq: number; created_at: string }[] };
    expect(Number.isInteger(v.next_since)).toBe(true);
    expect(Number.isInteger(v.messages[0]?.seq)).toBe(true);
    expect(v.messages[0]?.created_at).toMatch(/Z$/);
  });
});

describe("bbs_audit since", () => {
  const rows = (f: Fixture, since: unknown) => {
    const r = callTool(f.board, f.ctx(ADMIN, "cli"), "bbs_audit", { since, limit: 500 }, "cli");
    return r;
  };

  it("accepts milliseconds and ISO text, and means the same", () => {
    const f = makeBoard();
    f.addUser("alice");
    f.clock.advance(HOUR);
    callTool(f.board, f.ctx("alice"), "bbs_join", {});
    const cut = f.clock.t;
    const ms = (rows(f, cut).structuredContent as { events: unknown[] }).events;
    const text = (rows(f, new Date(cut).toISOString()).structuredContent as { events: unknown[] }).events;
    expect(text.slice(0, ms.length)).toEqual(ms);
    expect(ms.length).toBeGreaterThan(0);
    const all = (rows(f, 0).structuredContent as { events: unknown[] }).events;
    expect(all.length).toBeGreaterThan(ms.length);
  });

  it("refuses garbage as a bad request", () => {
    const f = makeBoard();
    const r = rows(f, "last tuesday");
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toEqual({
      error: { code: "bad_request", message: "since must be epoch milliseconds or an ISO 8601 time" },
    });
  });
});

describe("bbs_whoami on /mcp", () => {
  it("is listed on the mcp surface and callable there", () => {
    expect(TOOLS.find((t) => t.name === "bbs_whoami")?.surfaces).toContain("mcp");
    const f = makeBoard();
    f.addUser("alice");
    const r = callTool(f.board, f.ctx("alice"), "bbs_whoami", {}, "mcp");
    expect(r.isError).toBe(false);
    expect(r.structuredContent).toMatchObject({ handle: "alice", kind: "agent", via: "mcp" });
  });
});

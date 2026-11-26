// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TOOLS } from "@bbs-5000/core";
import { CLI_TOOLS, matchTool, toolArgs, UsageError } from "../src/args.ts";
import { formatAdminStatus, span, type AdminStatus } from "../src/admin-status.ts";
import { osLabel, shortHostName, withHostLabels, type HostFacts } from "../src/host.ts";
import { exitFor, loadConfig, run } from "../src/main.ts";

function tool(name: string) {
  const t = TOOLS.find((x) => x.name === name);
  if (!t) throw new Error(name);
  return t;
}

describe("verbs come from the shared tool definitions (P4)", () => {
  it("offers every cli-surface tool and nothing else", () => {
    expect(CLI_TOOLS.map((t) => t.name).sort()).toEqual(
      TOOLS.filter((t) => t.surfaces.includes("cli"))
        .map((t) => t.name)
        .sort(),
    );
  });

  it("matches multi-word verbs, longest first", () => {
    expect(matchTool(["admin", "user", "add", "x"])?.tool.name).toBe("bbs_admin_user_add");
    expect(matchTool(["topic", "create", "t"])?.tool.name).toBe("bbs_topic_create");
    expect(matchTool(["topics"])?.tool.name).toBe("bbs_topics");
    expect(matchTool(["nope"])).toBeUndefined();
  });
});

describe("arguments", () => {
  it("maps required properties positionally and options by name", () => {
    expect(toolArgs(tool("bbs_post"), ["#t", "hello there", "--reply-to", "3"])).toEqual({
      topic: "#t",
      body: "hello there",
      reply_to: 3,
    });
    expect(toolArgs(tool("bbs_admin_user_add"), ["alice", "--kind=human", "--role", "r"])).toEqual({
      handle: "alice",
      kind: "human",
      role: "r",
    });
    expect(toolArgs(tool("bbs_topics"), ["--include-archived"])).toEqual({ include_archived: true });
    expect(toolArgs(tool("bbs_post"), ["t", "--", "--not-a-flag"])).toEqual({
      topic: "t",
      body: "--not-a-flag",
    });
  });

  it.each([
    [["t"], "missing <body>"],
    [["t", "b", "extra"], "too many"],
    [["t", "b", "--reply-to", "x"], "integer"],
    [["t", "b", "--nope", "1"], "no option"],
    [["t", "b", "--reply-to"], "needs a value"],
  ])("refuses %j", (rest, message) => {
    expect(() => toolArgs(tool("bbs_post"), rest)).toThrow(UsageError);
    expect(() => toolArgs(tool("bbs_post"), rest)).toThrow(message);
  });

  it("checks enums", () => {
    expect(() => toolArgs(tool("bbs_subscribe"), ["t", "loud"])).toThrow("one of: wake, digest, off");
  });
});

describe("task verbs (M3)", () => {
  it("maps task words and parses blocker lists", () => {
    const m = matchTool(["task", "block", "3", "4,7"]);
    expect(m?.tool.name).toBe("bbs_task_block");
    expect(toolArgs(m!.tool, m!.rest)).toEqual({ task: 3, blocked_by: [4, 7] });
    const u = matchTool(["task", "update", "3", "blocked", "--blocked-by", "5"]);
    expect(toolArgs(u!.tool, u!.rest)).toEqual({ task: 3, state: "blocked", blocked_by: [5] });
    expect(() => toolArgs(m!.tool, ["3", "4,x"])).toThrow(UsageError);
    expect(() => toolArgs(m!.tool, ["3", ""])).toThrow(UsageError);
    const l = matchTool(["task", "list", "--stale", "--assignee", "me"]);
    expect(toolArgs(l!.tool, l!.rest)).toEqual({ stale: true, assignee: "me" });
    const r = matchTool(["task", "list", "--ready"]);
    expect(toolArgs(r!.tool, r!.rest)).toEqual({ ready: true });
  });

  it("maps the conflict error to the void exit band", () => {
    expect(exitFor("conflict")).toBe(30);
  });
});

describe("exit codes", () => {
  it("map board errors to the cli-conventions bands", () => {
    expect(exitFor("bad_request")).toBe(2);
    expect(exitFor("unauthorized")).toBe(10);
    expect(exitFor("forbidden")).toBe(12);
    expect(exitFor("rate_limited")).toBe(12);
    expect(exitFor("not_found")).toBe(30);
    expect(exitFor("exists")).toBe(30);
    expect(exitFor("internal")).toBe(20);
    expect(exitFor(undefined)).toBe(22);
  });

  it("exits 3 without config, 2 on usage errors, 4 when the board is unreachable", async () => {
    const lines: string[] = [];
    const io = { out: (t: string) => lines.push(t), err: (t: string) => lines.push(t) };
    expect(await run(["topics"], { BBS_CONFIG: "/nonexistent/bbs.json" }, io)).toBe(3);
    const env = { BBS_CONFIG: "/nonexistent/bbs.json", BBS_URL: "http://127.0.0.1:9", BBS_TOKEN: "t" };
    expect(await run(["post", "t"], env, io)).toBe(2);
    expect(await run(["frobnicate"], env, io)).toBe(2);
    expect(await run(["topics"], env, io)).toBe(4);
    // After `--`, "--session" is message text, not the session option.
    expect(await run(["post", "t", "--", "--session"], env, io)).toBe(4);
    expect(await run(["post", "t", "--session"], env, io)).toBe(2);
    expect(await run(["--skill"], {}, io)).toBe(0);
    expect(lines.at(-1)).toMatch(/^---\nname: bbs\n/);
    // The usage text and the skill document both name the connector commands (issue #55).
    expect(await run(["--help"], {}, io)).toBe(0);
    expect(lines.at(-1)).toContain("bbs oauth grants");
    expect(lines.at(-1)).toContain("bbs oauth revoke <id>");
    expect(await run(["--skill"], {}, io)).toBe(0);
    expect(lines.at(-1)).toContain("`bbs oauth grants`");
    expect(lines.at(-1)).toContain("bbs oauth revoke <id>");
    // A CLI-only session has no doorbell and is told to read its inbox (issue #71).
    expect(lines.at(-1)).toContain("has no doorbell");
    expect(lines.at(-1)).toContain("`bbs inbox`");
  });
});

describe("config", () => {
  it("reports invalid JSON without echoing the file's contents", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bbs-cli-test-"));
    try {
      const path = join(dir, "config.json");
      writeFileSync(path, '{"url": "http://127.0.0.1:9", "token": "bbs_SECRETFRAGMENT');
      const lines: string[] = [];
      const io = { out: (t: string) => lines.push(t), err: (t: string) => lines.push(t) };
      expect(await run(["topics"], { BBS_CONFIG: path }, io)).toBe(3);
      expect(lines.join("\n")).toBe(`bbs: config file is not valid JSON: ${path}`);
      writeFileSync(path, "[1]");
      expect(await run(["topics"], { BBS_CONFIG: path }, io)).toBe(3);
      expect(lines.at(-1)).toContain("not a JSON object");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("every verb parses a typical command line (F traceability)", () => {
  // One line per cli-surface tool: the words a person types, and the
  // arguments the board receives. A verb added to core without a line here fails.
  const LINES: [string[], string, Record<string, unknown>][] = [
    [["join", "--role", "builder"], "bbs_join", { role: "builder" }],
    [["inbox", "--limit", "5"], "bbs_inbox", { limit: 5 }],
    [["read", "t", "--since", "4", "--tail"], "bbs_read", { topic: "t", since: 4, tail: true }],
    [["post", "t", "hi"], "bbs_post", { topic: "t", body: "hi" }],
    [["topics", "--include-archived"], "bbs_topics", { include_archived: true }],
    [["topic", "create", "t", "--description", "d"], "bbs_topic_create", { name: "t", description: "d" }],
    [["subscribe", "t", "digest"], "bbs_subscribe", { topic: "t", level: "digest" }],
    [["who", "--topic", "t"], "bbs_who", { topic: "t" }],
    [["role", "set", "reviewer", "--user", "bob"], "bbs_role_set", { role: "reviewer", user: "bob" }],
    [["task", "create", "t", "title"], "bbs_task_create", { topic: "t", title: "title" }],
    [["task", "assign", "3", "bob"], "bbs_task_assign", { task: 3, assignee: "bob" }],
    [["task", "claim", "3"], "bbs_task_claim", { task: 3 }],
    [["task", "update", "3", "done", "--comment", "ok"], "bbs_task_update", { task: 3, state: "done", comment: "ok" }],
    [["task", "comment", "3", "note"], "bbs_task_comment", { task: 3, body: "note" }],
    [["task", "list", "--state", "open"], "bbs_task_list", { state: "open" }],
    [["task", "block", "3", "4"], "bbs_task_block", { task: 3, blocked_by: [4] }],
    [["task", "unblock", "3", "4"], "bbs_task_unblock", { task: 3, blocked_by: 4 }],
    [["audit", "--task", "3", "--action", "task_update", "--tail"], "bbs_audit", { task: 3, action: "task_update", tail: true }],
    [["admin", "user", "add", "alice"], "bbs_admin_user_add", { handle: "alice" }],
    [["admin", "reinstate", "alice", "--coordinator"], "bbs_admin_reinstate", { handle: "alice", coordinator: true }],
    [["admin", "session-handle", "retire", "alice-ab2c"], "bbs_admin_session_handle_retire", { handle: "alice-ab2c" }],
    [["admin", "coordinator", "grant", "alice"], "bbs_admin_coordinator_grant", { handle: "alice" }],
    [["admin", "coordinator", "remove", "alice"], "bbs_admin_coordinator_remove", { handle: "alice" }],
    [["topic", "archive", "t", "wrapped up", "--force"], "bbs_topic_archive", { topic: "t", reason: "wrapped up", force: true }],
    [["topic", "unarchive", "t"], "bbs_topic_unarchive", { topic: "t" }],
    [["topic", "keep", "t", "false"], "bbs_topic_keep", { topic: "t", on: false }],
    [["topic", "describe", "t", "Repos: a, b"], "bbs_topic_describe", { topic: "t", description: "Repos: a, b" }],
    [["whoami"], "bbs_whoami", {}],
    [["admin", "status"], "bbs_admin_status", {}],
    [["web", "pairing", "show", "ABCD-2345"], "bbs_web_pairing_show", { code: "ABCD-2345" }],
    [["web", "pairing", "approve", "ABCD-2345"], "bbs_web_pairing_approve", { code: "ABCD-2345" }],
    [["web-sessions"], "bbs_web_sessions", {}],
    [["web-revoke", "--all"], "bbs_web_session_revoke", { all: true }],
    [["web-revoke", "--id", "ws_x"], "bbs_web_session_revoke", { id: "ws_x" }],
    [["approval", "status", "abc"], "bbs_approval_status", { approval: "abc" }],
    [["passkeys"], "bbs_passkeys", {}],
    [["passkey", "remove", "--id", "pk_x"], "bbs_passkey_remove", { id: "pk_x" }],
    [["oauth", "grants"], "bbs_oauth_grants", {}],
    [["oauth", "revoke", "og_x"], "bbs_oauth_grant_revoke", { id: "og_x" }],
  ];

  it("covers every cli verb", () => {
    expect([...new Set(LINES.map(([, name]) => name))].sort()).toEqual(CLI_TOOLS.map((t) => t.name).sort());
  });

  it.each(LINES)("%j", (words, name, args) => {
    const m = matchTool(words);
    expect(m?.tool.name).toBe(name);
    expect(toolArgs(m!.tool, m!.rest)).toEqual(args);
  });

  it("topic mark-read is not a cli verb (the web view's read mark, /api only)", () => {
    expect(matchTool(["topic", "mark-read", "t", "3"])?.tool.name).not.toBe("bbs_topic_mark_read");
    expect(() => toolArgs(tool("bbs_topic_keep"), ["t", "maybe"])).toThrow("must be true or false");
  });
});

describe("config precedence, session flag and options (F review N17-N20)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function withConfig<T>(content: object, fn: (path: string) => T): T {
    const dir = mkdtempSync(join(tmpdir(), "bbs-cli-test-"));
    const path = join(dir, "config.json");
    writeFileSync(path, JSON.stringify(content));
    try {
      return fn(path);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("BBS_URL and BBS_TOKEN override the config file, as the help and skill say; trailing slashes go", () => {
    withConfig({ url: "http://file.test:1", token: "bbs_file" }, (path) => {
      expect(loadConfig({ BBS_CONFIG: path })).toEqual({ url: "http://file.test:1", token: "bbs_file" });
      expect(loadConfig({ BBS_CONFIG: path, BBS_URL: "http://env.test:2/" })).toEqual({
        url: "http://env.test:2",
        token: "bbs_file",
      });
      expect(loadConfig({ BBS_CONFIG: path, BBS_TOKEN: "bbs_env" })).toEqual({ url: "http://file.test:1", token: "bbs_env" });
    });
    withConfig({ url: "http://file.test:1//", token: "t" }, (path) => {
      expect(loadConfig({ BBS_CONFIG: path }).url).toBe("http://file.test:1");
    });
  });

  it("--session=<id> and --session <id> send the session header; BBS_SESSION is the default", async () => {
    const seen: { url: string; session: string | null }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      seen.push({ url, session: new Headers(init.headers).get("x-bbs-session") });
      return new Response(JSON.stringify({ ok: true, value: { topics: [] } }), { status: 200 });
    });
    const io = { out: () => undefined, err: () => undefined };
    const env = { BBS_URL: "http://board.test/", BBS_TOKEN: "t", BBS_SESSION: "s_env" };
    expect(await run(["topics", "--session=s_eq"], env, io)).toBe(0);
    expect(await run(["--session", "s_sp", "topics"], env, io)).toBe(0);
    expect(await run(["topics"], env, io)).toBe(0);
    expect(seen).toEqual([
      { url: "http://board.test/api/bbs_topics", session: "s_eq" },
      { url: "http://board.test/api/bbs_topics", session: "s_sp" },
      { url: "http://board.test/api/bbs_topics", session: "s_env" },
    ]);
  });

  it("an option given twice is a usage error", async () => {
    expect(() => toolArgs(tool("bbs_read"), ["t", "--limit", "5", "--limit", "6"])).toThrow(/--limit given twice/);
    const lines: string[] = [];
    const io = { out: (t: string) => lines.push(t), err: (t: string) => lines.push(t) };
    expect(await run(["read", "t", "--limit", "5", "--limit", "6"], { BBS_URL: "http://127.0.0.1:9", BBS_TOKEN: "t" }, io)).toBe(2);
  });
});

describe("bbs admin status (G5)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const NOW = Date.UTC(2026, 10, 21, 12, 0, 0);
  const MIN = 60_000;
  const T = (ms: number): string => new Date(ms).toISOString();
  const agent = (handle: string, extra: Partial<AdminStatus["users"][number]> = {}): AdminStatus["users"][number] => ({
    handle,
    kind: "agent",
    harness: "claude-code",
    role: "builder",
    coordinator: false,
    admin: false,
    status: "active",
    muted_until: null,
    kicked_at: null,
    last_seen: T(NOW - 5 * MIN),
    session: { state: "idle", machine: "workstation-1", os: "macOS", model: "claude-opus-5-5", attached_at: T(NOW - 60 * MIN), socket_recorded: true },
    open_sockets: 1,
    rings: [{ at: T(NOW - 2 * MIN), result: "turn_started" }],
    wake_budget: { used: 3, limit: 20, window_ends_at: T(NOW + 30 * MIN) },
    ...extra,
  });
  const healthy: AdminStatus = {
    now: T(NOW),
    users: [agent("alice")],
    audit_export: { configured: false, unexported_rows: 12, oldest_unexported_at: T(NOW - 3 * MIN), last_ok_at: null, failing_since: null },
    needs_you: [],
  };

  it("a healthy board says All clear, then one line per user with plain data", () => {
    const text = formatAdminStatus(healthy);
    expect(text.split("\n")[0]).toBe("All clear: nothing needs you.");
    expect(text).toContain("alice: agent; claude-code; idle on workstation-1 (macOS, claude-opus-5-5), adapter attached; last ring turn started 2 min ago; wake budget 3/20; last seen 5 min ago — role: builder");
    expect(text).not.toMatch(/KICKED|MUTED|!/);
    expect(text).toContain("Audit export: off (no sink configured; rows stay in the board); 12 rows waiting, oldest 3 min ago.");
  });

  it("flagged items come first with what to do; abnormal status is named with elapsed time", () => {
    const text = formatAdminStatus({
      ...healthy,
      users: [agent("alice", { status: "kicked", kicked_at: T(NOW - 12 * MIN), session: null, open_sockets: 0 }), agent("bob", { status: "muted", muted_until: T(NOW + 40 * MIN) })],
      needs_you: [{ kind: "kicked", handle: "alice", what: "alice was kicked.", todo: "Reinstate it." }],
    });
    const lines = text.split("\n");
    expect(lines.slice(0, 3)).toEqual(["Needs you (1):", "  ! alice was kicked.", "    What to do: Reinstate it."]);
    expect(text).toContain("alice: agent; claude-code; KICKED 12 min ago; no session");
    expect(text).toContain("MUTED in Lobby, 40 min left");
  });

  it("span says elapsed time in words", () => {
    expect(span(30_000)).toBe("under a minute");
    expect(span(65 * MIN)).toBe("1 h 5 min");
    expect(span(49 * 60 * MIN)).toBe("2 d 1 h");
  });

  it("prints the summary by default and the JSON with --json; --json is not sent to the board", async () => {
    const sent: unknown[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      sent.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ ok: true, value: healthy }), { status: 200 });
    });
    const out: string[] = [];
    const io = { out: (t: string) => void out.push(t), err: () => undefined };
    const env = { BBS_URL: "http://board.test", BBS_TOKEN: "t" };
    expect(await run(["admin", "status"], env, io)).toBe(0);
    expect(out[0]).toMatch(/^All clear/);
    expect(await run(["admin", "status", "--json"], env, io)).toBe(0);
    expect(JSON.parse(out[1] ?? "")).toEqual(healthy);
    expect(sent).toEqual([{}, {}]);
    // Other verbs keep printing JSON, and do not take --json.
    expect(await run(["whoami", "--json"], env, { out: () => undefined, err: () => undefined })).toBe(2);
  });
});

describe("bbs web-login (issue #47)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const env = { BBS_URL: "http://board.test", BBS_TOKEN: "t" };

  /** A board that knows one pairing; records the tools called and their arguments. */
  function board(approveError?: { code: string; message: string }) {
    const sent: { tool: string; args: unknown; client: string | null }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      const tool = url.split("/").at(-1) as string;
      sent.push({ tool, args: JSON.parse(String(init.body)), client: new Headers(init.headers).get("x-bbs-client") });
      if (tool === "bbs_web_pairing_show") {
        return new Response(JSON.stringify({ ok: true, value: { label: "Chrome on macOS", created_at: 0, age_ms: 90_000, expires_in_ms: 200_000 } }), { status: 200 });
      }
      if (approveError) return new Response(JSON.stringify({ ok: false, error: approveError }), { status: 404 });
      return new Response(JSON.stringify({ ok: true, value: { approved: true, label: "Chrome on macOS" } }), { status: 200 });
    });
    return sent;
  }

  function io(answer?: string | null) {
    const out: string[] = [];
    const err: string[] = [];
    const asked: string[] = [];
    const base = { out: (t: string) => void out.push(t), err: (t: string) => void err.push(t) };
    // null: no terminal (no `ask`); a string or undefined: the person's answer (undefined: end of input).
    const full = answer === null ? base : { ...base, ask: async (p: string) => (asked.push(p), answer) };
    return { io: full, out, err, asked };
  }

  it("shows who asked, asks, and approves on y", async () => {
    const sent = board();
    const t = io("y");
    expect(await run(["web-login", "abcd-2345"], env, t.io)).toBe(0);
    expect(sent.map((s) => s.tool)).toEqual(["bbs_web_pairing_show", "bbs_web_pairing_approve"]);
    expect(sent.every((s) => JSON.stringify(s.args) === '{"code":"abcd-2345"}' && s.client === "cli")).toBe(true);
    expect(t.err.join("\n")).toContain("Sign-in request from Chrome on macOS, made 1 min ago; the code has 3 min left.");
    expect(t.asked).toEqual(["Approve? [y/N] "]);
    expect(JSON.parse(t.out[0] ?? "")).toEqual({ approved: true, label: "Chrome on macOS" });
  });

  it("does nothing on anything but yes", async () => {
    for (const answer of ["", "n", "no", "maybe", undefined]) {
      const sent = board();
      const t = io(answer);
      expect(await run(["web-login", "ABCD-2345"], env, t.io), String(answer)).toBe(20);
      expect(sent.map((s) => s.tool)).toEqual(["bbs_web_pairing_show"]);
      expect(t.out).toEqual([]);
    }
  });

  it("--yes approves without asking, with or without a terminal", async () => {
    for (const t of [io(null), io("n")]) {
      const sent = board();
      expect(await run(["web-login", "ABCD-2345", "--yes"], env, t.io)).toBe(0);
      expect(sent.map((s) => s.tool)).toEqual(["bbs_web_pairing_show", "bbs_web_pairing_approve"]);
      expect(t.asked).toEqual([]);
    }
  });

  it("refuses without --yes when stdin is not a terminal, before calling the board", async () => {
    const sent = board();
    const t = io(null);
    expect(await run(["web-login", "ABCD-2345"], env, t.io)).toBe(2);
    expect(sent).toEqual([]);
    expect(t.err.join("\n")).toContain("pass --yes");
  });

  it("maps board errors to the usual exit codes, and checks its arguments", async () => {
    board({ code: "not_found", message: "no live pairing code matches that code" });
    const t = io("y");
    expect(await run(["web-login", "ABCD-2345"], env, t.io)).toBe(30);
    expect(t.err.join("\n")).toContain("not_found: no live pairing code matches that code");
    expect(await run(["web-login"], env, t.io)).toBe(2);
    expect(await run(["web-login", "A", "B"], env, t.io)).toBe(2);
    expect(await run(["web-login", "A", "--nope"], env, t.io)).toBe(2);
  });

  it("web-revoke takes the session id positionally or --all", async () => {
    const sent = board();
    const quiet = { out: () => undefined, err: () => undefined };
    expect(await run(["web-revoke", "ws_abc"], env, quiet)).toBe(0);
    expect(await run(["web-revoke", "--all"], env, quiet)).toBe(0);
    expect(sent.map((s) => [s.tool, s.args])).toEqual([
      ["bbs_web_session_revoke", { id: "ws_abc" }],
      ["bbs_web_session_revoke", { all: true }],
    ]);
  });
});

describe("waiting for a passkey's approval (issue #54)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const env = { BBS_URL: "http://board.test", BBS_TOKEN: "t" };
  const START = Date.UTC(2026, 10, 24, 12, 0, 0);
  const required = {
    status: "approval_required",
    approval: "secret-approval-id",
    match_code: "K7M2QX",
    url: "https://app.example/approve#secret-approval-id",
    expires_at: new Date(START + 5 * 60_000).toISOString(),
  };

  /** A clock whose sleep moves time forward and records the span; nothing really waits. */
  function clock() {
    let t = START;
    const slept: number[] = [];
    return { c: { now: () => t, sleep: async (ms: number) => void (slept.push(ms), (t += ms)) }, slept };
  }

  /** A board that answers the gated tool with approval_required, then the status calls from `statuses` in order. */
  function board(tool: string, statuses: (Record<string, unknown> | { error: { code: string; message: string } })[]) {
    const sent: { tool: string; args: unknown }[] = [];
    let polls = 0;
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      const name = url.split("/").at(-1) as string;
      sent.push({ tool: name, args: JSON.parse(String(init.body)) });
      if (name === "bbs_web_pairing_show") {
        return new Response(JSON.stringify({ ok: true, value: { label: "Chrome on macOS", age_ms: 1_000, expires_in_ms: 200_000 } }), { status: 200 });
      }
      if (name === tool) return new Response(JSON.stringify({ ok: true, value: required }), { status: 200 });
      if (name === "bbs_approval_status") {
        const next = statuses[Math.min(polls++, statuses.length - 1)] as Record<string, unknown>;
        if ("error" in next) return new Response(JSON.stringify({ ok: false, error: next.error }), { status: 404 });
        return new Response(JSON.stringify({ ok: true, value: { action: "web_pairing_approve", match_code: "K7M2QX", ...next } }), { status: 200 });
      }
      throw new Error(`unexpected call ${name}`);
    });
    return sent;
  }

  function io() {
    const out: string[] = [];
    const err: string[] = [];
    return { io: { out: (t: string) => void out.push(t), err: (t: string) => void err.push(t) }, out, err };
  }

  it("web-login prints the match code and link, polls every 2 seconds, and ends with the normal result when approved", async () => {
    const sent = board("bbs_web_pairing_approve", [{ status: "pending" }, { status: "pending" }, { status: "approved" }]);
    const t = io();
    const k = clock();
    expect(await run(["web-login", "ABCD-2345", "--yes"], env, t.io, undefined, k.c)).toBe(0);
    expect(sent.map((s) => s.tool)).toEqual([
      "bbs_web_pairing_show",
      "bbs_web_pairing_approve",
      "bbs_approval_status",
      "bbs_approval_status",
      "bbs_approval_status",
    ]);
    expect(sent.at(-1)?.args).toEqual({ approval: "secret-approval-id" });
    expect(k.slept).toEqual([2_000, 2_000, 2_000]);
    const said = t.err.join("\n");
    expect(said).toContain("Match code: K7M2QX");
    expect(said).toContain("in the browser that shows the sign-in code, or at the link: https://app.example/approve#secret-approval-id");
    expect(JSON.parse(t.out[0] ?? "")).toEqual({ approved: true, label: "Chrome on macOS" });
  });

  it("exits 20 (nothing done) when the board says the request expired", async () => {
    board("bbs_web_pairing_approve", [{ status: "pending" }, { status: "expired" }]);
    const t = io();
    expect(await run(["web-login", "ABCD-2345", "--yes"], env, t.io, undefined, clock().c)).toBe(20);
    expect(t.err.join("\n")).toContain("the approval request expired; nothing done");
    expect(t.out).toEqual([]);
  });

  it("exits 20 when the request was replaced or cleaned up (the status call finds nothing)", async () => {
    board("bbs_web_pairing_approve", [{ error: { code: "not_found", message: "no such approval request" } }]);
    const t = io();
    expect(await run(["web-login", "ABCD-2345", "--yes"], env, t.io, undefined, clock().c)).toBe(20);
    expect(t.err.join("\n")).toContain("expired or was replaced");
  });

  it("gives up shortly after the request's own expiry even if the board keeps saying pending", async () => {
    board("bbs_web_pairing_approve", [{ status: "pending" }]);
    const t = io();
    const k = clock();
    expect(await run(["web-login", "ABCD-2345", "--yes"], env, t.io, undefined, k.c)).toBe(20);
    // 5 minutes plus the 30 s grace, in 2 s steps.
    expect(k.slept.length).toBeGreaterThan(100);
    expect(k.slept.length).toBeLessThan(200);
  });

  it("passkey remove waits the same way and reports the removal", async () => {
    const sent = board("bbs_passkey_remove", [{ status: "approved", action: "passkey_remove" }]);
    const t = io();
    expect(await run(["passkey", "remove", "pk_abc"], env, t.io, undefined, clock().c)).toBe(0);
    expect(sent.map((s) => s.tool)).toEqual(["bbs_passkey_remove", "bbs_approval_status"]);
    expect(t.err.join("\n")).toContain("in the browser, at the link");
    expect(JSON.parse(t.out[0] ?? "")).toEqual({ removed: "pk_abc", approved: true });
  });

  it("another error from the status call ends the wait with that error's exit code", async () => {
    board("bbs_web_pairing_approve", [{ error: { code: "unauthorized", message: "no" } }]);
    expect(await run(["web-login", "ABCD-2345", "--yes"], env, io().io, undefined, clock().c)).toBe(10);
  });
});

describe("bbs join reports this machine and its operating system", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const host = (over: Partial<HostFacts> = {}): HostFacts => ({
    hostname: () => "workstation-1.example.test",
    platform: () => "linux",
    type: () => "Linux",
    release: () => "6.8.0",
    ...over,
  });

  /** Run `bbs <argv>` with a fake board and the given host; returns the body sent. */
  async function joinBody(argv: string[], h: HostFacts): Promise<Record<string, unknown>> {
    let body: Record<string, unknown> = {};
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      body = JSON.parse(String(init.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ ok: true, value: { session: "s_x" } }), { status: 200 });
    });
    const io = { out: () => undefined, err: () => undefined };
    expect(await run(argv, { BBS_URL: "http://board.test", BBS_TOKEN: "t" }, io, h)).toBe(0);
    return body;
  }

  it("fills machine (cut at the first dot) and os when they are not given", async () => {
    expect(await joinBody(["join", "--role", "builder"], host())).toEqual({
      role: "builder",
      machine: "workstation-1",
      os: "Linux",
    });
  });

  it("an explicit --machine or --os wins, and --model is passed through", async () => {
    expect(await joinBody(["join", "--machine", "laptop-2", "--os", "Plan 9", "--model", "gpt-5"], host())).toEqual({
      machine: "laptop-2",
      os: "Plan 9",
      model: "gpt-5",
    });
  });

  it("an empty --machine or --os sends none of that label", async () => {
    expect(await joinBody(["join", "--machine", "", "--os="], host())).toEqual({});
    expect(await joinBody(["join", "--machine", ""], host())).toEqual({ os: "Linux" });
  });

  it("says on stderr that nothing will ring a session whose join result has wake none", async () => {
    const h = host();
    const errs: string[] = [];
    const io = { out: () => undefined, err: (m: string) => void errs.push(m) };
    const join = async (value: Record<string, unknown>): Promise<number> => {
      vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ ok: true, value }), { status: 200 }));
      return run(["join"], { BBS_URL: "http://board.test", BBS_TOKEN: "t" }, io, h);
    };
    expect(await join({ session: "s_x", wake: "none" })).toBe(0);
    expect(errs.join("\n")).toMatch(/nothing will ring this session.*bbs inbox/);
    errs.length = 0;
    expect(await join({ session: "s_x", wake: "adapter" })).toBe(0);
    expect(errs).toEqual([]);
  });

  it("sends --harness-session as harness_session and says on stderr which handle the session acts as", async () => {
    expect(await joinBody(["join", "--harness-session", "hs-1", "--machine", "", "--os", ""], host())).toEqual({ harness_session: "hs-1" });
    const errs: string[] = [];
    const outs: string[] = [];
    const io = { out: (m: string) => void outs.push(m), err: (m: string) => void errs.push(m) };
    vi.stubGlobal(
      "fetch",
      async () => new Response(JSON.stringify({ ok: true, value: { handle: "p-ab2c", parent: "p", session: "s_x", wake: "adapter" } }), { status: 200 }),
    );
    expect(await run(["join", "--harness-session", "hs-1"], { BBS_URL: "http://board.test", BBS_TOKEN: "t" }, io, host())).toBe(0);
    expect(errs.join("\n")).toMatch(/this session acts as p-ab2c.*under p\..*--session or BBS_SESSION/);
    expect(JSON.parse(outs.join(""))).toMatchObject({ handle: "p-ab2c", parent: "p" });
  });

  it("other verbs are left alone", async () => {
    expect(await joinBody(["who"], host())).toEqual({});
  });

  it("forms the operating system string", () => {
    const os = (platform: string, type: string, release: string) =>
      osLabel(host({ platform: () => platform, type: () => type, release: () => release }));
    expect(os("darwin", "Darwin", "24.1.0")).toBe("macOS");
    expect(os("linux", "Linux", "6.8.0-generic")).toBe("Linux");
    expect(os("win32", "Windows_NT", "10.0.22631")).toBe("Windows 11");
    expect(os("win32", "Windows_NT", "10.0.19045")).toBe("Windows 10");
    expect(os("win32", "Windows_NT", "6.3.9600")).toBe("Windows");
    expect(os("freebsd", "FreeBSD", "14.1-RELEASE")).toBe("FreeBSD 14");
    expect(os("sunos", "SunOS", "weird")).toBe("SunOS");
  });

  it("short host names", () => {
    expect(shortHostName(host({ hostname: () => "box" }))).toBe("box");
    expect(shortHostName(host({ hostname: () => "a.b.c" }))).toBe("a");
    expect(withHostLabels({}, host({ hostname: () => "" }))).toEqual({ os: "Linux" });
  });
});

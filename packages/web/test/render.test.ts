// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0

// M5 web view: rendering puts user text only into text nodes and attribute
// values (XSS), shows status as text and shape, and the shipped files load
// nothing from elsewhere, never parse HTML from strings, keep the credential
// out of localStorage, and make no sound. Runs under plain Node with a small
// fake document; the real page is checked in a browser by scripts/web-check.mjs.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ago,
  auditTable,
  exportSummary,
  flagBadge,
  h,
  needsYou,
  passkeyList,
  span,
  userCards,
  messageItem,
  sessionBadge,
  statusBadge,
  taskBoard,
  TASK_COLUMNS,
  topicList,
  whoTable,
} from "../public/render.js";
import { describeScope } from "../public/approval.js";

/** The parts of the DOM render.js uses, recorded as a tree. */
class FakeText {
  readonly nodeType = 3;
  constructor(readonly data: string) {}
}

class FakeElement {
  readonly nodeType = 1;
  readonly attributes = new Map<string, string>();
  readonly children: (FakeElement | FakeText)[] = [];
  constructor(readonly tagName: string) {}
  setAttribute(k: string, v: string): void {
    this.attributes.set(k, String(v));
  }
  appendChild<T extends FakeElement | FakeText>(c: T): T {
    this.children.push(c);
    return c;
  }
  /** Concatenated text of all descendants. */
  get text(): string {
    return this.children.map((c) => (c instanceof FakeText ? c.data : c.text)).join("");
  }
  *all(): Generator<FakeElement> {
    for (const c of this.children) {
      if (c instanceof FakeElement) {
        yield c;
        yield* c.all();
      }
    }
  }
  /** Every text node below, in order. */
  *texts(): Generator<string> {
    for (const c of this.children) {
      if (c instanceof FakeText) yield c.data;
      else yield* c.texts();
    }
  }
}

const doc = {
  createElement: (tag: string) => new FakeElement(tag.toUpperCase()),
  createTextNode: (data: string) => new FakeText(data),
} as unknown as Document;

const tree = (n: unknown): FakeElement => n as FakeElement;

const HOSTILE = `<img src=x onerror="alert(1)"><script>alert(2)</script>"'&`;

describe("XSS: user text becomes text nodes only", () => {
  it("a message body, author and via render as text, creating no elements from them", () => {
    const li = tree(
      messageItem(doc, {
        author: HOSTILE,
        kind: "agent",
        via: HOSTILE,
        topic: "t",
        seq: 7,
        created_at: T(0),
        reply_to: null,
        is_system: false,
        body: HOSTILE,
      }),
    );
    const tags = [...li.all()].map((e) => e.tagName);
    expect(tags).not.toContain("IMG");
    expect(tags).not.toContain("SCRIPT");
    expect([...li.texts()]).toContain(HOSTILE);
    for (const e of li.all()) for (const v of e.attributes.values()) expect(v).not.toContain("<");
  });

  it("topic names go into an href only after encodeURIComponent, and descriptions into title as text", () => {
    const ul = tree(
      topicList(doc, [{ name: 'x"><script>', description: HOSTILE, state: "active", unread: 2, messages: 3, level: "wake" }], undefined),
    );
    const a = [...ul.all()].find((e) => e.tagName === "A");
    expect(a?.attributes.get("href")).toBe(`#topic/${encodeURIComponent('x"><script>')}`);
    expect(a?.attributes.get("href")?.startsWith("#")).toBe(true);
    expect(a?.attributes.get("title")).toBe(HOSTILE);
    expect([...ul.all()].map((e) => e.tagName)).not.toContain("SCRIPT");
    expect(ul.text).toContain("2 unread");
  });

  it("task titles, who rows and audit details render as text", () => {
    const board = tree(
      taskBoard(doc, [{ id: 1, topic: "t", title: HOSTILE, state: "in_progress", stale: true, assignee: HOSTILE, blocked_by: [] }]),
    );
    const who = tree(
      whoTable(doc, [
        { handle: HOSTILE, kind: "agent", role: HOSTILE, status: "active", session: "busy", coordinator: true, admin: false, last_seen: null, harness: null },
      ]),
    );
    const audit = tree(
      auditTable(doc, [
        { seq: 1, ts: T(0), actor: HOSTILE, actor_kind: "agent", via: "api", action: "post", target_type: "message", target_id: "1", topic: "t", result: "denied", detail: { body: HOSTILE }, request_id: null },
      ]),
    );
    for (const t of [board, who, audit]) {
      const tags = [...t.all()].map((e) => e.tagName);
      expect(tags).not.toContain("IMG");
      expect(tags).not.toContain("SCRIPT");
    }
    expect([...board.texts()]).toContain(HOSTILE);
    expect([...who.texts()]).toContain(HOSTILE);
    expect(audit.text).toContain(JSON.stringify({ body: HOSTILE }));
  });

  it("h() turns strings into text nodes and sets attributes, nothing more", () => {
    const el = tree(h(doc, "div", { title: HOSTILE }, [HOSTILE, 3, null, false]));
    expect(el.children).toEqual([new FakeText(HOSTILE), new FakeText("3")]);
    expect(el.attributes.get("title")).toBe(HOSTILE);
  });
});

describe("who is online (review m2)", () => {
  it("shows people by when they were last seen, agents by session state", () => {
    const t = tree(
      whoTable(doc, [
        { handle: "owner", kind: "human", role: "", status: "active", session: "offline", coordinator: false, admin: true, last_seen: T(0), harness: null },
        { handle: "alice", kind: "agent", role: "", status: "active", session: "busy", coordinator: false, admin: false, last_seen: T(0), harness: null },
      ]),
    );
    const rows = [...t.all()].filter((e) => e.tagName === "TR").slice(1).map((r) => r.text);
    expect(rows[0]).toContain("last seen");
    expect(rows[0]).not.toContain("offline");
    expect(rows[1]).toContain("busy");
  });
});

describe("who is online groups a session handle under its parent (issue #98)", () => {
  const user = (handle: string, over: Record<string, unknown> = {}) => ({
    handle,
    kind: "agent",
    role: "",
    status: "active",
    session: "idle",
    coordinator: false,
    admin: false,
    last_seen: T(0),
    harness: null,
    ...over,
  });

  it("lists the handles after their parent, as text, and shows retired as text", () => {
    const t = tree(
      whoTable(doc, [
        user("alice"),
        user("alice-ab2c", { parent: "alice" }),
        user("bob"),
        user("alice-q7xz", { parent: "alice", status: "retired", session: "offline" }),
      ]),
    );
    const rows = [...t.all()].filter((e) => e.tagName === "TR").slice(1).map((r) => r.text);
    expect(rows).toHaveLength(4);
    expect(rows[0]).toMatch(/^alice/);
    expect(rows[1]).toContain("alice-ab2c, a session of alice");
    expect(rows[2]).toContain("alice-q7xz, a session of alice");
    expect(rows[2]).toContain("retired");
    expect(rows[3]).toMatch(/^bob/);
  });

  it("keeps a session handle whose parent is not listed", () => {
    const t = tree(whoTable(doc, [user("alice-ab2c", { parent: "alice" }), user("bob")]));
    const rows = [...t.all()].filter((e) => e.tagName === "TR").slice(1).map((r) => r.text);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain("alice-ab2c, a session of alice");
  });
});

describe("who is online shows each session's labels as text (session labels)", () => {
  const user = (over: Record<string, unknown>) => ({
    handle: "alice",
    kind: "agent",
    role: "",
    status: "active",
    session: "idle",
    coordinator: false,
    admin: false,
    last_seen: T(0),
    harness: null,
    ...over,
  });

  it("puts harness and model in one cell and machine and OS in another", () => {
    const t = tree(
      whoTable(doc, [
        user({ harness: "claude-code", model: "claude-opus-5-5", machine: "workstation-1", os: "macOS" }),
        user({ handle: "claude-ai", harness: "Claude", model: null, machine: null, os: null }),
        user({ handle: "old" }),
      ]),
    );
    const heads = [...t.all()].filter((e) => e.tagName === "TH").map((e) => e.text);
    expect(heads).toContain("Harness and model");
    expect(heads).toContain("Machine and OS");
    const rows = [...t.all()].filter((e) => e.tagName === "TR").slice(1);
    const cells = (i: number) => [...rows[i]!.all()].filter((e) => e.tagName === "TD").map((e) => e.text);
    expect(cells(0)).toContain("claude-code, claude-opus-5-5");
    expect(cells(0)).toContain("workstation-1, macOS");
    expect(cells(1)).toContain("Claude");
    expect(cells(2).filter((c) => /claude|macOS|workstation/.test(c))).toEqual([]);
  });

  it("shows each session's wake as text: can be rung for an adapter, else cannot be rung", () => {
    const t = tree(whoTable(doc, [user({ sessions: [{ wake: "adapter" }, { wake: "none" }] })]));
    expect(t.text).toContain("can be rung, cannot be rung");
    expect(tree(whoTable(doc, [user({ sessions: [] })])).text).not.toContain("be rung");
  });

  it("renders hostile labels as text nodes only", () => {
    const t = tree(whoTable(doc, [user({ harness: HOSTILE, model: HOSTILE, machine: HOSTILE, os: HOSTILE })]));
    expect([...t.all()].map((e) => e.tagName)).not.toContain("IMG");
    expect([...t.all()].map((e) => e.tagName)).not.toContain("SCRIPT");
    expect(t.text).toContain(`${HOSTILE}, ${HOSTILE}`);
  });
});

describe("status is text and shape, never color alone", () => {
  it("every session state, account status and audit result has a word and a glyph", () => {
    for (const [fn, values] of [
      [sessionBadge, ["busy", "idle", "offline"]],
      [statusBadge, ["active", "muted_lobby", "kicked"]],
    ] as const) {
      const seen = new Set<string>();
      for (const v of values) {
        const b = tree(fn(doc, v));
        const [shape, word] = [...b.texts()];
        expect(shape?.trim().length, v).toBe(1);
        expect(word?.trim().length, v).toBeGreaterThan(1);
        seen.add(`${shape}`);
      }
      // Distinct shapes, so the states differ even in grayscale.
      expect(seen.size).toBe(values.length);
    }
  });

  it("every message carries its author's kind as a word and a shape (F review N07)", () => {
    const badges = (kind: string): string[] => {
      const li = tree(
        messageItem(doc, { author: "a", kind, via: "web", topic: "t", seq: 1, created_at: T(0), reply_to: null, is_system: false, body: "b" }),
      );
      return [...li.all()]
        .filter((e) => (e.attributes.get("class") ?? "").startsWith("badge kind-"))
        .map((e) => `${e.attributes.get("class")}|${e.text}`);
    };
    expect(badges("human")).toEqual(["badge kind-human|■ human"]);
    expect(badges("agent")).toEqual(["badge kind-agent|◆ agent"]);
    expect(badges("system")).toEqual(["badge kind-system|○ system"]);
  });

  it("the task board has one labeled column per state with a count", () => {
    const board = tree(taskBoard(doc, []));
    const headings = [...board.all()].filter((e) => e.tagName === "H3").map((e) => e.text);
    expect(headings).toHaveLength(TASK_COLUMNS.length);
    for (const hd of headings) expect(hd).toMatch(/^\S \S.* \(0\)$/);
  });

  it("a blocked task names its blockers by id and state", () => {
    const board = tree(
      taskBoard(doc, [
        { id: 2, topic: "t", title: "b", state: "blocked", stale: false, assignee: null, blocked_by: [{ id: 1, state: "in_progress" }] },
      ]),
    );
    expect(board.text).toContain("blocked by #1 (in progress)");
  });
});

describe("shipped files", () => {
  const dir = join(import.meta.dirname, "..", "public");
  // Every file under public/, including the consent page's `oauth/authorize.html` (issue #55).
  const files = readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => {
      const name = join(e.parentPath, e.name).slice(dir.length + 1);
      return { name, text: readFileSync(join(dir, name), "utf8") };
    });
  const code = (t: string): string => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("load nothing from another origin (no CDN, no external fonts)", () => {
    // The SVG namespace name is an identifier, not something loaded.
    const strip = (t: string): string => t.replaceAll('xmlns="http://www.w3.org/2000/svg"', "");
    for (const f of files) expect(strip(f.text), f.name).not.toMatch(/https?:\/\/|\/\/[a-z0-9.-]+\.[a-z]{2,}\//i);
  });

  it("never parse HTML from strings, never eval, and keep no credential in any web storage", () => {
    for (const f of files.filter((x) => x.name.endsWith(".js"))) {
      expect(code(f.text), f.name).not.toMatch(
        /innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function|localStorage/,
      );
    }
    // The session is an HttpOnly cookie the page cannot read (issue #47): no
    // script of the page touches any web storage, and none names a bearer
    // token or the old client header.
    for (const f of files.filter((x) => x.name.endsWith(".js"))) {
      expect(code(f.text), f.name).not.toMatch(/sessionStorage|localStorage|indexedDB|document\.cookie|authorization|x-bbs-client/i);
    }
    // Both pages post through the shared module, which sends the cookie.
    expect(code(files.find((f) => f.name === "signin.js")?.text ?? "")).toContain('credentials: "same-origin"');
  });

  it("keep the consent page's request id and the address out of storage, and navigate only with location.assign (issue #55)", () => {
    const page = code(files.find((f) => f.name === "authorize.js")?.text ?? "");
    expect(page).toContain("location.assign(to)");
    expect(page).not.toMatch(/location\.(hash|href|search)\s*=|location\.replace|history\.(push|replace)State|window\.open|\bopen\(/);
    expect(page).not.toMatch(/<form|requestSubmit|\.submit\(|autofocus/);
    const html = files.find((f) => f.name === "oauth/authorize.html")?.text ?? "";
    expect(html).not.toMatch(/<form|autofocus/i);
    expect(html).toContain('src="/authorize.js"');
  });

  it("keep the approval id out of storage and the address: the approving page reads the fragment once and removes it (issue #54)", () => {
    const names = files.map((f) => f.name);
    for (const n of ["approval.js", "approve.js", "webauthn.js", "approve.html"]) expect(names, n).toContain(n);
    const page = code(files.find((f) => f.name === "approve.js")?.text ?? "");
    expect(page).toContain('history.replaceState(null, "", location.pathname + location.search)');
    expect(page.indexOf("location.hash")).toBeLessThan(page.indexOf("history.replaceState"));
    expect(page).not.toMatch(/location\.(href|search)\s*=|location\.assign|window\.open/);
    // Only the approving page touches the address; the panel and the pages around it never do.
    for (const n of ["approval.js", "webauthn.js", "signin.js"]) {
      expect(code(files.find((f) => f.name === n)?.text ?? ""), n).not.toMatch(/location\.hash|history\.(push|replace)State/);
    }
    expect(files.find((f) => f.name === "approve.html")?.text).toContain('src="/approve.js"');
    // The panel posts only to the board's two approval endpoints and sets what it shows as text.
    const panel = code(files.find((f) => f.name === "approval.js")?.text ?? "");
    expect(panel).toContain("/api/web/approval/start");
    expect(panel).toContain("/api/web/approval/finish");
    expect(panel).toContain("Approve with security key");
  });

  it("open no modal dialogs (G5: the Admin tab confirms in the page)", () => {
    for (const f of files.filter((x) => x.name.endsWith(".js"))) {
      expect(code(f.text), f.name).not.toMatch(/\b(confirm|alert|prompt)\(|showModal\(/);
    }
  });

  it("keep a new token only in the panel's field, cleared on dismiss, never in the address or storage (G5)", () => {
    const app = code(files.find((f) => f.name === "app.js")?.text ?? "");
    // Nothing is stored at all (see above).
    expect(app).not.toMatch(/Storage\.setItem|storage\.setItem/);
    expect(app).not.toMatch(/location\.(hash|href|search)\s*=|history\.(push|replace)State/);
    expect(app).toMatch(/function dismissToken\(\) \{\s*\(el\("token-value"\)\)\.value = "";/);
    // Copy happens in the click handler, with a select-the-text fallback.
    expect(app).toMatch(/navigator\.clipboard\.writeText\(input\.value\)/);
    expect(app).toMatch(/input\.select\(\)/);
  });

  it("make no sound", () => {
    for (const f of files) expect(code(f.text), f.name).not.toMatch(/<audio|new Audio|AudioContext|\.play\(|speechSynthesis/i);
  });

  it("have no inline script or style, so the Content-Security-Policy can forbid them", () => {
    const pages = files.filter((f) => f.name.endsWith(".html"));
    expect(pages.map((f) => f.name).sort()).toEqual(["approve.html", "index.html", "oauth/authorize.html"]);
    for (const f of pages) {
      expect(f.text, f.name).not.toMatch(/<script(?![^>]*\bsrc=)/);
      expect(f.text, f.name).not.toMatch(/<style|style=|\bon[a-z]+=/i);
    }
    const headers = files.find((f) => f.name === "_headers")?.text ?? "";
    expect(headers).toMatch(/Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self'/);
  });
});

// ---------------------------------------------------------------------------
// G5: the Admin tab.
// ---------------------------------------------------------------------------

const NOW = Date.UTC(2026, 10, 21, 12, 0, 0);
const MIN = 60_000;
const T = (ms: number): string => new Date(ms).toISOString();
type StatusUser = Parameters<typeof userCards>[1]["users"][number];
const agent = (handle: string, extra: Partial<StatusUser> = {}): StatusUser => ({
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
  session: { state: "idle", machine: "workstation-1", os: "macOS", model: "claude-opus-5-5", attached_at: T(NOW - 60 * MIN), busy_since: null, socket_recorded: true },
  open_sockets: 1,
  rings: [{ at: T(NOW - 2 * MIN), result: "turn_started" }],
  rings_failing_since: null,
  wake_budget: { used: 3, limit: 20, window_ends_at: T(NOW + 30 * MIN) },
  doorbell: null,
  ...extra,
});
const exportOff = {
  configured: false,
  exported_seq: 0,
  unexported_rows: 4,
  oldest_unexported_at: T(NOW - 3 * MIN),
  last_ok_at: null,
  failing_since: null,
  failures: 0,
  last_error: null,
  retry_at: null,
};
const status = (users: StatusUser[], needs_you: Parameters<typeof needsYou>[1]["needs_you"] = []) => ({
  now: T(NOW),
  users,
  audit_export: exportOff,
  needs_you,
});

describe("Admin tab (G5)", () => {
  it("a healthy board says All clear and shows no indicator on any card (dark cockpit)", () => {
    const s = status([agent("bob"), agent("alice")]);
    expect(tree(needsYou(doc, s, null)).text).toBe("✓ All clear: nothing needs you.");
    const cards = tree(userCards(doc, s, null));
    const lis = [...cards.all()].filter((e) => e.tagName === "LI");
    expect(lis.map((e) => e.attributes.get("data-handle"))).toEqual(["alice", "bob"]);
    for (const li of lis) {
      expect(li.attributes.get("class")).toBe("card");
      expect([...li.all()].some((e) => (e.attributes.get("class") ?? "").includes("badge"))).toBe(false);
    }
    expect(cards.text).toContain("idle on workstation-1 (macOS, claude-opus-5-5), attached 1 h ago; adapter connected");
    expect(cards.text).toContain("turn started 2 min ago");
    expect(cards.text).toContain("3 of 20 used, window ends in 30 min");
  });

  it("keeps cards in handle order whatever order the data comes in, agents then people", () => {
    const s = status([agent("zed"), { ...agent("owner"), kind: "human", admin: true, session: null, open_sockets: null, wake_budget: null, rings: [] }, agent("amy")]);
    const t = tree(userCards(doc, s, null));
    expect([...t.all()].filter((e) => e.tagName === "H3").map((e) => e.text)).toEqual(["Agents (2)", "People (1)"]);
    expect([...t.all()].filter((e) => e.tagName === "LI").map((e) => e.attributes.get("data-handle"))).toEqual(["amy", "zed", "owner"]);
    const owner = [...t.all()].find((e) => e.attributes.get("data-handle") === "owner");
    expect(owner?.text).not.toContain("Session");
    expect(owner?.text).not.toContain("Wake budget");
  });

  it("every flag kind has its own shape and a word, and differs from All clear", () => {
    const shapes = new Set<string>(["✓"]);
    for (const k of ["kicked", "rings_failing", "muted", "audit_export_failing"]) {
      const [shape, word] = [...tree(flagBadge(doc, k)).texts()];
      expect(shape?.trim().length, k).toBe(1);
      expect(word?.trim().length, k).toBeGreaterThan(3);
      shapes.add(String(shape));
    }
    expect(shapes.size).toBe(5);
  });

  it("each flagged item says what happened and what to do; a kicked agent offers Reinstate", () => {
    const s = status([agent("alice", { status: "kicked", kicked_at: T(NOW - 12 * MIN) })], [
      { kind: "kicked", handle: "alice", since: T(NOW - 12 * MIN), what: "alice was kicked 12 min ago.", todo: "Reinstate it.", action: "reinstate" },
      { kind: "audit_export_failing", since: T(NOW - MIN), what: "Audit export has been failing for 1 min.", todo: "Check the bucket." },
    ]);
    const t = tree(needsYou(doc, s, null));
    const items = [...t.all()].filter((e) => e.tagName === "LI");
    expect(items).toHaveLength(2);
    expect(items[0]?.text).toContain("✕ kicked alice");
    expect(items[0]?.text).toContain("alice was kicked 12 min ago.");
    expect(items[0]?.text).toContain("What to do: Reinstate it.");
    const button = [...(items[0]?.all() ?? [])].find((e) => e.tagName === "BUTTON");
    expect(button?.attributes.get("data-admin-action")).toBe("reinstate");
    expect(button?.attributes.get("data-handle")).toBe("alice");
    expect([...(items[1]?.all() ?? [])].some((e) => e.tagName === "BUTTON")).toBe(false);
    // The card repeats the state as a badge and a flagged border.
    const card = [...tree(userCards(doc, s, null)).all()].find((e) => e.attributes.get("data-handle") === "alice");
    expect(card?.attributes.get("class")).toBe("card flagged");
    expect(card?.text).toContain("kicked 12 min ago");
  });

  it("the confirm step is in the page: the chosen action's text with confirm and cancel buttons", () => {
    const s = status([agent("alice"), agent("bob", { coordinator: true })]);
    const before = tree(userCards(doc, s, null));
    const labels = [...before.all()].filter((e) => e.tagName === "BUTTON").map((e) => `${e.attributes.get("data-handle")}:${e.text}`);
    expect(labels).toEqual(["alice:Make coordinator", "bob:Remove coordinator"]);
    const open = tree(userCards(doc, s, { action: "grant", handle: "alice" }));
    const alice = [...open.all()].find((e) => e.attributes.get("data-handle") === "alice" && e.tagName === "LI");
    expect(alice?.text).toContain("Make alice a coordinator?");
    expect([...(alice?.all() ?? [])].filter((e) => e.tagName === "BUTTON").map((e) => e.attributes.get("data-admin-action"))).toEqual(["confirm", "cancel"]);
    // Only that card changes.
    const bob = [...open.all()].find((e) => e.attributes.get("data-handle") === "bob" && e.tagName === "LI");
    expect(bob?.text).not.toContain("?");
  });

  it("renders handles, roles, flag text and export errors as text only", () => {
    const s = {
      ...status([agent(HOSTILE, { role: HOSTILE, session: { state: "idle", machine: HOSTILE, os: HOSTILE, model: HOSTILE, attached_at: T(NOW), busy_since: null, socket_recorded: false } })], [
        { kind: "rings_failing", handle: HOSTILE, since: T(NOW), what: HOSTILE, todo: HOSTILE },
      ]),
      audit_export: { ...exportOff, configured: true, failing_since: T(NOW - MIN), failures: 2, last_error: HOSTILE },
    };
    for (const t of [tree(needsYou(doc, s, { action: "grant", handle: HOSTILE })), tree(userCards(doc, s, { action: "grant", handle: HOSTILE })), tree(exportSummary(doc, s))]) {
      const tags = [...t.all()].map((e) => e.tagName);
      expect(tags).not.toContain("IMG");
      expect(tags).not.toContain("SCRIPT");
      expect(t.text).toContain(HOSTILE);
    }
  });

  it("shows time as elapsed words", () => {
    expect(span(30_000)).toBe("under a minute");
    expect(span(40 * MIN)).toBe("40 min");
    expect(span(3 * 60 * MIN + 5 * MIN)).toBe("3 h 5 min");
    expect(ago(NOW, T(NOW - 12 * MIN))).toBe("12 min ago");
    expect(ago(NOW, null)).toBe("never");
    const s = status([agent("alice", { status: "muted", muted_until: T(NOW + 40 * MIN) })]);
    expect(tree(userCards(doc, s, null)).text).toContain("muted in the Lobby, 40 min left");
    expect(tree(exportSummary(doc, s)).text).toContain("off: no sink configured, rows stay in the board");
    expect(tree(exportSummary(doc, s)).text).toContain("4, oldest 3 min ago");
  });
});

// ---------------------------------------------------------------------------
// Issue #54: the Passkeys tab.

describe("passkey list", () => {
  const pk = (id: string, synced: boolean, label = "Laptop") => ({
    id,
    label,
    algorithm: "ES256",
    synced,
    created_at: "2026-11-20T12:00:00.000Z",
    last_used_at: null as string | null,
  });
  const buttons = (n: unknown) => [...tree(n).all()].filter((e) => e.tagName === "BUTTON");

  it("says in words whether each passkey syncs or is bound to one device, and when it was last used", () => {
    const ul = tree(passkeyList(doc, [pk("pk_a", true, "Phone"), pk("pk_b", false, "Security key")], undefined));
    expect(ul.text).toContain("Phone");
    expect(ul.text).toContain("synced between devices");
    expect(ul.text).toContain("device-bound");
    expect(ul.text).toContain("Last used never");
  });

  it("offers a remove button per passkey when there are several, and asks in the page before removing", () => {
    const list = [pk("pk_a", true), pk("pk_b", false)];
    expect(buttons(passkeyList(doc, list, undefined)).map((b) => [b.attributes.get("data-passkey-action"), b.attributes.get("data-id")])).toEqual([
      ["remove", "pk_a"],
      ["remove", "pk_b"],
    ]);
    const confirming = tree(passkeyList(doc, list, "pk_b"));
    expect(confirming.text).toContain('Remove the passkey "Laptop"?');
    expect(buttons(confirming).map((b) => [b.attributes.get("data-passkey-action"), b.attributes.get("data-id")])).toEqual([
      ["remove", "pk_a"],
      ["confirm", "pk_b"],
      ["cancel", "pk_b"],
    ]);
  });

  it("says in words whether each passkey can approve (issue #54), and stays quiet when the board does not say", () => {
    const withApprove = (id: string, synced: boolean, can: boolean) => ({ ...pk(id, synced), can_approve: can });
    const ul = tree(passkeyList(doc, [withApprove("pk_a", false, true), withApprove("pk_b", true, false)], undefined));
    expect(ul.text).toContain("can approve");
    expect(ul.text).toContain("cannot approve: synced between devices");
    expect(tree(passkeyList(doc, [pk("pk_a", false)], undefined)).text).not.toContain("approve");
  });

  it("gives the last passkey no button, only the CLI command", () => {
    const ul = tree(passkeyList(doc, [pk("pk_only", false)], undefined));
    expect(buttons(ul)).toHaveLength(0);
    expect(ul.text).toContain("bbs passkey remove pk_only");
  });

  it("renders a label as text, never as markup, and says so when there are none", () => {
    const ul = tree(passkeyList(doc, [pk("pk_a", false, HOSTILE), pk("pk_b", false)], undefined));
    expect([...ul.all()].map((e) => e.tagName)).not.toContain("IMG");
    expect([...ul.texts()]).toContain(HOSTILE);
    expect(tree(passkeyList(doc, [], undefined)).text).toBe("No passkeys yet.");
  });
});

describe("approval panel sentences (issue #54)", () => {
  it("say in a full sentence what each gated action does, from the scope", () => {
    expect(describeScope("web_pairing_approve", { handle: "owner", label: "Chrome on a laptop" })).toBe(
      'Sign in the browser labeled "Chrome on a laptop" as owner.',
    );
    expect(
      describeScope("oauth_decide", { client: "https://c.example/c.json", client_name: "A Client", agent: "bot", redirect_origin: "https://c.example" }),
    ).toBe("Let A Client (https://c.example/c.json) act as the agent bot; it returns to https://c.example.");
    expect(describeScope("passkey_remove", { handle: "owner", label: "Old key" })).toBe('Remove the passkey "Old key" from owner.');
  });
});

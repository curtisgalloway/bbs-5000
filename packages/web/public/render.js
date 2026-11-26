// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0
// @ts-check

/**
 * Rendering for the web view (design §12). Pure functions from board data to
 * DOM nodes, given the document to build with, so the unit tests can run
 * them against a small fake document.
 *
 * Every piece of user text (message bodies, handles, roles, topic names and
 * descriptions, task titles, audit details) goes into the page only as a
 * text node or an attribute value set with `setAttribute`. Nothing here, or
 * anywhere in the web view, parses HTML from a string: no `innerHTML`,
 * `outerHTML`, `insertAdjacentHTML` or `document.write` (a unit test scans
 * for them).
 *
 * Status is always a text label with a shape glyph; color is never the only
 * signal (red-green safe). Nothing makes a sound.
 */

/** @typedef {Pick<Document, "createElement" | "createTextNode">} Doc */
/** @typedef {string | number | Node | null | undefined | false} Child */

/**
 * Build an element. `attrs` values are set with `setAttribute` (never parsed
 * as HTML); children that are strings or numbers become text nodes.
 * @param {Doc} doc
 * @param {string} tag
 * @param {Record<string, string | undefined>} [attrs]
 * @param {Child[]} [children]
 * @returns {HTMLElement}
 */
export function h(doc, tag, attrs = {}, children = []) {
  const el = doc.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined) el.setAttribute(k, v);
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    el.appendChild(typeof c === "string" || typeof c === "number" ? doc.createTextNode(String(c)) : c);
  }
  return el;
}

/**
 * A status label: a shape glyph (hidden from screen readers) and the word.
 * @param {Doc} doc
 * @param {string} shape
 * @param {string} label
 * @param {string} cls
 */
function badge(doc, shape, label, cls) {
  return h(doc, "span", { class: `badge ${cls}` }, [
    h(doc, "span", { class: "shape", "aria-hidden": "true" }, [shape]),
    ` ${label}`,
  ]);
}

/** Author kind: who wrote it. Only `human` carries the owner's authority (design §11). */
const KIND = /** @type {const} */ ({
  human: ["■", "human"],
  agent: ["◆", "agent"],
  system: ["○", "system"],
});

/**
 * @param {Doc} doc
 * @param {string} kind
 */
export function kindBadge(doc, kind) {
  const [shape, label] = Object.hasOwn(KIND, kind) ? KIND[/** @type {keyof typeof KIND} */ (kind)] : ["?", kind];
  return badge(doc, shape, label, `kind-${Object.hasOwn(KIND, kind) ? kind : "other"}`);
}

/** Session state from `bbs_who`. */
const SESSION = { busy: ["▶", "busy"], idle: ["●", "idle"], offline: ["○", "offline"] };
/** User status from `bbs_who`. */
const STATUS = { active: ["✓", "active"], muted_lobby: ["◐", "muted in Lobby"], kicked: ["✕", "kicked"], retired: ["○", "retired"] };
/** Audit result. */
const RESULT = { ok: ["✓", "ok"], denied: ["✕", "denied"], error: ["!", "error"] };

/**
 * @param {Doc} doc
 * @param {Record<string, string[]>} table
 * @param {string} value
 * @param {string} prefix
 */
function lookupBadge(doc, table, value, prefix) {
  const known = Object.hasOwn(table, value);
  const [shape, label] = known ? /** @type {string[]} */ (table[value]) : ["?", value];
  return badge(doc, shape ?? "?", label ?? value, `${prefix}-${known ? value : "other"}`);
}

/** @param {Doc} doc @param {string} state */
export const sessionBadge = (doc, state) => lookupBadge(doc, SESSION, state, "session");
/** @param {Doc} doc @param {string} status */
export const statusBadge = (doc, status) => lookupBadge(doc, STATUS, status, "status");
/** @param {Doc} doc @param {string} result */
export const resultBadge = (doc, result) => lookupBadge(doc, RESULT, result, "result");

/** Tool results carry times as ISO 8601 text; the arithmetic is on epoch milliseconds. @param {string} t */
export const epoch = (t) => Date.parse(t);

/** @param {string | null | undefined} t */
export function formatTime(t) {
  if (t === null || t === undefined || !Number.isFinite(epoch(t))) return "never";
  const d = new Date(epoch(t));
  return d.toLocaleString(undefined, { dateStyle: "short", timeStyle: "medium" });
}

/**
 * @typedef {{ name: string, description: string, state: string, unread: number | null,
 *   messages: number, level: string }} Topic
 */

/**
 * The topic list: each a link to `#topic/<name>`, with its unread count in words.
 * @param {Doc} doc
 * @param {Topic[]} topics
 * @param {string | undefined} current
 */
export function topicList(doc, topics, current) {
  return h(
    doc,
    "ul",
    { class: "topic-list" },
    topics.map((t) =>
      h(doc, "li", {}, [
        h(
          doc,
          "a",
          {
            href: `#topic/${encodeURIComponent(t.name)}`,
            "aria-current": t.name === current ? "page" : undefined,
            title: t.description || undefined,
          },
          [`#${t.name}`],
        ),
        t.unread ? h(doc, "span", { class: "unread" }, [` ${t.unread} unread`]) : null,
        t.state !== "active" ? h(doc, "span", { class: "state" }, [` (${t.state})`]) : null,
      ]),
    ),
  );
}

/**
 * @typedef {{ author: string, kind: string, via: string, topic: string, seq: number,
 *   created_at: string, reply_to: number | null, is_system: boolean, body: string }} Message
 */

/**
 * One message: who wrote it (with the kind badge), how it arrived, when, and
 * the body as text.
 * @param {Doc} doc
 * @param {Message} m
 */
export function messageItem(doc, m) {
  return h(doc, "li", { class: `message${m.is_system ? " system" : ""}`, "data-seq": String(m.seq) }, [
    h(doc, "div", { class: "meta" }, [
      kindBadge(doc, m.kind),
      " ",
      h(doc, "strong", { class: "author" }, [m.author]),
      h(doc, "span", { class: "via" }, [` via ${m.via}`]),
      h(doc, "span", { class: "time" }, [` · ${formatTime(m.created_at)} · #${m.seq}`]),
      m.reply_to !== null ? h(doc, "span", { class: "reply" }, [` · reply to #${m.reply_to}`]) : null,
    ]),
    h(doc, "div", { class: "body" }, [m.body]),
  ]);
}

/**
 * @param {Doc} doc
 * @param {Message[]} messages
 */
export function messageList(doc, messages) {
  if (messages.length === 0) return h(doc, "p", { class: "empty" }, ["No messages yet."]);
  return h(doc, "ol", { class: "messages" }, messages.map((m) => messageItem(doc, m)));
}

/** Board columns, in the order work moves (design §8). */
export const TASK_COLUMNS = ["open", "assigned", "in_progress", "blocked", "in_review", "done", "cancelled"];
const COLUMN_LABEL = /** @type {Record<string, string>} */ ({
  open: "○ Open",
  assigned: "◔ Assigned",
  in_progress: "◑ In progress",
  blocked: "⊘ Blocked",
  in_review: "◕ In review",
  done: "● Done",
  cancelled: "✕ Cancelled",
});

/**
 * @typedef {{ id: number, topic: string, title: string, state: string, stale: boolean,
 *   assignee: string | null, blocked_by: { id: number, state: string }[] }} Task
 */

/**
 * @param {Doc} doc
 * @param {Task} t
 */
function taskCard(doc, t) {
  return h(doc, "li", { class: `task${t.stale ? " stale" : ""}`, "data-task": String(t.id) }, [
    h(doc, "div", { class: "title" }, [`#${t.id} `, t.title]),
    h(doc, "div", { class: "meta" }, [
      `#${t.topic}`,
      ` · ${t.assignee ? `assignee ${t.assignee}` : "unassigned"}`,
      t.blocked_by && t.blocked_by.length > 0
        ? ` · blocked by ${t.blocked_by.map((b) => `#${b.id} (${b.state.replace("_", " ")})`).join(", ")}`
        : null,
    ]),
    t.stale ? badge(doc, "⚠", "stale (lease ran out)", "stale-flag") : null,
  ]);
}

/**
 * The task board: one column per state, each headed by its shape and name
 * and a count.
 * @param {Doc} doc
 * @param {Task[]} tasks
 */
export function taskBoard(doc, tasks) {
  return h(
    doc,
    "div",
    { class: "task-board" },
    TASK_COLUMNS.map((state) => {
      const inCol = tasks.filter((t) => t.state === state);
      return h(doc, "section", { class: `column column-${state}`, "aria-label": state.replace("_", " ") }, [
        h(doc, "h3", {}, [`${COLUMN_LABEL[state] ?? state} (${inCol.length})`]),
        h(doc, "ul", {}, inCol.map((t) => taskCard(doc, t))),
      ]);
    }),
  );
}

/**
 * @typedef {{ handle: string, kind: string, role: string, status: string, session: string,
 *   coordinator: boolean, admin: boolean, last_seen: string | null, harness: string | null,
 *   machine?: string | null, os?: string | null, model?: string | null,
 *   parent?: string, sessions?: { wake: string }[] }} User
 */

/**
 * The labels a session reported, joined for one cell ("workstation-1, macOS");
 * the empty string when it reported none.
 * @param {(string | null | undefined)[]} labels
 */
function labelList(labels) {
  return labels.filter((l) => typeof l === "string" && l !== "").join(", ");
}

/**
 * Whether each live session can be rung, as text ("can be rung" for an adapter,
 * else "cannot be rung"), one entry per session joined with a comma; the empty
 * string for a user with no live session.
 * @param {User} u
 */
function wakeText(u) {
  return (u.sessions ?? []).map((s) => (s.wake === "adapter" ? "can be rung" : "cannot be rung")).join(", ");
}

/**
 * The users with each session handle (issue #98: a handle made for one local
 * session, with a `parent`) placed right after its parent, in the order the
 * board gave. One whose parent is not in the list stays where it was.
 * @param {User[]} users
 * @returns {User[]}
 */
export function groupedByParent(users) {
  const handles = new Set(users.map((u) => u.handle));
  const out = [];
  for (const u of users) {
    if (u.parent !== undefined && handles.has(u.parent)) continue;
    out.push(u);
    for (const c of users) if (c.parent === u.handle) out.push(c);
  }
  return out;
}

/**
 * The handle cell: the handle, and for a session handle the handle it belongs
 * to, as text ("alice-ab2c, a session of alice").
 * @param {User} u
 */
function handleText(u) {
  return u.parent === undefined ? u.handle : `${u.handle}, a session of ${u.parent}`;
}

/**
 * Who is online: session state and account status, both as text and shape.
 * Session handles are listed under their parent.
 * @param {Doc} doc
 * @param {User[]} users
 */
export function whoTable(doc, users) {
  const head = ["Handle", "Kind", "Session or presence", "Wake", "Status", "Flags", "Role", "Harness and model", "Machine and OS", "Last seen"];
  return h(doc, "table", { class: "who" }, [
    h(doc, "thead", {}, [h(doc, "tr", {}, head.map((c) => h(doc, "th", { scope: "col" }, [c])))]),
    h(
      doc,
      "tbody",
      {},
      groupedByParent(users).map((u) =>
        h(doc, "tr", {}, [
          h(doc, "td", {}, [handleText(u)]),
          h(doc, "td", {}, [kindBadge(doc, u.kind)]),
          // People never join a session (review m2): show when they were last active.
          h(doc, "td", {}, [
            u.kind === "human"
              ? h(doc, "span", { class: "last-seen" }, [`last seen ${formatTime(u.last_seen)}`])
              : sessionBadge(doc, u.session),
          ]),
          h(doc, "td", {}, [u.kind === "human" ? "" : wakeText(u)]),
          h(doc, "td", {}, [statusBadge(doc, u.status)]),
          h(doc, "td", {}, [[u.admin ? "admin" : "", u.coordinator ? "coordinator" : ""].filter(Boolean).join(", ")]),
          h(doc, "td", {}, [u.role]),
          h(doc, "td", {}, [labelList([u.harness, u.model])]),
          h(doc, "td", {}, [labelList([u.machine, u.os])]),
          h(doc, "td", {}, [formatTime(u.last_seen)]),
        ]),
      ),
    ),
  ]);
}

/**
 * @typedef {{ seq: number, ts: string, actor: string, actor_kind: string, via: string,
 *   action: string, target_type: string | null, target_id: string | null, topic: string | null,
 *   result: string, detail: unknown, request_id: string | null }} AuditEvent
 */

/**
 * @param {Doc} doc
 * @param {AuditEvent[]} events
 */
export function auditTable(doc, events) {
  if (events.length === 0) return h(doc, "p", { class: "empty" }, ["No audit rows match."]);
  const head = ["Seq", "Time", "Actor", "Via", "Action", "Target", "Topic", "Result", "Detail"];
  return h(doc, "table", { class: "audit" }, [
    h(doc, "thead", {}, [h(doc, "tr", {}, head.map((c) => h(doc, "th", { scope: "col" }, [c])))]),
    h(
      doc,
      "tbody",
      {},
      events.map((e) =>
        h(doc, "tr", {}, [
          h(doc, "td", {}, [e.seq]),
          h(doc, "td", {}, [formatTime(e.ts)]),
          h(doc, "td", {}, [e.actor, " ", kindBadge(doc, e.actor_kind)]),
          h(doc, "td", {}, [e.via]),
          h(doc, "td", {}, [e.action]),
          h(doc, "td", {}, [e.target_type ? `${e.target_type} ${e.target_id ?? ""}` : ""]),
          h(doc, "td", {}, [e.topic ? `#${e.topic}` : ""]),
          h(doc, "td", {}, [resultBadge(doc, e.result)]),
          h(doc, "td", { class: "detail" }, [JSON.stringify(e.detail)]),
        ]),
      ),
    ),
  ]);
}

// ---------------------------------------------------------------------------
// Admin tab (G5): board health and user management, for the human admin.
//
// Design (docs/BBS-5000-design.md §12, "Admin tab"): dark cockpit (a healthy
// board shows no indicators, and an explicit "All clear" when nothing needs
// a person); every flagged item says what happened and what to do; state by
// position, shape and text, never color alone; one card per user in a stable
// order (by handle); flagged items also listed in the fixed "Needs you" area
// at the top; elapsed time, not timestamps; no modal dialogs, no sound.
// ---------------------------------------------------------------------------

/**
 * A span as words: "under a minute", "12 min", "3 h 5 min", "2 d 4 h" (like core's formatSpan).
 * @param {number} ms
 */
export function span(ms) {
  const min = Math.floor(Math.max(0, ms) / 60_000);
  if (min < 1) return "under a minute";
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return min % 60 === 0 ? `${h} h` : `${h} h ${min % 60} min`;
  const d = Math.floor(h / 24);
  return h % 24 === 0 ? `${d} d` : `${d} d ${h % 24} h`;
}

/** @param {number} now epoch milliseconds @param {string | null | undefined} t */
export function ago(now, t) {
  return t === null || t === undefined ? "never" : `${span(now - epoch(t))} ago`;
}

/** Flag kinds from `bbs_admin_status`: a distinct shape and a word each. */
const FLAG = /** @type {Record<string, [string, string]>} */ ({
  kicked: ["✕", "kicked"],
  rings_failing: ["↯", "rings failing"],
  muted: ["◐", "muted in Lobby"],
  audit_export_failing: ["⚠", "audit export"],
});

/** @param {Doc} doc @param {string} kind */
export function flagBadge(doc, kind) {
  const known = Object.hasOwn(FLAG, kind);
  const [shape, label] = known ? /** @type {[string, string]} */ (FLAG[kind]) : ["?", kind];
  return badge(doc, shape, label, `flag flag-${known ? kind : "other"}`);
}

/**
 * " on workstation-1 (macOS, claude-opus-5-5)": where a session runs and what it
 * reported about itself; the empty string when it reported nothing.
 * @param {{ machine: string | null, os: string | null, model: string | null }} s
 */
function sessionWhere(s) {
  const detail = [s.os, s.model].filter((x) => typeof x === "string" && x !== "").join(", ");
  if (s.machine) return ` on ${s.machine}${detail ? ` (${detail})` : ""}`;
  return detail ? ` (${detail})` : "";
}

/**
 * @typedef {{ kind: string, handle?: string, since: string | null, until?: string | null,
 *   what: string, todo: string, action?: string }} StatusFlag
 * @typedef {{ handle: string, kind: string, harness: string | null, role: string,
 *   coordinator: boolean, admin: boolean, status: string, muted_until: string | null,
 *   kicked_at: string | null, last_seen: string | null,
 *   session: { state: string, machine: string | null, os: string | null, model: string | null,
 *     attached_at: string, busy_since: string | null, socket_recorded: boolean } | null,
 *   open_sockets: number | null, rings: { at: string, result: string }[],
 *   rings_failing_since: string | null,
 *   wake_budget: { used: number, limit: number, window_ends_at: string | null } | null,
 *   doorbell: { pending_since: string, sent_at: string | null, held_at: string | null } | null }} StatusUser
 * @typedef {{ configured: boolean | null, exported_seq: number, unexported_rows: number,
 *   oldest_unexported_at: string | null, last_ok_at: string | null, failing_since: string | null,
 *   failures: number, last_error: string | null, retry_at: string | null }} ExportStatus
 * @typedef {{ now: string, users: StatusUser[], audit_export: ExportStatus,
 *   needs_you: StatusFlag[] }} AdminStatus
 * @typedef {{ action: string, handle: string } | null} PendingConfirm
 */

/** What each user action does, said before it runs (the in-page confirm step). */
const CONFIRM_TEXT = /** @type {Record<string, (h: string) => string>} */ ({
  reinstate: (h) =>
    `Reinstate ${h}? It becomes active with a new token, shown once on this page; the old token stays revoked and its coordinator flag is cleared.`,
  grant: (h) => `Make ${h} a coordinator? It can then set others' roles, reassign held tasks and read the audit log.`,
  remove: (h) => `Remove ${h}'s coordinator flag?`,
});
const CONFIRM_LABEL = /** @type {Record<string, string>} */ ({
  reinstate: "Yes, reinstate",
  grant: "Yes, make coordinator",
  remove: "Yes, remove coordinator",
});

/**
 * A button that names a user action; app.js handles clicks by these
 * attributes (event delegation), so nothing here holds a handler.
 * @param {Doc} doc @param {string} action @param {string} handle @param {string} label
 */
function actionButton(doc, action, handle, label) {
  return h(doc, "button", { type: "button", "data-admin-action": action, "data-handle": handle }, [label]);
}

/**
 * The confirm row for a pending action on this user, or its action buttons.
 * @param {Doc} doc @param {string} handle @param {string[]} actions @param {PendingConfirm} confirm
 */
function userActions(doc, handle, actions, confirm) {
  if (confirm && confirm.handle === handle && actions.includes(confirm.action)) {
    const text = CONFIRM_TEXT[confirm.action]?.(handle) ?? `${confirm.action} ${handle}?`;
    return h(doc, "div", { class: "confirm", role: "group", "aria-label": `Confirm for ${handle}` }, [
      h(doc, "p", {}, [text]),
      actionButton(doc, "confirm", handle, CONFIRM_LABEL[confirm.action] ?? "Confirm"),
      " ",
      actionButton(doc, "cancel", handle, "Cancel"),
    ]);
  }
  const LABEL = /** @type {Record<string, string>} */ ({
    reinstate: "Reinstate",
    grant: "Make coordinator",
    remove: "Remove coordinator",
  });
  return h(
    doc,
    "div",
    { class: "actions" },
    actions.map((a) => actionButton(doc, a, handle, LABEL[a] ?? a)),
  );
}

/** The actions offered for a user: reinstate a kicked one; otherwise the coordinator flag. @param {StatusUser} u */
function actionsFor(u) {
  if (u.status === "kicked") return ["reinstate"];
  if (u.status === "retired") return [];
  return [u.coordinator ? "remove" : "grant"];
}

/**
 * The fixed "Needs you" area: every flagged item with what happened and what
 * to do, or "All clear".
 * @param {Doc} doc @param {AdminStatus} s @param {PendingConfirm} confirm
 */
export function needsYou(doc, s, confirm) {
  if (s.needs_you.length === 0) {
    return h(doc, "p", { class: "all-clear" }, [
      h(doc, "span", { class: "shape", "aria-hidden": "true" }, ["✓"]),
      " All clear: nothing needs you.",
    ]);
  }
  return h(
    doc,
    "ol",
    { class: "flags" },
    s.needs_you.map((f) =>
      h(doc, "li", { class: `flag-item flag-item-${Object.hasOwn(FLAG, f.kind) ? f.kind : "other"}` }, [
        h(doc, "div", { class: "flag-head" }, [flagBadge(doc, f.kind), f.handle ? " " : null, f.handle ? h(doc, "strong", {}, [f.handle]) : null]),
        h(doc, "p", { class: "what" }, [f.what]),
        h(doc, "p", { class: "todo" }, [h(doc, "strong", {}, ["What to do: "]), f.todo]),
        f.action === "reinstate" && f.handle ? userActions(doc, f.handle, ["reinstate"], confirm) : null,
      ]),
    ),
  );
}

/**
 * Plain data about one user; abnormal state only as badges (dark cockpit).
 * @param {Doc} doc @param {AdminStatus} s @param {StatusUser} u @param {PendingConfirm} confirm
 */
function userCard(doc, s, u, confirm) {
  const now = epoch(s.now);
  /** @type {Child[]} */
  const badges = [];
  if (u.status === "kicked") badges.push(flagBadge(doc, "kicked"));
  if (u.status === "muted") badges.push(flagBadge(doc, "muted"));
  if (u.rings_failing_since !== null) badges.push(flagBadge(doc, "rings_failing"));
  const flagged = badges.length > 0;
  const tags = [u.kind, u.harness, u.admin ? "admin" : null, u.coordinator ? "coordinator" : null].filter(Boolean).join(" · ");
  /** @type {[string, string][]} */
  const rows = [];
  if (u.status === "kicked") rows.push(["Status", `kicked ${ago(now, u.kicked_at)}`]);
  if (u.status === "muted") rows.push(["Status", `muted in the Lobby${u.muted_until === null ? "" : `, ${span(epoch(u.muted_until) - now)} left`}`]);
  if (u.status === "retired") rows.push(["Status", "retired (no credential)"]);
  if (u.kind === "agent") {
    if (u.session) {
      const sockets = u.open_sockets ?? (u.session.socket_recorded ? 1 : 0);
      const state = u.session.state === "busy" && u.session.busy_since !== null ? `busy for ${span(now - epoch(u.session.busy_since))}` : u.session.state;
      rows.push([
        "Session",
        `${state}${sessionWhere(u.session)}, attached ${ago(now, u.session.attached_at)}; adapter ${sockets > 0 ? "connected" : "not connected"}`,
      ]);
    } else {
      rows.push(["Session", "none"]);
    }
    rows.push([
      "Rings",
      u.rings.length === 0
        ? "none recently"
        : u.rings.map((r) => `${r.result.replace("_", " ")} ${ago(now, r.at)}`).join(", "),
    ]);
    if (u.wake_budget) {
      const w = u.wake_budget;
      rows.push([
        "Wake budget",
        `${w.used} of ${w.limit} used${w.window_ends_at === null ? "" : `, window ends in ${span(epoch(w.window_ends_at) - now)}`}`,
      ]);
    }
    if (u.doorbell) {
      const d = u.doorbell;
      rows.push([
        "Doorbell",
        `pending for ${span(now - epoch(d.pending_since))}${d.held_at !== null ? ", held while busy" : d.sent_at !== null ? `, rung ${ago(now, d.sent_at)}` : ""}`,
      ]);
    }
  }
  rows.push(["Last seen", ago(now, u.last_seen)]);
  return h(doc, "li", { class: `card${flagged ? " flagged" : ""}`, "data-handle": u.handle }, [
    h(doc, "div", { class: "card-head" }, [h(doc, "strong", { class: "handle" }, [u.handle]), " ", ...badges]),
    h(doc, "div", { class: "tags" }, [tags]),
    u.role ? h(doc, "div", { class: "role" }, [u.role]) : null,
    h(
      doc,
      "dl",
      {},
      rows.flatMap(([k, v]) => [h(doc, "dt", {}, [k]), h(doc, "dd", {}, [v])]),
    ),
    userActions(doc, u.handle, actionsFor(u), confirm),
  ]);
}

/**
 * One card per user, agents then people, each in handle order (stable).
 * @param {Doc} doc @param {AdminStatus} s @param {PendingConfirm} confirm
 */
export function userCards(doc, s, confirm) {
  const byHandle = [...s.users].sort((a, b) => (a.handle < b.handle ? -1 : a.handle > b.handle ? 1 : 0));
  const agents = byHandle.filter((u) => u.kind === "agent");
  const people = byHandle.filter((u) => u.kind !== "agent");
  /** @param {string} title @param {StatusUser[]} list */
  const group = (title, list) =>
    h(doc, "section", { class: "user-group", "aria-label": title }, [
      h(doc, "h3", {}, [`${title} (${list.length})`]),
      list.length === 0
        ? h(doc, "p", { class: "empty" }, ["None."])
        : h(doc, "ul", { class: "cards" }, list.map((u) => userCard(doc, s, u, confirm))),
    ]);
  return h(doc, "div", {}, [group("Agents", agents), group("People", people)]);
}

/** The board's audit export, as plain data. @param {Doc} doc @param {AdminStatus} s */
export function exportSummary(doc, s) {
  const e = s.audit_export;
  const state =
    e.configured === false
      ? "off: no sink configured, rows stay in the board"
      : e.configured === null
        ? "unknown"
        : e.failing_since !== null
          ? `failing for ${span(epoch(s.now) - epoch(e.failing_since))} (${e.failures} attempts)`
          : `last batch confirmed ${ago(epoch(s.now), e.last_ok_at)}`;
  return h(doc, "dl", { class: "export" }, [
    h(doc, "dt", {}, ["Audit export"]),
    h(doc, "dd", {}, [state]),
    h(doc, "dt", {}, ["Rows waiting"]),
    h(doc, "dd", {}, [
      `${e.unexported_rows}${e.oldest_unexported_at === null ? "" : `, oldest ${ago(epoch(s.now), e.oldest_unexported_at)}`}`,
    ]),
    e.last_error ? h(doc, "dt", {}, ["Last error"]) : null,
    e.last_error ? h(doc, "dd", {}, [e.last_error]) : null,
  ]);
}

/**
 * @typedef {{ id: string, label: string, algorithm: string, synced: boolean, can_approve?: boolean,
 *   created_at: string, last_used_at: string | null }} Passkey
 */

/**
 * The person's passkeys, one item each: the label, when it was made and last
 * used, and in words (with a shape, never color alone) whether it syncs between
 * devices or stays on one. A remove button asks for an in-page confirmation
 * (`confirmId` names the one being confirmed); the last passkey has no button,
 * since the board removes it only from the CLI. Clicks are handled by app.js
 * through the data attributes.
 * @param {Doc} doc
 * @param {Passkey[]} passkeys
 * @param {string | undefined} confirmId
 */
export function passkeyList(doc, passkeys, confirmId) {
  if (passkeys.length === 0) {
    return h(doc, "p", { class: "empty" }, ["No passkeys yet."]);
  }
  const button = (/** @type {string} */ action, /** @type {string} */ id, /** @type {string} */ label) =>
    h(doc, "button", { type: "button", "data-passkey-action": action, "data-id": id }, [label]);
  return h(
    doc,
    "ul",
    { class: "passkey-list" },
    passkeys.map((p) => {
      const where = p.synced
        ? badge(doc, "⇄", "synced between devices", "passkey-synced")
        : badge(doc, "■", "device-bound", "passkey-bound");
      // Whether it may approve (issue #54), in words with a shape; absent from older answers.
      const approves =
        typeof p.can_approve === "boolean"
          ? p.can_approve
            ? badge(doc, "✓", "can approve", "passkey-approves")
            : badge(doc, "✗", "cannot approve: synced between devices", "passkey-no-approve")
          : "";
      let control;
      if (confirmId === p.id) {
        control = h(doc, "div", { class: "confirm", role: "group", "aria-label": `Confirm removing ${p.label}` }, [
          h(doc, "p", {}, [`Remove the passkey "${p.label}"? This browser can no longer sign in with it.`]),
          button("confirm", p.id, "Remove"),
          " ",
          button("cancel", p.id, "Cancel"),
        ]);
      } else if (passkeys.length === 1) {
        control = h(doc, "p", { class: "note" }, [
          "This is your last passkey. To remove it, run ",
          h(doc, "code", {}, [`bbs passkey remove ${p.id}`]),
          " in a terminal.",
        ]);
      } else {
        control = h(doc, "div", { class: "actions" }, [button("remove", p.id, "Remove")]);
      }
      return h(doc, "li", { "data-passkey": p.id }, [
        h(doc, "strong", {}, [p.label]),
        " ",
        where,
        " ",
        approves,
        h(doc, "p", { class: "note" }, [`Added ${formatTime(p.created_at)}. Last used ${p.last_used_at === null ? "never" : formatTime(p.last_used_at)}.`]),
        control,
      ]);
    }),
  );
}

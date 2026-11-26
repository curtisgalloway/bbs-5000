// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0
// @ts-check

/**
 * The web view (design §12): topics and their messages with a post box, the
 * task board, who is online, and the audit log with filters. A direct human
 * client (design §4): it calls `/api` with its session cookie, so a person's
 * posts are stored as `human` with `via = web`.
 *
 * Sign-in is by pairing code (issue #47). With no session the page asks the
 * board for a code and shows it with the command `bbs web-login <code>`; the
 * person approves it from the CLI, and the page's poll then gets a session as
 * an HttpOnly cookie, which this script cannot read. The page keeps no
 * credential anywhere: the poll secret lives in a variable of this page only
 * (never in web storage or the address) and is useless once the code is used.
 * A person who registered a passkey can also sign in with it (issue #54): the
 * button shows only when the browser has `PublicKeyCredential`. Registering one
 * is the Passkeys tab's, in a session made by a pairing code.
 *
 * All user text is rendered by `render.js` as text nodes. Nothing here makes
 * a sound; the page refreshes the open view every few seconds.
 *
 * The human admin also gets the Admin tab (G5, design §12): `bbs_admin_status`
 * re-read every 30 s while the tab is visible, user actions behind an
 * in-page confirm step, and a new token shown once in a panel.
 */

import {
  auditTable,
  exportSummary,
  messageList,
  needsYou,
  passkeyList,
  taskBoard,
  topicList,
  userCards,
  whoTable,
} from "./render.js";
import { cancelled, passkeysSupported, registerPasskey, resetPasskeySignIn, wirePasskeySignIn } from "./passkey.js";
import { createApprovalSlot, startApproval } from "./approval.js";
import { createPairing, el, post, SignedOut } from "./signin.js";

const REFRESH_MS = 5000;
/** The Admin tab re-reads this often while the tab is visible (G5; Curtis: "Poll every 30 s"). */
const ADMIN_REFRESH_MS = 30_000;

/** @type {{ handle: string, kind: string, admin: boolean, coordinator: boolean } | null} */
let me = null;
/** @type {string | undefined} */
let currentTopic;
let posting = false;
/** Per topic, the newest seq this page has marked read (review M1). @type {Map<string, number>} */
const marked = new Map();
/** @type {ReturnType<typeof setTimeout> | undefined} */
let timer;
/** The last admin status read, so a confirm step re-renders without a new read. @type {import("./render.js").AdminStatus | null} */
let adminStatus = null;
/** When the Admin tab last read the board (ms, this page's clock). */
let adminReadAt = 0;
/** The in-page confirm step that is open, if any (no confirm() dialogs). @type {import("./render.js").PendingConfirm} */
let pendingConfirm = null;
let adminBusy = false;
/** The Passkeys tab's last read (null: load it on the next refresh), the passkey whose removal is being confirmed, and whether a passkey call is in flight. @type {{ passkeys: import("./render.js").Passkey[], can_register: boolean, note: string, approval?: { required: boolean, allow_synced: boolean, approvers: number } } | null} */
let passkeyData = null;
/** @type {string | undefined} */
let passkeyConfirm;
let passkeyBusy = false;
/** The pairing sign-in, shared with the consent page (`signin.js`). */
const pairer = createPairing({ show: showSignIn, approved: () => start(), approvals: createApprovalSlot(el("pair-approval")) });
/** The approval panel of a passkey removal that waits for a passkey (issue #54), while one is open. @type {ReturnType<typeof startApproval> | null} */
let removalApproval = null;

/**
 * Call one board tool on `/api`.
 * @param {string} tool
 * @param {Record<string, unknown>} [args]
 */
function call(tool, args = {}) {
  return post(`/api/${tool}`, args);
}

/** @param {string} text */
function showError(text) {
  const e = el("error");
  e.textContent = text;
  e.hidden = text === "";
}

/**
 * Leave the signed-in state and start a new pairing. For an explicit sign-out
 * or a 401 (`SignedOut`): a network or server error keeps the session
 * (review n2).
 * @param {string} [message]
 */
function signOut(message = "") {
  dismissToken();
  adminStatus = null;
  adminReadAt = 0;
  pendingConfirm = null;
  passkeyData = null;
  passkeyConfirm = undefined;
  removalApproval?.stop();
  removalApproval = null;
  el("passkey-approval").textContent = "";
  // What the Passkeys tab drew belongs to the session that just ended: the next
  // sign-in must not show it (or its Add form) while its own read is in flight.
  el("passkey-list").textContent = "";
  el("passkey-note").textContent = "";
  el("passkey-add-form").hidden = true;
  void pairer.begin(message);
}

/** Show the sign-in panel and hide the rest. @param {string} [message] */
function showSignIn(message = "") {
  me = null;
  if (timer) clearTimeout(timer);
  el("nav").hidden = true;
  el("me").hidden = true;
  for (const v of document.querySelectorAll(".view")) /** @type {HTMLElement} */ (v).hidden = true;
  el("sign-in").hidden = false;
  resetPasskeySignIn(el);
  showError(message);
}

/** Show the signed-in page for the person the board named. @param {{ handle: string, kind: string, admin: boolean, coordinator: boolean }} who */
async function enter(who) {
  pairer.stop();
  me = who;
  el("sign-in").hidden = true;
  el("nav").hidden = false;
  el("me").hidden = false;
  // The Admin tab is only for the human admin (G5); the board refuses everyone else anyway.
  el("nav-admin").hidden = !who.admin;
  el("me-label").textContent = `Signed in as ${who.handle} (human${who.admin ? ", admin" : ""}${who.coordinator ? ", coordinator" : ""})`;
  // The audit view stays visible: only people sign in here, and design §13
  // opens the audit log to people and coordinators.
  showError("");
  await route();
}

/**
 * Find out whether the cookie holds a session: `/api/web/session` says, and
 * when it does not, the page asks for a pairing code. A 401 from `bbs_whoami`
 * afterward (the session ended meanwhile) does the same.
 */
async function start() {
  let who;
  try {
    // The check is a plain 200 either way (no 401, no audit row for a signed-out load).
    const s = await post("/api/web/session", {});
    if (!s.signed_in) {
      await pairer.begin("");
      return;
    }
    who = await call("bbs_whoami", {});
  } catch (err) {
    if (err instanceof SignedOut) await pairer.begin("");
    else showSignIn(`Could not reach the board: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  if (who.kind !== "human") {
    // Design §4: only a person's own words are `human`; a web session is always a person's.
    showSignIn("The board did not answer as a person. Sign out and try again.");
    return;
  }
  await enter(who);
}

/** The sign-out button: end the session on the board (which clears the cookie), then ask for a new code. */
async function endSession() {
  try {
    await call("bbs_web_sign_out", {});
  } catch (err) {
    if (!(err instanceof SignedOut)) {
      showError(`Not signed out: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
  }
  signOut("");
}

/** The view named by the location hash. */
function parseHash() {
  const hash = location.hash.slice(1);
  if (hash.startsWith("topic/")) {
    try {
      return { view: "topics", topic: decodeURIComponent(hash.slice(6)) };
    } catch {
      // A malformed escape in the address (review n4): show the topic list.
      return { view: "topics", topic: undefined };
    }
  }
  if (hash === "tasks" || hash === "who" || hash === "audit" || hash === "passkeys") return { view: hash, topic: undefined };
  if (hash === "admin" && me?.admin) return { view: "admin", topic: undefined };
  return { view: "topics", topic: currentTopic };
}

async function route() {
  if (!me) return;
  const { view, topic } = parseHash();
  for (const v of document.querySelectorAll(".view")) {
    /** @type {HTMLElement} */ (v).hidden = v.id !== `view-${view}`;
  }
  for (const a of document.querySelectorAll("#nav a")) {
    if (a.getAttribute("data-view") === view) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  }
  currentTopic = topic;
  // The Passkeys tab reads once per visit (and after each change), not every few seconds.
  if (view === "passkeys") passkeyData = null;
  await refresh();
}

/**
 * Refresh the open view, then schedule the next refresh. Skipped while the
 * tab is hidden or a post is in flight. The audit view is loaded on demand
 * only: every audit read writes an audit row (design §13).
 */
async function refresh() {
  if (timer) clearTimeout(timer);
  if (!me) return;
  if (document.hidden || posting) {
    timer = setTimeout(() => void refresh(), REFRESH_MS);
    return;
  }
  try {
    const { view } = parseHash();
    if (view === "topics") await showTopics();
    else if (view === "tasks") await showTasks();
    else if (view === "who") await showWho();
    else if (view === "passkeys" && !passkeyData) await showPasskeys();
    else if (view === "audit" && el("audit").childElementCount === 0) await showAudit();
    else if (view === "admin") {
      // Between 30 s reads nothing is loaded, so an error from an admin action stays up.
      if (Date.now() - adminReadAt < ADMIN_REFRESH_MS) {
        timer = setTimeout(() => void refresh(), REFRESH_MS);
        return;
      }
      await showAdmin();
    }
    showError("");
  } catch (err) {
    if (err instanceof SignedOut) {
      signOut("Signed out: the board no longer accepts this session.");
      return;
    }
    showError(String(err instanceof Error ? err.message : err));
  }
  timer = setTimeout(() => void refresh(), REFRESH_MS);
}

/** @param {HTMLElement} target @param {Node} node */
function replace(target, node) {
  target.replaceChildren(node);
}

async function showTopics() {
  const { topics } = await call("bbs_topics", {});
  replace(el("topic-list"), topicList(document, topics, currentTopic));
  const form = /** @type {HTMLFormElement} */ (el("post-form"));
  if (!currentTopic) {
    el("topic-title").textContent = "Pick a topic";
    el("topic-description").textContent = "";
    el("messages").replaceChildren();
    form.hidden = true;
    return;
  }
  const topic = topics.find((/** @type {{ name: string }} */ t) => t.name === currentTopic);
  el("topic-title").textContent = `#${currentTopic}`;
  el("topic-description").textContent = topic?.description ?? "";
  const box = el("messages");
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
  const read = await call("bbs_read", { topic: currentTopic, tail: true, limit: 100 });
  replace(box, messageList(document, read.messages));
  // Move the read mark when the newest shown message advances and the topic
  // has unread messages (review M1); not on every refresh.
  const newest = read.messages.at(-1)?.seq;
  if (topic?.unread && typeof newest === "number" && newest > (marked.get(currentTopic) ?? 0)) {
    await call("bbs_topic_mark_read", { topic: currentTopic, through_seq: newest });
    marked.set(currentTopic, newest);
    topic.unread = 0;
    replace(el("topic-list"), topicList(document, topics, currentTopic));
  }
  if (atBottom) box.scrollTop = box.scrollHeight;
  el("post-topic").textContent = `#${currentTopic}`;
  form.hidden = currentTopic === "admin-log" || read.state !== "active";
}

async function showTasks() {
  const { tasks } = await call("bbs_task_list", { limit: 500 });
  replace(el("tasks"), taskBoard(document, tasks));
}

async function showWho() {
  const { users } = await call("bbs_who", {});
  replace(el("who"), whoTable(document, users));
}

/** Read the board's admin status (a read the board does not audit) and draw it. */
async function showAdmin() {
  adminStatus = await call("bbs_admin_status", {});
  adminReadAt = Date.now();
  el("admin-updated").textContent = `Read at ${new Date(adminReadAt).toLocaleTimeString()}; re-read every 30 seconds while this tab is visible.`;
  drawAdmin();
}

/** Draw the Admin tab from the last status read and the open confirm step. */
function drawAdmin() {
  if (!adminStatus) return;
  replace(el("admin-needs"), needsYou(document, adminStatus, pendingConfirm));
  replace(el("admin-users"), userCards(document, adminStatus, pendingConfirm));
  replace(el("admin-export"), exportSummary(document, adminStatus));
}

/**
 * Show a new token once. It lives only in the read-only field's value: not
 * in the address, storage, or a variable of this page, and the field is
 * cleared when the panel is dismissed or the person signs out.
 * @param {string} handle @param {string} token @param {string} title
 */
function showToken(handle, token, title) {
  el("token-title").textContent = title;
  el("token-handle").textContent = handle;
  /** @type {HTMLInputElement} */ (el("token-value")).value = token;
  el("token-copy-status").textContent = "";
  el("token-panel").hidden = false;
  el("token-panel").scrollIntoView({ block: "nearest" });
}

function dismissToken() {
  /** @type {HTMLInputElement} */ (el("token-value")).value = "";
  el("token-handle").textContent = "";
  el("token-copy-status").textContent = "";
  el("token-panel").hidden = true;
}

/** Copy the token in the click handler; if the clipboard is refused, select it for the person to copy. */
function copyToken() {
  const input = /** @type {HTMLInputElement} */ (el("token-value"));
  const status = el("token-copy-status");
  const selectIt = () => {
    input.focus();
    input.select();
    status.textContent = "Selected: press Ctrl+C (Cmd+C on a Mac) to copy.";
  };
  if (!navigator.clipboard?.writeText) {
    selectIt();
    return;
  }
  navigator.clipboard.writeText(input.value).then(
    () => {
      status.textContent = "Copied.";
    },
    selectIt,
  );
}

/**
 * Run a confirmed user action, then re-read the status.
 * @param {string} action @param {string} handle
 */
async function runAdminAction(action, handle) {
  if (adminBusy) return;
  adminBusy = true;
  try {
    if (action === "reinstate") {
      const r = await call("bbs_admin_reinstate", { handle });
      showToken(r.handle, r.token, `${r.handle} reinstated: new token`);
    } else if (action === "grant") {
      await call("bbs_admin_coordinator_grant", { handle });
    } else if (action === "remove") {
      await call("bbs_admin_coordinator_remove", { handle });
    }
    pendingConfirm = null;
    showError("");
    await showAdmin();
  } catch (err) {
    if (err instanceof SignedOut) signOut("Signed out: the board no longer accepts this session.");
    else showError(`Not done: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    adminBusy = false;
  }
}

/** Read the person's passkeys and draw them with the add form and the one-line note. */
async function showPasskeys() {
  passkeyData = await call("bbs_passkeys", {});
  drawPasskeys();
}

/** Draw the Passkeys tab from the last read and the open confirm step. */
function drawPasskeys() {
  if (!passkeyData) return;
  replace(el("passkey-list"), passkeyList(document, passkeyData.passkeys, passkeyConfirm));
  const canAdd = passkeyData.can_register && passkeysSupported();
  el("passkey-add-form").hidden = !canAdd;
  el("passkey-note").textContent = passkeysSupported() ? passkeyData.note : "This browser does not support passkeys.";
  const ap = passkeyData.approval;
  const line = el("passkey-approval");
  line.className = "note";
  line.textContent = "";
  if (ap?.required) {
    const synced = ap.allow_synced ? " Synced passkeys are allowed to approve too, as a stopgap set when the board was deployed." : "";
    if (ap.approvers === 0) {
      line.className = "oauth-warning";
      line.textContent = `This board requires approval by passkey. No passkey can approve yet, so sign-in codes and connector approvals are refused until you register one or the board is redeployed without the requirement.${synced}`;
    } else {
      line.textContent = `This board requires approval by passkey. ${ap.approvers} ${ap.approvers === 1 ? "passkey can" : "passkeys can"} approve.${synced}`;
    }
  }
}

/** @param {string} text */
function passkeyStatus(text) {
  el("passkey-status").textContent = text;
}

/** The Add a passkey form: ask the browser for a new passkey, then send it to the board. */
async function addPasskey() {
  if (passkeyBusy) return;
  passkeyBusy = true;
  const form = /** @type {HTMLFormElement} */ (el("passkey-add-form"));
  const label = String(new FormData(form).get("label") ?? "").trim();
  passkeyStatus("Waiting for your browser…");
  try {
    await registerPasskey(label);
    form.reset();
    passkeyStatus("Passkey added.");
    await showPasskeys();
  } catch (err) {
    if (err instanceof SignedOut) signOut("Signed out: the board no longer accepts this session.");
    else if (cancelled(err)) passkeyStatus("Cancelled: no passkey was added.");
    else passkeyStatus(`Not added: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    passkeyBusy = false;
  }
}

/** Remove one passkey after the in-page confirmation. @param {string} id */
async function removePasskey(id) {
  if (passkeyBusy) return;
  passkeyBusy = true;
  try {
    let r = await call("bbs_passkey_remove", { id });
    passkeyConfirm = undefined;
    if (r.status === "approval_required") {
      // The board wants a passkey to approve the removal (issue #54): ask right here.
      passkeyStatus("Waiting for your approval below.");
      const run = startApproval(String(r.approval), el("passkey-approval-panel"));
      removalApproval = run;
      const value = await run.done;
      if (removalApproval !== run) return;
      removalApproval = null;
      if (!value) {
        passkeyStatus("Not removed: the approval did not go through.");
        await showPasskeys();
        return;
      }
      el("passkey-approval-panel").replaceChildren();
      r = value.result;
    }
    // This browser's own session was made by the passkey: it ended with it. Land on the signed-out page, with no error.
    if (r.ended_current) {
      signOut("");
      return;
    }
    passkeyStatus("Passkey removed.");
    await showPasskeys();
  } catch (err) {
    if (err instanceof SignedOut) signOut("Signed out: the board no longer accepts this session.");
    else {
      passkeyConfirm = undefined;
      passkeyStatus(`Not removed: ${err instanceof Error ? err.message : String(err)}`);
      await showPasskeys().catch(() => {});
    }
  } finally {
    passkeyBusy = false;
  }
}

async function showAudit() {
  const form = /** @type {HTMLFormElement} */ (el("audit-form"));
  const data = new FormData(form);
  /** @type {Record<string, unknown>} */
  const args = { limit: 200, tail: true };
  const actor = String(data.get("actor") ?? "").trim();
  const topic = String(data.get("topic") ?? "").trim().replace(/^#/, "");
  const task = String(data.get("task") ?? "").trim();
  const since = String(data.get("since") ?? "").trim();
  if (actor) args.actor = actor;
  if (topic) args.topic = topic;
  if (task) args.task = Number(task);
  if (since) {
    const ms = new Date(since).getTime();
    if (Number.isFinite(ms)) args.since = ms;
  }
  const { events } = await call("bbs_audit", args);
  replace(el("audit"), auditTable(document, [...events].reverse()));
}

function wire() {
  el("sign-out").addEventListener("click", () => void endSession());
  el("pair-new").addEventListener("click", () => void pairer.begin(""));
  wirePasskeySignIn(el, async () => {
    pairer.stop();
    await start();
  });
  el("passkey-add-form").addEventListener("submit", (ev) => {
    ev.preventDefault();
    void addPasskey();
  });
  // Passkey buttons, by their data attributes (render.js holds no handlers).
  el("view-passkeys").addEventListener("click", (ev) => {
    const target = /** @type {HTMLElement | null} */ (ev.target instanceof Element ? ev.target.closest("[data-passkey-action]") : null);
    if (!target) return;
    const action = target.getAttribute("data-passkey-action") ?? "";
    const id = target.getAttribute("data-id") ?? "";
    if (action === "confirm" && passkeyConfirm === id) {
      void removePasskey(id);
      return;
    }
    passkeyConfirm = action === "remove" ? id : undefined;
    passkeyStatus("");
    drawPasskeys();
  });
  el("post-form").addEventListener("submit", (ev) => {
    ev.preventDefault();
    const area = /** @type {HTMLTextAreaElement} */ (el("post-body"));
    const body = area.value;
    // One post at a time (review n1): a second click while sending is ignored.
    if (posting || !currentTopic || body.trim() === "") return;
    posting = true;
    const button = /** @type {HTMLButtonElement} */ (el("post-form").querySelector("button[type=submit]"));
    button.disabled = true;
    call("bbs_post", { topic: currentTopic, body })
      .then(() => {
        area.value = "";
        posting = false;
        el("messages").scrollTop = el("messages").scrollHeight;
        return refresh();
      })
      .catch((err) => {
        if (err instanceof SignedOut) signOut("Signed out: the board no longer accepts this session.");
        else showError(`Not posted: ${err instanceof Error ? err.message : String(err)}`);
      })
      .finally(() => {
        posting = false;
        button.disabled = false;
      });
  });
  el("audit-form").addEventListener("submit", (ev) => {
    ev.preventDefault();
    showAudit().catch((err) => showError(String(err instanceof Error ? err.message : err)));
  });
  window.addEventListener("hashchange", () => void route());
  // Page Visibility: a tab coming back into view re-reads at once when due.
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) void refresh();
  });
  // Admin tab buttons, by their data attributes (render.js holds no handlers).
  el("view-admin").addEventListener("click", (ev) => {
    const target = /** @type {HTMLElement | null} */ (ev.target instanceof Element ? ev.target.closest("[data-admin-action]") : null);
    if (!target) return;
    const action = target.getAttribute("data-admin-action") ?? "";
    const handle = target.getAttribute("data-handle") ?? "";
    if (action === "cancel") pendingConfirm = null;
    else if (action === "confirm" && pendingConfirm && pendingConfirm.handle === handle) {
      void runAdminAction(pendingConfirm.action, handle);
      return;
    } else if (action === "reinstate" || action === "grant" || action === "remove") pendingConfirm = { action, handle };
    drawAdmin();
  });
  el("token-copy").addEventListener("click", () => copyToken());
  el("token-dismiss").addEventListener("click", () => dismissToken());
  el("user-add-form").addEventListener("submit", (ev) => {
    ev.preventDefault();
    if (adminBusy) return;
    const form = /** @type {HTMLFormElement} */ (el("user-add-form"));
    const data = new FormData(form);
    /** @type {Record<string, unknown>} */
    const args = { handle: String(data.get("handle") ?? "").trim(), kind: String(data.get("kind") ?? "agent") };
    const harness = String(data.get("harness") ?? "").trim();
    const role = String(data.get("role") ?? "").trim();
    if (harness) args.harness = harness;
    if (role) args.role = role;
    adminBusy = true;
    call("bbs_admin_user_add", args)
      .then((r) => {
        form.reset();
        showToken(r.handle, r.token, `${r.handle} added: token`);
        showError("");
        adminBusy = false;
        return showAdmin();
      })
      .catch((err) => {
        if (err instanceof SignedOut) signOut("Signed out: the board no longer accepts this session.");
        else showError(`Not added: ${err instanceof Error ? err.message : String(err)}`);
      })
      .finally(() => {
        adminBusy = false;
      });
  });
}

wire();
void start();

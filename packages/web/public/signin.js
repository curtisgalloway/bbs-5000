// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0
// @ts-check

/**
 * What the web view's pages share: the JSON `post` to the board with the session
 * cookie, and the pairing sign-in (issue #47, design §12). `app.js` (the main
 * page) and `authorize.js` (the connector consent page, issue #55) both import
 * it, so there is one copy of the code that asks for a pairing code, shows it
 * with the command to run, counts down and polls.
 *
 * The page keeps no credential anywhere: the poll secret lives in a variable of
 * the pairing only (never in web storage or the address) and is useless once
 * the code is used. A page using this needs these elements: `pair-code`,
 * `pair-command`, `pair-status` and `pair-new` (and `pair-approval` when it passes `approvals`).
 */

/** How often the page asks whether its pairing code was approved. */
const POLL_MS = 2000;

/** @param {string} id */
export function el(id) {
  const e = document.getElementById(id);
  if (!e) throw new Error(`missing #${id}`);
  return e;
}

/** The board answered 401: no session, or it no longer accepts the one the browser holds. */
export class SignedOut extends Error {}

/** The board refused a call: `code` is its error code, `status` the HTTP status. */
export class BoardError extends Error {
  /** @param {string} message @param {string} code @param {number} status */
  constructor(message, code, status) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

/**
 * POST JSON to the board with the session cookie. Throws `SignedOut` on 401
 * (no session, or the board no longer accepts it) and a `BoardError` with the
 * board's message otherwise.
 * @param {string} path
 * @param {Record<string, unknown>} args
 */
export async function post(path, args) {
  const res = await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(args),
  });
  /** @type {any} */
  let body;
  try {
    body = await res.json();
  } catch {
    body = { ok: false, error: { message: `HTTP ${res.status}` } };
  }
  if (res.status === 401) throw new SignedOut(body?.error?.message ?? "signed out");
  if (!body?.ok) throw new BoardError(body?.error?.message ?? `HTTP ${res.status}`, String(body?.error?.code ?? ""), res.status);
  return body.value;
}

/**
 * The pairing sign-in. `show(message)` puts the page into its sign-in state
 * (the page's own business); `approved()` runs once a person approved the code
 * and the board set the session cookie.
 *
 * When the board requires a passkey's approval (issue #54), the poll's pending
 * answer carries the approval's id; `approvals` (a `createApprovalSlot` from
 * `approval.js`, over the page's `pair-approval` element) then shows the panel
 * under the code, and drops it when a later poll no longer carries the id.
 * @param {{ show: (message: string) => void, approved: () => void | Promise<void>, approvals?: { sync: (id: string | undefined) => void, stop: () => void } }} hooks
 */
export function createPairing({ show, approved, approvals }) {
  /** The open pairing, if any: its poll secret (kept here only) and when it ends on this page's clock. @type {{ secret: string, expiresAt: number } | null} */
  let pairing = null;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let pollTimer;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let countdownTimer;

  /** Stop the poll and the countdown, and forget the pairing. */
  function stop() {
    pairing = null;
    approvals?.stop();
    if (pollTimer) clearTimeout(pollTimer);
    if (countdownTimer) clearTimeout(countdownTimer);
  }

  /** The pairing's code ran out (or could not be made): offer a new one. @param {string} text */
  function ended(text) {
    stop();
    el("pair-status").textContent = text;
    el("pair-new").hidden = false;
  }

  /** Ask the board for a pairing code and show it with the command to run; then poll. @param {string} [message] */
  async function begin(message = "") {
    stop();
    show(message);
    el("pair-new").hidden = true;
    el("pair-code").textContent = "";
    el("pair-command").textContent = "";
    el("pair-status").textContent = "Asking the board for a code…";
    let started;
    try {
      started = await post("/api/web/pair/start", {});
    } catch (err) {
      ended(`Could not get a sign-in code: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    const mine = { secret: String(started.poll_secret), expiresAt: Date.now() + Number(started.expires_in_ms) };
    pairing = mine;
    el("pair-code").textContent = String(started.code);
    el("pair-command").textContent = `bbs web-login ${started.code}`;
    tick(mine);
    pollTimer = setTimeout(() => void poll(mine), POLL_MS);
  }

  /** Show how long the code has left, as text, once a second. @param {{ secret: string, expiresAt: number }} mine */
  function tick(mine) {
    if (pairing !== mine) return;
    const left = Math.max(0, Math.ceil((mine.expiresAt - Date.now()) / 1000));
    if (left === 0) {
      ended("That code has expired.");
      return;
    }
    const mm = Math.floor(left / 60);
    const ss = String(left % 60).padStart(2, "0");
    el("pair-status").textContent = `Waiting for approval. The code expires in ${mm}:${ss}.`;
    countdownTimer = setTimeout(() => tick(mine), 1000);
  }

  /** One poll: has a person approved this pairing? @param {{ secret: string, expiresAt: number }} mine */
  async function poll(mine) {
    if (pairing !== mine) return;
    try {
      const r = await post("/api/web/pair/claim", { poll_secret: mine.secret });
      if (pairing !== mine) return;
      if (r.status === "approved") {
        stop();
        await approved();
        return;
      }
      if (r.status === "expired") {
        ended("That code has expired.");
        return;
      }
      approvals?.sync(typeof r.approval === "string" ? r.approval : undefined);
    } catch (err) {
      if (pairing !== mine) return;
      // The board no longer knows this pairing (401): ask for a new code. Any
      // other error (the network, a busy board) is tried again at the next poll.
      if (err instanceof SignedOut) {
        ended("That code is no longer valid.");
        return;
      }
    }
    pollTimer = setTimeout(() => void poll(mine), POLL_MS);
  }

  return { begin, stop };
}

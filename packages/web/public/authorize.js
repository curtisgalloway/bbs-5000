// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0
// @ts-check

/**
 * The connector consent page (issue #55, design §9 steps 2 to 5). A remote client
 * (a claude.ai or ChatGPT connector) sends the person's browser here with its
 * OAuth request in the address. The page signs the person in if needed (the
 * pairing panel of `signin.js`, or a passkey), posts the request to the board, shows what the
 * client is and what approving allows, and sends the browser to the address the
 * board built (with a code, or `error=access_denied`).
 *
 * Everything shown is set as text. The request's id is a secret that lives in a
 * variable here only. The query parameters stay in the address exactly as the
 * client sent them; nothing is written to web storage. There are no forms, so
 * Enter in the handle field decides nothing, and neither button has focus on load.
 */

import { createApprovalSlot, startApproval } from "./approval.js";
import { resetPasskeySignIn, wirePasskeySignIn } from "./passkey.js";
import { BoardError, createPairing, el, post, SignedOut } from "./signin.js";

/** The query parameters the board's request call takes, copied through as sent. */
const REQUEST_PARAMS = ["response_type", "client_id", "redirect_uri", "code_challenge", "code_challenge_method", "resource", "state", "scope"];

/**
 * @typedef {{
 *   status: "consent", request_id: string,
 *   client: { id: string, name: string, host: string }, client_auth: "none" | "private_key_jwt",
 *   redirect: { uri: string, host: string, localhost: boolean },
 *   scope: string, expires_in_ms: number, suggested_handle: string, agents: string[],
 * }} Consent
 */

/** The consent being decided: its secret request id, when it ends on this page's clock, and whether a decision is in flight. @type {{ id: string, expiresAt: number, agents: string[], busy: boolean } | null} */
let open = null;
/** @type {ReturnType<typeof setTimeout> | undefined} */
let countdownTimer;
/** The approval panel of a decision that waits for a passkey (issue #54), while one is open. @type {ReturnType<typeof startApproval> | null} */
let approving = null;

const PANELS = ["loading", "sign-in", "consent", "finished"];

/** Show one panel, hide the others, and move focus to its heading. @param {string} id */
function showPanel(id) {
  for (const p of PANELS) el(p).hidden = p !== id;
  const heading = el(`${id}-title`);
  heading.focus();
}

/** @param {string} text */
function showError(text) {
  const e = el("error");
  e.textContent = text;
  e.hidden = text === "";
}

/** A state with nothing more to do here: a heading and a sentence. @param {string} title @param {string} text */
function finish(title, text) {
  stopCountdown();
  open = null;
  el("finished-title").textContent = title;
  el("finished-text").textContent = text;
  showPanel("finished");
}

/** Leave the page for an address the board built. @param {string} to */
function leave(to) {
  stopCountdown();
  open = null;
  el("loading-status").textContent = "Sending you back to the client…";
  location.assign(to);
}

/** The board's message, ended as a sentence so more text can follow. @param {unknown} err */
function messageOf(err) {
  const m = err instanceof Error ? err.message : String(err);
  return /[.!?]$/.test(m) ? m : `${m}.`;
}

const START_OVER = "Start the connection again from the client program.";

const pairer = createPairing({
  show: (message) => {
    showError(message);
    resetPasskeySignIn(el);
    showPanel("sign-in");
  },
  approved: () => begin(),
  approvals: createApprovalSlot(el("pair-approval")),
});

/** Read the request from the address, ask the board about it, and show consent (or go where the board says). */
async function begin() {
  showError("");
  showPanel("loading");
  el("loading-status").textContent = "Checking the request…";
  const query = new URLSearchParams(location.search);
  /** @type {Record<string, string>} */
  const args = {};
  for (const k of REQUEST_PARAMS) {
    const v = query.get(k);
    if (v !== null) args[k] = v;
  }
  let session;
  try {
    // A plain 200 either way: a signed-out load writes no audit row.
    session = await post("/api/web/session", {});
  } catch (err) {
    if (err instanceof SignedOut) await pairer.begin("");
    else problem(`Could not reach the board: ${messageOf(err)}`);
    return;
  }
  if (!session.signed_in) {
    await pairer.begin("");
    return;
  }
  let r;
  try {
    r = await post("/api/web/oauth/request", args);
  } catch (err) {
    if (err instanceof SignedOut) await pairer.begin("");
    else if (err instanceof BoardError && err.code === "forbidden") {
      problem(`${messageOf(err)} Only the board's administrator can approve a client. Sign in as the administrator.`);
    } else if (err instanceof BoardError && err.code === "rate_limited") {
      problem(`${messageOf(err)} Wait a few minutes and start again from the client.`);
    } else problem(`${messageOf(err)} Nothing was approved and nothing was sent to the client.`);
    return;
  }
  if (r.status === "redirect") {
    leave(String(r.redirect_to));
    return;
  }
  showConsent(/** @type {Consent} */ (r));
}

/** A request that cannot go on: the message as text, no redirect. @param {string} text */
function problem(text) {
  stopCountdown();
  approving?.stop();
  approving = null;
  open = null;
  el("finished-title").textContent = "This request cannot be approved";
  el("finished-text").textContent = text;
  showPanel("finished");
}

/** @param {Consent} c */
function showConsent(c) {
  open = { id: String(c.request_id), expiresAt: Date.now() + Number(c.expires_in_ms), agents: c.agents.map(String), busy: false };
  el("client-name").textContent = c.client.name;
  el("client-host").textContent = c.client.host;
  // Text only: the method's own name, then what it means.
  el("client-auth").textContent =
    c.client_auth === "private_key_jwt"
      ? "private_key_jwt: the client signs each token request with its own key"
      : "none: the client does not sign its token requests";
  el("redirect-host").textContent = c.redirect.host;
  el("localhost-warning").hidden = !c.redirect.localhost;
  const handle = /** @type {HTMLInputElement} */ (el("handle"));
  handle.value = c.suggested_handle;
  const select = /** @type {HTMLSelectElement} */ (el("agents"));
  select.replaceChildren();
  const none = document.createElement("option");
  none.value = "";
  none.textContent = "(none: use the handle above)";
  select.append(none);
  for (const a of open.agents) {
    const o = document.createElement("option");
    o.value = a;
    o.textContent = a;
    select.append(o);
  }
  el("agents-field").hidden = open.agents.length === 0;
  el("decide-error").hidden = true;
  approving?.stop();
  approving = null;
  el("consent-approval").hidden = true;
  el("consent-approval").replaceChildren();
  el("consent-actions").hidden = false;
  setBusy(false);
  updateHandleNote();
  tick();
  showPanel("consent");
}

/** Tell the person when the handle they chose is an agent that already exists. */
function updateHandleNote() {
  const note = el("handle-note");
  const typed = /** @type {HTMLInputElement} */ (el("handle")).value.trim();
  const same = open?.agents.includes(typed) ?? false;
  note.hidden = !same;
  note.textContent = same ? `${typed} is an existing agent. Approving lets this client act as ${typed}.` : "";
}

function stopCountdown() {
  if (countdownTimer) clearTimeout(countdownTimer);
}

/** Show how long the request has left, as text, once a second; at zero, stop offering the buttons. */
function tick() {
  stopCountdown();
  if (!open) return;
  const left = Math.max(0, Math.ceil((open.expiresAt - Date.now()) / 1000));
  if (left === 0) {
    el("countdown").textContent = "This request has expired.";
    el("decide-error").textContent = `This request has expired. ${START_OVER}`;
    el("decide-error").hidden = false;
    open = null;
    setBusy(true);
    return;
  }
  const mm = Math.floor(left / 60);
  const ss = String(left % 60).padStart(2, "0");
  el("countdown").textContent = `This request expires in ${mm}:${ss}.`;
  countdownTimer = setTimeout(tick, 1000);
}

/** @param {boolean} busy */
function setBusy(busy) {
  /** @type {HTMLButtonElement} */ (el("approve")).disabled = busy;
  /** @type {HTMLButtonElement} */ (el("deny")).disabled = busy;
}

/** @param {string} text */
function decideProblem(text) {
  el("decide-error").textContent = text;
  el("decide-error").hidden = false;
}

/** @param {boolean} approve */
async function decide(approve) {
  if (!open || open.busy) return;
  const mine = open;
  const handle = /** @type {HTMLInputElement} */ (el("handle")).value.trim();
  if (approve && handle === "") {
    decideProblem("Type a handle for the agent this client will act as.");
    /** @type {HTMLInputElement} */ (el("handle")).focus();
    return;
  }
  mine.busy = true;
  setBusy(true);
  el("decide-error").hidden = true;
  /** @type {Record<string, unknown>} */
  const args = { request_id: mine.id, approve };
  if (approve) args.handle = handle;
  try {
    const r = await post("/api/web/oauth/decide", args);
    if (r.status === "approval_required") {
      await approveWithPasskey(mine, String(r.approval));
      return;
    }
    leave(String(r.redirect_to));
  } catch (err) {
    if (open !== mine) return;
    if (err instanceof SignedOut) {
      // The session ended meanwhile: sign in again, then ask for a new request.
      stopCountdown();
      open = null;
      await pairer.begin("Signed out: the board no longer accepts this session.");
      return;
    }
    const code = err instanceof BoardError ? err.code : "";
    if (code === "not_found") {
      problem(`The request is unknown, expired or already decided. ${START_OVER}`);
      return;
    }
    if (code === "forbidden") {
      problem(`${messageOf(err)} Only the board's administrator can approve a client.`);
      return;
    }
    // exists, conflict, bad_request, or a network error: the request stays pending, so the form stays usable.
    mine.busy = false;
    setBusy(false);
    decideProblem(`Not approved: ${messageOf(err)}${code === "conflict" || code === "exists" || code === "bad_request" ? " Pick another handle." : ""}`);
    /** @type {HTMLInputElement} */ (el("handle")).focus();
  }
}

/**
 * The board wants a passkey's approval before it decides (issue #54): the
 * panel takes the place of the buttons, the request stays pending, and the
 * approval's own answer is the decision's, so it ends the way a direct one does.
 * @param {NonNullable<typeof open>} mine
 * @param {string} approval
 */
async function approveWithPasskey(mine, approval) {
  el("consent-actions").hidden = true;
  const box = el("consent-approval");
  box.hidden = false;
  const run = startApproval(approval, box);
  approving = run;
  const value = await run.done;
  if (approving !== run || open !== mine) return;
  approving = null;
  if (!value) {
    // Expired, or the board no longer knows it: the request is over with it.
    problem(`The approval did not go through. ${START_OVER}`);
    return;
  }
  leave(String(value.result.redirect_to));
}

wirePasskeySignIn(el, async () => {
  pairer.stop();
  await begin();
});
el("pair-new").addEventListener("click", () => void pairer.begin(""));
el("approve").addEventListener("click", () => void decide(true));
el("deny").addEventListener("click", () => void decide(false));
el("handle").addEventListener("input", updateHandleNote);
el("agents").addEventListener("change", () => {
  const v = /** @type {HTMLSelectElement} */ (el("agents")).value;
  if (v !== "") /** @type {HTMLInputElement} */ (el("handle")).value = v;
  updateHandleNote();
});

void begin();

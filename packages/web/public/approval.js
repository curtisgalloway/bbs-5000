// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0
// @ts-check

/**
 * The approval panel (issue #54, design §12 "Approving with a passkey"): what a
 * passkey on a device the person holds is asked to sign. A gated action (a
 * pairing code, a connector, removing a passkey) waits for it. The panel reads
 * the request by its secret approval id (`/api/web/approval/start`), says in a
 * sentence what is being approved, shows the match code, and on a button press
 * asks the browser for the security key and sends the answer to
 * `/api/web/approval/finish`. Three places use it: the standalone `/approve`
 * page, the pairing sign-in (`createApprovalSlot`, called from `signin.js`) and
 * the consent page and Passkeys tab, which show it inline.
 *
 * Everything shown comes from the board and may name things other people chose
 * (a browser's label, a client's name): it is set as text nodes only. The
 * approval id is a secret that lives in a variable here and goes to the board
 * in a request body; it is never written to web storage or the address. There
 * is no Decline button: closing the page declines, and the request expires.
 */

import { BoardError, post } from "./signin.js";
import { assertionJson, cancelled, fromB64u, passkeysSupported } from "./webauthn.js";

/** One clock tick of the "Expires in" line; text only, no animation. */
const TICK_MS = 1000;

/**
 * The sentence for what is being approved, from the scope the board built.
 * @param {string} action
 * @param {Record<string, unknown>} scope
 */
export function describeScope(action, scope) {
  const s = (/** @type {string} */ k) => String(scope[k] ?? "");
  if (action === "web_pairing_approve") return `Sign in the browser labeled "${s("label")}" as ${s("handle")}.`;
  if (action === "oauth_decide") {
    return `Let ${s("client_name")} (${s("client")}) act as the agent ${s("agent")}; it returns to ${s("redirect_origin")}.`;
  }
  if (action === "passkey_remove") return `Remove the passkey "${s("label")}" from ${s("handle")}.`;
  return `An action this page does not know (${action}). Do not approve it.`;
}

/** The board's message, ended as a sentence so more text can follow. @param {unknown} err */
function sentence(err) {
  const m = err instanceof Error ? err.message : String(err);
  return /[.!?]$/.test(m) ? m : `${m}.`;
}

/** @param {number} ms */
function timeLeft(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  if (s >= 60) {
    const m = Math.ceil(s / 60);
    return `Expires in ${m} ${m === 1 ? "minute" : "minutes"}`;
  }
  return `Expires in ${s} ${s === 1 ? "second" : "seconds"}`;
}

/**
 * Show one approval request in `container` and let the person approve it.
 * `done` resolves with the finish call's `value` (`{ status: "approved",
 * action, result }`) once approved, or with null when the request ended
 * without an approval (expired, unknown, refused for good, or `stop()` was
 * called); the panel says which, as text. `stop()` clears the panel.
 * @param {string} approvalId
 * @param {{ notOn?: string }} [opts] `notOn`: an action this place must not approve (the standalone page leaves a connector to its consent page, which can follow the redirect)
 * @param {HTMLElement} container
 * @returns {{ done: Promise<{ status: string, action: string, result: Record<string, any> } | null>, stop: () => void }}
 */
export function startApproval(approvalId, container, opts = {}) {
  const doc = container.ownerDocument;
  const make = (/** @type {string} */ tag, /** @type {string} */ cls, /** @type {string} */ text = "") => {
    const e = doc.createElement(tag);
    if (cls) e.className = cls;
    e.textContent = text;
    return e;
  };
  const root = make("div", "approval");
  const what = make("p", "approval-what");
  const code = make("p", "approval-code");
  code.setAttribute("aria-label", "Match code");
  const check = make("p", "note", "Check that this code matches the one shown where you made the request.");
  const time = make("p", "note approval-time");
  const button = /** @type {HTMLButtonElement} */ (make("button", "", "Approve with security key"));
  button.type = "button";
  button.hidden = true;
  const state = make("p", "approval-state");
  state.setAttribute("role", "status");
  state.setAttribute("aria-live", "polite");
  const request = make("div", "approval-request");
  request.hidden = true;
  request.append(what, code, check, time);
  root.append(request, button, state);
  container.replaceChildren(root);
  state.textContent = "Loading the request…";

  /** @type {(v: { status: string, action: string, result: Record<string, any> } | null) => void} */
  let settle = () => {};
  const done = new Promise((resolve) => {
    settle = resolve;
  });
  let over = false;
  let busy = false;
  let expiresAt = 0;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  /** @type {PublicKeyCredentialRequestOptions | null} */
  let options = null;

  /** The request cannot be approved any more: say why and settle with null. @param {string} text */
  function end(text) {
    if (over) return;
    over = true;
    if (timer) clearTimeout(timer);
    button.hidden = true;
    state.textContent = text;
    settle(null);
  }

  function tick() {
    if (over) return;
    const left = expiresAt - Date.now();
    if (left <= 0) {
      time.textContent = "This request has expired.";
      if (!busy) end("Expired: nothing was approved. Start again from where you made the request.");
      return;
    }
    time.textContent = timeLeft(left);
    timer = setTimeout(tick, TICK_MS);
  }

  async function load() {
    let r;
    try {
      r = await post("/api/web/approval/start", { approval: approvalId });
    } catch (err) {
      if (err instanceof BoardError && err.status === 404) {
        end("This request has expired, was already decided, or does not exist. Nothing was approved.");
      } else end(`Cannot approve this request: ${sentence(err)} Nothing was approved.`);
      return;
    }
    if (over) return;
    if (opts.notOn !== undefined && r.action === opts.notOn) {
      end("Approve this on the connector's consent page.");
      return;
    }
    what.textContent = describeScope(String(r.action), r.scope ?? {});
    code.textContent = String(r.match_code);
    expiresAt = Number(r.expires_at);
    const pk = r.publicKey;
    options = {
      challenge: fromB64u(String(pk.challenge)),
      rpId: String(pk.rpId),
      allowCredentials: (pk.allowCredentials ?? []).map(
        (/** @type {{ id: string, transports?: AuthenticatorTransport[] }} */ c) => ({
          type: "public-key",
          id: fromB64u(c.id),
          ...(c.transports ? { transports: c.transports } : {}),
        }),
      ),
      userVerification: "required",
      timeout: Number(pk.timeout),
    };
    request.hidden = false;
    tick();
    if (!passkeysSupported()) {
      state.textContent = "This browser cannot use passkeys. Open this request in a browser that can.";
      return;
    }
    state.textContent = "Waiting for you to approve.";
    button.hidden = false;
  }

  async function approve() {
    if (over || busy || !options) return;
    busy = true;
    button.disabled = true;
    state.textContent = "Approving: use your security key…";
    try {
      const credential = /** @type {PublicKeyCredential | null} */ (await navigator.credentials.get({ publicKey: options }));
      if (!credential) throw new Error("no passkey was chosen");
      if (over) return;
      const value = await post("/api/web/approval/finish", { approval: approvalId, credential: assertionJson(credential) });
      if (over) return;
      over = true;
      if (timer) clearTimeout(timer);
      button.hidden = true;
      time.textContent = "";
      state.textContent = "Approved.";
      settle(value);
    } catch (err) {
      if (over) return;
      if (err instanceof BoardError && err.status === 404) {
        end("This request has expired, was already decided, or does not exist. Nothing was approved.");
      } else if (err instanceof BoardError) {
        state.textContent = `Refused: ${sentence(err)} Nothing was approved.`;
      } else if (cancelled(err)) {
        state.textContent = "Cancelled: nothing was approved. Press the button to try again.";
      } else {
        state.textContent = `Nothing was approved (${err instanceof Error ? err.message : String(err)}). Press the button to try again.`;
      }
    } finally {
      busy = false;
      if (!over) button.disabled = false;
    }
  }

  button.addEventListener("click", () => void approve());
  void load();

  return {
    done,
    stop() {
      if (timer) clearTimeout(timer);
      if (!over) {
        over = true;
        settle(null);
      }
      container.replaceChildren();
    },
  };
}

/**
 * A place that shows at most one approval panel, following what a poll says
 * (the pairing sign-in): `sync(id)` opens the panel for a new id, keeps the open
 * one for the same id, and removes it when `id` is undefined.
 * @param {HTMLElement} container
 */
export function createApprovalSlot(container) {
  /** @type {{ id: string, run: ReturnType<typeof startApproval> } | null} */
  let current = null;
  function stop() {
    current?.run.stop();
    current = null;
    container.replaceChildren();
  }
  return {
    stop,
    /** @param {string | undefined} id */
    sync(id) {
      if (id === undefined) {
        if (current) stop();
        return;
      }
      if (current?.id === id) return;
      stop();
      current = { id, run: startApproval(id, container) };
    },
  };
}

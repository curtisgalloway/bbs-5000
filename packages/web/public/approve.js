// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0
// @ts-check

/**
 * The standalone approving page (issue #54, `/approve#<approval id>`). The
 * link comes from the CLI or an agent's tool result when a gated action waits
 * for a passkey. The approval id is a secret, so it travels in the fragment
 * (never in a request line or a log); this page reads it, then removes it from
 * the address with `history.replaceState` so it does not stay in the address
 * bar or a bookmark. The board session is not needed: the secret id and the
 * passkey are the proof. All shown text comes from `approval.js`, as text nodes.
 */

import { startApproval } from "./approval.js";
import { el } from "./signin.js";

// Take the fragment out of the address first, before anything that can throw, then decode it;
// a malformed one is the same as an unknown request.
const rawFragment = location.hash.replace(/^#/, "");
history.replaceState(null, "", location.pathname + location.search);
let approvalId = "";
let malformed = false;
try {
  approvalId = decodeURIComponent(rawFragment);
} catch {
  malformed = true;
}
el("approve-title").focus();

if (malformed) {
  el("approve-result").textContent = "This request has expired, was already decided, or does not exist. Nothing was approved.";
} else if (approvalId === "") {
  el("approve-result").textContent = "This page needs the link from an approval request. Open the link the command or the agent gave you.";
} else {
  void startApproval(approvalId, el("approval"), { notOn: "oauth_decide" }).done.then((value) => {
    if (!value) return;
    const result = el("approve-result");
    result.textContent = "Approved. You can close this page.";
    if (value.action === "web_pairing_approve") {
      const label = String(value.result?.label ?? "");
      const line = document.createElement("p");
      line.textContent = `The browser labeled "${label}" is being signed in.`;
      result.after(line);
    }
  });
}

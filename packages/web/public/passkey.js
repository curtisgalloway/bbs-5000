// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0
// @ts-check

/**
 * The browser side of passkeys (issue #54, design §12): the calls to the
 * board's four passkey endpoints around `navigator.credentials`. Binary fields
 * travel as base64url text. The relying party id and the origin are never sent
 * from here: the board takes them from the request itself.
 */

import { post, SignedOut } from "./signin.js";
import { assertionJson, cancelled, fromB64u, passkeysSupported, toB64u } from "./webauthn.js";

export { cancelled, passkeysSupported };

/**
 * Sign in with a passkey: ask the board for a challenge, let the person pick
 * one of their passkeys for this site, and send the board the signed answer.
 * On success the board has set the session cookie. Throws what `post` throws,
 * or the browser's own error when the prompt is cancelled (see `cancelled`).
 */
export async function signInWithPasskey() {
  const options = await post("/api/web/passkey/signin/start", {});
  const credential = /** @type {PublicKeyCredential | null} */ (
    await navigator.credentials.get({
      publicKey: {
        challenge: fromB64u(String(options.challenge)),
        rpId: String(options.rpId),
        allowCredentials: [],
        userVerification: "required",
        timeout: Number(options.timeout),
      },
    })
  );
  if (!credential) throw new Error("no passkey was chosen");
  await post("/api/web/passkey/signin/finish", { credential: assertionJson(credential) });
}

/**
 * Register a passkey for the signed-in person, with a label. Needs a session
 * made by a pairing code; the board refuses otherwise. Throws like
 * `signInWithPasskey`.
 * @param {string} label
 */
export async function registerPasskey(label) {
  const o = await post("/api/web/passkey/register/start", {});
  const credential = /** @type {PublicKeyCredential | null} */ (
    await navigator.credentials.create({
      publicKey: {
        challenge: fromB64u(String(o.challenge)),
        rp: { id: String(o.rp.id), name: String(o.rp.name) },
        user: { id: fromB64u(String(o.user.id)), name: String(o.user.name), displayName: String(o.user.displayName) },
        pubKeyCredParams: o.pubKeyCredParams,
        timeout: Number(o.timeout),
        excludeCredentials: o.excludeCredentials.map(
          (/** @type {{ id: string, transports?: AuthenticatorTransport[] }} */ c) => ({
            type: "public-key",
            id: fromB64u(c.id),
            ...(c.transports ? { transports: c.transports } : {}),
          }),
        ),
        authenticatorSelection: { residentKey: "required", requireResidentKey: true, userVerification: "required" },
        attestation: "none",
      },
    })
  );
  if (!credential) throw new Error("no passkey was made");
  const response = /** @type {AuthenticatorAttestationResponse} */ (credential.response);
  await post("/api/web/passkey/register/finish", {
    label,
    credential: {
      id: credential.id,
      rawId: toB64u(credential.rawId),
      type: credential.type,
      response: {
        clientDataJSON: toB64u(response.clientDataJSON),
        attestationObject: toB64u(response.attestationObject),
        transports: typeof response.getTransports === "function" ? response.getTransports() : [],
      },
    },
  });
}

/** Show or hide the sign-in panel's passkey block for this browser, and clear its status line. @param {(id: string) => HTMLElement} el */
export function resetPasskeySignIn(el) {
  el("passkey-signin").hidden = !passkeysSupported();
  el("passkey-signin-status").textContent = "";
}

/**
 * Wire the sign-in panel's passkey button (shared by the main page and the
 * consent page): on click, ask for a passkey and say how it went as text; a
 * cancelled prompt is not an error. On success `onSignedIn` runs.
 * @param {(id: string) => HTMLElement} el
 * @param {() => Promise<void>} onSignedIn
 */
export function wirePasskeySignIn(el, onSignedIn) {
  el("passkey-signin-button").addEventListener("click", () => {
    void (async () => {
      const status = el("passkey-signin-status");
      status.textContent = "Waiting for your browser…";
      try {
        await signInWithPasskey();
        status.textContent = "";
        await onSignedIn();
      } catch (err) {
        if (cancelled(err)) status.textContent = "Cancelled.";
        else if (err instanceof SignedOut) status.textContent = `That passkey was not accepted (${err.message}).`;
        else status.textContent = `Could not sign in with a passkey: ${err instanceof Error ? err.message : String(err)}`;
      }
    })();
  });
}

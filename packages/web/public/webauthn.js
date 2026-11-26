// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0
// @ts-check

/**
 * What the web view's passkey code shares with the approval panel (issue #54):
 * whether this browser can do passkeys at all, the base64url text binary fields
 * travel as, the browser's cancelled-prompt error, and the JSON-safe form of an
 * assertion. No imports, so `passkey.js` and `approval.js` can both use it.
 */

/** Whether this browser can do passkeys at all; the sign-in button shows only when it can. */
export function passkeysSupported() {
  return typeof window !== "undefined" && "PublicKeyCredential" in window && !!navigator.credentials;
}

/** @param {ArrayBuffer | ArrayBufferView} buf */
export function toB64u(buf) {
  const bytes = buf instanceof ArrayBuffer ? new Uint8Array(buf) : new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** @param {string} text */
export function fromB64u(text) {
  const bin = atob(text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** The browser cancelled or timed out the prompt (the person closed it): not an error to report loudly. @param {unknown} err */
export function cancelled(err) {
  return err instanceof DOMException && (err.name === "NotAllowedError" || err.name === "AbortError");
}

/**
 * An assertion (the answer to `navigator.credentials.get`) as the JSON the
 * board's sign-in and approval endpoints take.
 * @param {PublicKeyCredential} credential
 */
export function assertionJson(credential) {
  const response = /** @type {AuthenticatorAssertionResponse} */ (credential.response);
  return {
    id: credential.id,
    rawId: toB64u(credential.rawId),
    type: credential.type,
    response: {
      clientDataJSON: toB64u(response.clientDataJSON),
      authenticatorData: toB64u(response.authenticatorData),
      signature: toB64u(response.signature),
      ...(response.userHandle ? { userHandle: toB64u(response.userHandle) } : {}),
    },
  };
}

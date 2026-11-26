// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0

/**
 * Fetching a client's metadata document for the consent page (issue #55,
 * design §9 step 3) and, for a client that signs its requests, its key set.
 * The Worker does the fetch because `core` never does; the
 * board then validates what came back. The fetch goes only to an https address
 * on a public hostname, follows no redirects, gives up after a timeout and
 * reads at most a byte cap. Plain TypeScript with the fetch function passed
 * in, so the unit tests run under Node.
 */

import { checkClientIdUrl, checkJwksUri } from "@bbs-5000/core";
import { readCapped } from "./http.ts";

export type FetchedDocument = { ok: true; doc: unknown } | { ok: false; reason: string };

export interface FetchOptions {
  /** The test-only allowance for a client address on localhost (see `loopbackClientsAllowed`). */
  allowLoopback: boolean;
  timeoutMs: number;
  maxBytes: number;
  /** Defaults to the global `fetch`. */
  fetchFn?: typeof fetch;
}

/**
 * The test-only allowance that lets the e2e harness serve a client document
 * from a local port over plain http. It takes both the flag (set in the
 * harness's own env file, never by `npm run setup`) and a request that arrived
 * on a loopback hostname, so a deployed board, reached by its own hostname,
 * cannot have it switched on by a stray variable.
 */
export function loopbackClientsAllowed(flag: string | undefined, url: URL): boolean {
  return flag === "1" && (url.hostname === "127.0.0.1" || url.hostname === "localhost");
}

/** Fetch and parse the metadata document at `clientId`; never throws. */
export async function fetchClientDocument(clientId: string, opts: FetchOptions): Promise<FetchedDocument> {
  const checked = checkClientIdUrl(clientId, opts.allowLoopback);
  if (!checked.ok) return { ok: false, reason: checked.reason };
  return fetchJson(checked.url, opts);
}

/**
 * Fetch and parse a client's key set from its `jwks_uri` (design §9 "Client
 * authentication"), under the same rules as its document (https, a public
 * hostname, no redirects, a timeout, a byte cap) and one more: the address's
 * hostname must be the client_id's. Never throws.
 */
export async function fetchClientKeys(jwksUri: string, clientId: string, opts: FetchOptions): Promise<FetchedDocument> {
  const checked = checkJwksUri(jwksUri, clientId, opts.allowLoopback);
  if (!checked.ok) return { ok: false, reason: checked.reason };
  return fetchJson(checked.url, opts);
}

async function fetchJson(url: URL, opts: FetchOptions): Promise<FetchedDocument> {
  const doFetch = opts.fetchFn ?? fetch;
  let res: Response;
  try {
    res = await doFetch(url.href, {
      method: "GET",
      // A redirect could lead anywhere, including to an address the host rules refuse.
      redirect: "manual",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(opts.timeoutMs),
    });
  } catch (err) {
    return { ok: false, reason: isTimeout(err) ? "it took too long to answer" : "it could not be reached" };
  }
  if (res.status >= 300 && res.status < 400) {
    await res.body?.cancel().catch(() => undefined);
    return { ok: false, reason: "it redirects, and redirects are not followed" };
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    return { ok: false, reason: `it answered HTTP ${res.status}` };
  }
  const tooBig = { ok: false, reason: `it is larger than ${opts.maxBytes} bytes` } as const;
  const declared = Number(res.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > opts.maxBytes) {
    await res.body?.cancel().catch(() => undefined);
    return tooBig;
  }
  let body: Awaited<ReturnType<typeof readCapped>>;
  try {
    body = await readCapped(res.body, opts.maxBytes);
  } catch (err) {
    return { ok: false, reason: isTimeout(err) ? "it took too long to answer" : "it could not be read" };
  }
  if (!body.ok) return tooBig;
  try {
    return { ok: true, doc: JSON.parse(body.text) as unknown };
  } catch {
    return { ok: false, reason: "it is not JSON" };
  }
}

function isTimeout(err: unknown): boolean {
  return err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
}

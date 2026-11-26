// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0

/**
 * Request helpers for the Worker: bearer parsing, `via` derivation, and the
 * HTTP status for a tool error. Plain TypeScript with no Workers globals, so
 * the unit tests run under Node.
 */

import type { ErrorCode, ToolResult, UserKind, Via } from "@bbs-5000/core";

/** Header a first-party client sends to say what it is (`cli`). */
export const CLIENT_HEADER = "x-bbs-client";
/** Header carrying the caller's board session, from `bbs_join` (B7). */
export const SESSION_HEADER = "x-bbs-session";

/** Longest session id the Worker passes on; longer ones are cut (and then
 * refused by `core` as an unknown session). Over-long tokens are refused by
 * `core` (`MAX_TOKEN_LENGTH`), never cut. */
const MAX_SESSION = 128;

/** Largest request body accepted on `/api` and `/mcp`. */
export const MAX_BODY_BYTES = 256 * 1024;

export type Endpoint = "/api" | "/mcp" | "/ws";

/** The token from `Authorization: Bearer <token>`, or undefined. Returned
 * whole; `core` refuses one longer than `MAX_TOKEN_LENGTH`. */
export function bearerToken(header: string | null): string | undefined {
  if (!header) return undefined;
  const m = /^Bearer[ ]+(\S+)\s*$/i.exec(header);
  return m?.[1] || undefined;
}

/** The claimed session id, if any, cut to a sane length. */
export function sessionFrom(header: string | null): string | undefined {
  if (!header) return undefined;
  const s = header.trim();
  return s === "" ? undefined : s.slice(0, MAX_SESSION);
}

/**
 * Human `via` values a client may name in `x-bbs-client`: only `cli` (the
 * `bbs` CLI). `web` is no longer one of them (issue #47): the web view signs
 * in with a pairing code and a session cookie, and `via = web` comes only
 * from that cookie (`authenticateCookie` in index.ts), so a bearer token that
 * says it is the web view is treated like an unnamed client. `app-typed` and
 * `app-voice` belong to the phone app, which v1 does not build. The header
 * is only honored for a person: an agent is `api` on `/api` whatever it
 * claims.
 */
const HUMAN_CLIENTS: ReadonlySet<string> = new Set(["cli"]);

/**
 * `via` before the caller is known, used on a refused sign-in's audit row:
 * always the endpoint's own value. An unauthenticated caller's
 * `x-bbs-client` header is not trusted; it goes in the row's detail instead
 * (`claimedClient`).
 */
export function provisionalVia(endpoint: Endpoint): Via {
  return endpoint === "/mcp" ? "mcp" : endpoint === "/ws" ? "ws" : "api";
}

/** The client an unauthenticated caller claimed, cut short, for audit detail. */
export function claimedClient(clientHeader: string | null): string | undefined {
  const c = clientHeader?.trim();
  return c ? c.slice(0, 32) : undefined;
}

/**
 * `via` for an authenticated caller (B7), from the endpoint and the user's
 * kind: an agent is `mcp` on `/mcp` and `api` on `/api` (whatever client it
 * uses); a person on `/api` with a bearer token is `cli` when they name it. A
 * person who names no client, or names `web`, gets `api`, which `core` refuses
 * for humans: the web view's `via = web` comes only from a session cookie, set
 * by the Worker, never from a header. Humans on `/mcp` get `mcp`, which `core`
 * refuses too; the Worker refuses them first.
 */
export function deriveVia(endpoint: Endpoint, kind: UserKind, clientHeader: string | null): Via {
  if (endpoint === "/mcp") return "mcp";
  // The adapter socket (M2): agents only; a person is refused before use.
  if (endpoint === "/ws") return "ws";
  if (kind === "agent") return "api";
  const client = clientHeader?.trim().toLowerCase() ?? "";
  return HUMAN_CLIENTS.has(client) ? (client as Via) : "api";
}

export const STATUS: Readonly<Record<ErrorCode, number>> = {
  bad_request: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  unknown_action: 404,
  exists: 409,
  topic_archived: 409,
  conflict: 409,
  rate_limited: 429,
  internal: 500,
};

/** HTTP status for a board error code (500 for one not listed). */
export function statusForCode(code: string | undefined): number {
  return (code && STATUS[code as ErrorCode]) || 500;
}

/** HTTP status for a tool result on `/api`. */
export function statusFor(result: ToolResult): number {
  if (!result.isError) return 200;
  const error = result.structuredContent.error as { code?: string } | undefined;
  const code = error?.code as ErrorCode | undefined;
  return (code && STATUS[code]) || 500;
}

/**
 * The key failed sign-ins are limited by (B5): the client address Cloudflare
 * puts in `CF-Connecting-IP` (set by Cloudflare at the edge, so a client
 * cannot choose it there), or `local` when the header is absent. Under
 * `wrangler dev` the header is present and holds the loopback address (M4a
 * e2e), so every local caller shares one key. A valid token is never
 * refused by this limit, so sharing a key costs only audit detail, not
 * access.
 */
export function signInSource(cfConnectingIp: string | null): string {
  const ip = cfConnectingIp?.trim();
  return ip ? `ip:${ip.slice(0, 60)}` : "local";
}

/** Whole seconds for `Retry-After` from milliseconds: rounded up, at least 1. */
export function retryAfterSeconds(ms: number | undefined): number {
  if (ms === undefined || !Number.isFinite(ms) || ms <= 0) return 1;
  return Math.max(1, Math.ceil(ms / 1000));
}

/** Tool name from an `/api/<tool>` path, or undefined. */
export function apiToolName(pathname: string): string | undefined {
  const m = /^\/api\/([a-z_]{1,64})\/?$/.exec(pathname);
  return m?.[1];
}

/** True for the agents' hostname (`api.example.com`): any host whose first
 * label is `api`. The web view's host, and `localhost` under `wrangler dev`,
 * are not. */
export function isApiHost(hostname: string): boolean {
  return hostname.toLowerCase().startsWith("api.");
}

/** True for the paths the API host serves: the token endpoints, the OAuth metadata and token routes, and `/health`.
 * Everything else there is 404, so the web view cannot be used on that host
 * (it has no Cloudflare Access in front of it). */
export function isApiPath(pathname: string): boolean {
  return (
    pathname === "/health" ||
    pathname === "/mcp" ||
    pathname === "/ws" ||
    pathname === "/api" ||
    pathname.startsWith("/api/") ||
    OAUTH_API_PATHS.has(pathname)
  );
}

/** Parse a JSON request body; an empty body is `{}`. Invalid JSON is
 * reported, and the Worker refuses it (audited) as `bad_request`. */
export function parseArgs(text: string): { ok: true; args: unknown } | { ok: false } {
  if (text.trim() === "") return { ok: true, args: {} };
  try {
    return { ok: true, args: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

/**
 * Read a request body as text, stopping as soon as it passes `max` bytes,
 * whatever `content-length` says (it may be absent, chunked, or wrong).
 */
export async function readCapped(
  body: ReadableStream<Uint8Array> | null,
  max: number = MAX_BODY_BYTES,
): Promise<{ ok: true; text: string } | { ok: false }> {
  if (!body) return { ok: true, text: "" };
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      return { ok: false };
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return { ok: true, text: new TextDecoder().decode(all) };
}

/**
 * Hide anything shaped like a credential in text bound for a log: board
 * tokens (`bbs_` + 43 base64url characters; tool names are far shorter),
 * bearer values, and any long run of base64url or hex characters (a human
 * credential has no fixed prefix).
 */
export function redactSecrets(text: string): string {
  return text
    .replace(/\bbbs_[A-Za-z0-9_-]{20,}/g, "bbs_[redacted]")
    .replace(/\b(Bearer)\s+\S+/gi, "$1 [redacted]")
    .replace(/[A-Za-z0-9_+\/=-]{24,}/g, "[redacted]");
}

/**
 * The log line for an unexpected error in the Worker: the path, a random
 * reference to correlate with the client's report, and the error's name
 * only. The message is never logged: it could carry request content or part
 * of a token (security review of M1b).
 */
export function internalErrorLine(path: string, ref: string, err: unknown): string {
  const name = err instanceof Error ? err.name : typeof err;
  return `internal error on ${redactSecrets(path).slice(0, 200)} (ref ${ref}): ${redactSecrets(name).slice(0, 64)}`;
}

/** The two unauthenticated web sign-in endpoints (issue #47), served on the web host only. */
export const PAIR_START_PATH = "/api/web/pair/start";
export const PAIR_CLAIM_PATH = "/api/web/pair/claim";
/**
 * The passkey endpoints (issue #54), served on the web host only. Registration
 * needs the session cookie; sign-in needs none.
 */
export const PASSKEY_REGISTER_START_PATH = "/api/web/passkey/register/start";
export const PASSKEY_REGISTER_FINISH_PATH = "/api/web/passkey/register/finish";
export const PASSKEY_SIGNIN_START_PATH = "/api/web/passkey/signin/start";
export const PASSKEY_SIGNIN_FINISH_PATH = "/api/web/passkey/signin/finish";
/**
 * The approval endpoints (issue #54, design §12), served on the web host only:
 * same-origin POST, no session cookie, the secret approval id and the passkey
 * are the proof.
 */
export const APPROVAL_START_PATH = "/api/web/approval/start";
export const APPROVAL_FINISH_PATH = "/api/web/approval/finish";
/** The page that approves a request with a passkey; the secret id rides in the URL fragment, which is never sent to a server. */
export const APPROVE_PAGE_PATH = "/approve";
/** The page's signed-in check: answers without a credential, and without the board when there is no cookie. */
export const SESSION_PATH = "/api/web/session";

/**
 * OAuth on `/mcp` for remote connectors (issue #55, design §9). The metadata
 * and the token and revoke routes are the API host's (the resource and the
 * issuer); the consent page, its two calls and the pairing endpoints are the
 * web host's.
 */
export const OAUTH_RESOURCE_METADATA_PATH = "/.well-known/oauth-protected-resource";
export const OAUTH_RESOURCE_METADATA_MCP_PATH = "/.well-known/oauth-protected-resource/mcp";
export const OAUTH_SERVER_METADATA_PATH = "/.well-known/oauth-authorization-server";
export const OAUTH_TOKEN_PATH = "/oauth/token";
export const OAUTH_REVOKE_PATH = "/oauth/revoke";
/** The consent page's two calls: web host only, signed in by the session cookie, same-origin POST. */
export const OAUTH_REQUEST_PATH = "/api/web/oauth/request";
export const OAUTH_DECIDE_PATH = "/api/web/oauth/decide";

/** The OAuth paths the API host serves besides `/api/...`. */
const OAUTH_API_PATHS: ReadonlySet<string> = new Set([
  OAUTH_RESOURCE_METADATA_PATH,
  OAUTH_RESOURCE_METADATA_MCP_PATH,
  OAUTH_SERVER_METADATA_PATH,
  OAUTH_TOKEN_PATH,
  OAUTH_REVOKE_PATH,
]);

/** Largest token or revoke body (a form with a code, a verifier and a few addresses). */
export const MAX_OAUTH_BODY_BYTES = 8_192;

/**
 * The API origin (the resource and the issuer) for a request's URL: a web host
 * `app.<domain>` maps to its `api.<domain>` twin; an `api.` host, and any other
 * host (workers.dev, localhost: one hostname for everything), is its own.
 */
export function apiOrigin(url: URL): string {
  const host = url.hostname.toLowerCase();
  if (!host.startsWith("app.")) return url.origin;
  const twin = new URL(url.origin);
  twin.hostname = `api.${host.slice(4)}`;
  return twin.origin;
}

/** The web origin (the consent page's) for a request's URL: `api.<domain>` maps to `app.<domain>`; otherwise the request's own origin. */
export function webOrigin(url: URL): string {
  const host = url.hostname.toLowerCase();
  if (!host.startsWith("api.")) return url.origin;
  const twin = new URL(url.origin);
  twin.hostname = `app.${host.slice(4)}`;
  return twin.origin;
}

/** The `WWW-Authenticate` challenge on `/mcp`: where to find the resource's metadata, and the one scope. */
export function mcpChallenge(url: URL): string {
  return `Bearer resource_metadata="${apiOrigin(url)}${OAUTH_RESOURCE_METADATA_MCP_PATH}", scope="board"`;
}

/** The metadata and token routes take no cookie, so any origin may call them (browser-based MCP clients). */
export const CORS_HEADERS: Readonly<Record<string, string>> = { "access-control-allow-origin": "*" };

/** A CORS preflight answer for the metadata and token routes. */
export function preflight(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      ...CORS_HEADERS,
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "content-type, authorization, mcp-protocol-version",
      "access-control-max-age": "86400",
    },
  });
}

/** The fields of a form body (`application/x-www-form-urlencoded`) as strings; the first of a repeated field. */
export function parseForm(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const [k, v] of new URLSearchParams(text)) if (!out.has(k)) out.set(k, v);
  return out;
}

/** `redirect_uri` with `params` added to its query (an undefined value is left out). */
export function redirectWith(redirectUri: string, params: Record<string, string | undefined>): string {
  const u = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) u.searchParams.set(k, v);
  return u.href;
}

/** Largest claim body: the JSON holding one poll secret. */
export const MAX_CLAIM_BYTES = 2_048;
/** Largest passkey body: a start's empty object, or a finish's credential (an attestation or assertion, with RSA keys at most a few KB). */
export const MAX_PASSKEY_BYTES = 32 * 1024;

/**
 * The web session cookie's name: `__Host-bbs-session` over https (the prefix
 * makes the browser insist on `Secure`, `Path=/` and no `Domain`), plain
 * `bbs-session` over http, which is only localhost under `wrangler dev`.
 */
export function sessionCookieName(secure: boolean): string {
  return secure ? "__Host-bbs-session" : "bbs-session";
}

/** One cookie's value from a `Cookie` header, or undefined. */
export function readCookie(header: string | null, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) {
      const value = part.slice(eq + 1).trim();
      return value === "" ? undefined : value;
    }
  }
  return undefined;
}

/** `Set-Cookie` for a new session: HttpOnly, SameSite=Strict, Path=/, and Secure over https. */
export function sessionSetCookie(value: string, secure: boolean, maxAgeSeconds: number): string {
  return `${sessionCookieName(secure)}=${value}; Max-Age=${maxAgeSeconds}; Path=/; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}`;
}

/** `Set-Cookie` that removes the session cookie in the browser. */
export function sessionClearCookie(secure: boolean): string {
  return `${sessionCookieName(secure)}=; Max-Age=0; Path=/; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}`;
}

/** A browser and system, like "Chrome on macOS", from a `User-Agent` header; the pairing's requester label. */
export function summarizeUserAgent(userAgent: string | null): string {
  const ua = userAgent ?? "";
  const browsers: [RegExp, string][] = [
    [/Edg(?:e|A|iOS)?\//, "Edge"],
    [/OPR\//, "Opera"],
    [/Firefox\/|FxiOS\//, "Firefox"],
    [/Chrome\/|CriOS\//, "Chrome"],
    [/Safari\//, "Safari"],
  ];
  const systems: [RegExp, string][] = [
    [/Windows/, "Windows"],
    [/iPhone|iPad|iPod/, "iOS"],
    [/Android/, "Android"],
    [/CrOS/, "ChromeOS"],
    [/Mac OS X|Macintosh/, "macOS"],
    [/Linux|X11/, "Linux"],
  ];
  const browser = browsers.find(([re]) => re.test(ua))?.[1];
  const system = systems.find(([re]) => re.test(ua))?.[1];
  if (browser && system) return `${browser} on ${system}`;
  return browser ?? system ?? "unknown browser";
}

/**
 * The deploy-time approval settings from the two vars. A flag is on only as
 * `1`; absent, empty or `0` is off. Any other value is not understood: for
 * `BBS_REQUIRE_APPROVAL` it is read as on (a typo must not quietly turn a
 * protection off), for `BBS_APPROVER_ALLOW_SYNCED` as off (the weaker setting),
 * each with a warning.
 */
export function approvalFromEnv(env: { BBS_REQUIRE_APPROVAL?: string | undefined; BBS_APPROVER_ALLOW_SYNCED?: string | undefined }): { required: boolean; allowSynced: boolean } {
  const flag = (name: string, value: string | undefined, whenUnclear: boolean): boolean => {
    const v = value?.trim();
    if (v === undefined || v === "" || v === "0") return false;
    if (v === "1") return true;
    console.warn(`${name} is not 1 or 0; read as ${whenUnclear ? "on" : "off"}`);
    return whenUnclear;
  };
  return {
    required: flag("BBS_REQUIRE_APPROVAL", env.BBS_REQUIRE_APPROVAL, true),
    allowSynced: flag("BBS_APPROVER_ALLOW_SYNCED", env.BBS_APPROVER_ALLOW_SYNCED, false),
  };
}

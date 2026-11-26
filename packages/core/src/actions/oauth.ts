// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0

/**
 * OAuth on `/mcp` for remote connectors (issue #55, design §9 "Connectors").
 *
 * A connector is a remote MCP client (a claude.ai connector, ChatGPT) that
 * signs in with OAuth instead of a copied token. The board is its own OAuth
 * server: the Worker is only the HTTP layer and the fetcher of the client's
 * metadata document; every rule and every table lives here. Only SHA-256
 * hashes of the pending request's id, codes and tokens are stored.
 *
 * Who may do what:
 * - request and decide: the human admin, through the web view (the Worker
 *   calls the `Board` methods; they are not tools). Approving creates an agent
 *   account or lends an existing one, the same authority as `admin_user_add`.
 * - code exchange, refresh, the client's own revoke: anyone holding the right
 *   secret, with no credential (`Board.oauthToken`, `Board.oauthRevoke`).
 *   Their refusals go through the failed sign-in guards.
 * - grants (a list) and grant revoke: a person; revoke is the human admin from
 *   the CLI only. Neither is offered on `/mcp`.
 *
 * Every write that follows a limit or a one-shot rule states it as a condition
 * of the statement and judges it by the rows changed, so two concurrent calls
 * cannot both pass.
 */

import type { Sha256 } from "../audit.ts";
import { asParams, optBool, optInt, optString, reqHandle, reqString, UNSAFE_LABEL_RE, validHandle } from "../params.ts";
import type { Sql } from "../sql.ts";
import { BbsError, denied, type ActionDef, type ActionOutcome, type BoardConfig, type Tx } from "../types.ts";
import { requestApproval } from "./approval.ts";
import { base64url, canonicalHandle, insertUserOnce } from "./common.ts";
import { parseKeySet, readStoredKeys, SIGNING_ALGS, type AuthMethod, type ClientKey, type SigningAlg } from "./client-auth.ts";

/** The one scope: act as one agent handle on the board. */
export const OAUTH_SCOPE = "board";

const MAX_URL = 2_048;
const MAX_STATE = 2_048;
const MAX_REDIRECT_URIS = 10;
const MAX_CLIENT_NAME = 80;
/**
 * Replaced token pairs kept per grant: the newest 20 (older replaced rows are
 * deleted at each issue) are what lets a replayed refresh token be recognized;
 * an older one is simply unknown. A row that has not been replaced is never
 * deleted by this cap. Prune never touches a live grant's rows.
 */
const MAX_TOKEN_ROWS = 20;
const MAX_AGENT_CHOICES = 200;

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1"]);

// ---------------------------------------------------------------------------
// Addresses (pure; the Worker uses `checkClientIdUrl` for its fetch too)

export type UrlCheck = { ok: true; url: URL } | { ok: false; reason: string };

const bad = (reason: string): UrlCheck => ({ ok: false, reason });

/** Why a hostname is not a public name (an address, `localhost`, one label), or undefined when it is. */
function hostnameProblem(hostname: string): string | undefined {
  const h = hostname.toLowerCase();
  if (h.startsWith("[") || h.includes(":")) return "an address";
  if (h === "localhost" || h.endsWith(".localhost")) return "localhost";
  if (h.endsWith(".")) return "not a plain hostname";
  const labels = h.split(".");
  if (labels.length < 2) return "a single-label name";
  // A dotted or numeric last label is an IPv4 address (the URL parser has already normalized any spelling of one).
  if (/^\d+$/.test(labels[labels.length - 1] as string)) return "an address";
  return undefined;
}

/**
 * Whether `raw` may be a client's id, and so the address its metadata document
 * is fetched from: an https URL with a path, a hostname that is not an address
 * literal, `localhost` or a single label, and no credentials or fragment.
 * `allowLoopback` is the test-only allowance (the e2e harness serves its client
 * document from a local port): it also accepts http or https on `localhost` or
 * `127.0.0.1`. The Worker decides it; a deployed board never sets it.
 */
export function checkClientIdUrl(raw: string, allowLoopback = false, what = "client_id"): UrlCheck {
  if (raw.length > MAX_URL) return bad(`${what} is too long`);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return bad(`${what} must be an https URL`);
  }
  const loopback = allowLoopback && LOOPBACK_HOSTS.has(url.hostname) && (url.protocol === "http:" || url.protocol === "https:");
  if (!loopback) {
    if (url.protocol !== "https:") return bad(`${what} must be an https URL`);
    const problem = hostnameProblem(url.hostname);
    if (problem) return bad(`${what} must name a public host, not ${problem}`);
  }
  if (url.username !== "" || url.password !== "") return bad(`${what} must not carry credentials`);
  if (url.hash !== "") return bad(`${what} must not have a fragment`);
  if (url.pathname === "/" || url.pathname === "") return bad(`${what} must have a path`);
  return { ok: true, url };
}

/**
 * Whether `raw` may be the address a client's key set is fetched from: the
 * same rules as a client id (https, a public hostname, no credentials or
 * fragment), and additionally the same hostname as the client's own address,
 * so a client cannot point the board at someone else's keys or at a server of
 * its choosing.
 */
export function checkJwksUri(raw: string, clientId: string, allowLoopback = false): UrlCheck {
  const c = checkClientIdUrl(raw, allowLoopback, "jwks_uri");
  if (!c.ok) return c;
  let host: string;
  try {
    host = new URL(clientId).hostname;
  } catch {
    return bad("jwks_uri: the client_id is not a URL");
  }
  if (c.url.hostname !== host) return bad("jwks_uri must be on the same host as the client_id");
  return c;
}

/** A redirect address: https, or http on `localhost` or `127.0.0.1` (a native client); no credentials or fragment. */
function checkRedirectUri(raw: string): UrlCheck {
  if (raw.length > MAX_URL) return bad("redirect address is too long");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return bad("redirect address is not a URL");
  }
  const ok = url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname));
  if (!ok) return bad("redirect address must be https, or http on localhost");
  if (url.username !== "" || url.password !== "") return bad("redirect address must not carry credentials");
  if (url.hash !== "") return bad("redirect address must not have a fragment");
  return { ok: true, url };
}

/**
 * Whether `presented` is one of the client's `registered` redirect addresses:
 * an exact match, except that for `http://localhost` and `http://127.0.0.1`
 * the port is ignored (a native client picks one at random).
 */
export function redirectRegistered(registered: readonly string[], presented: string): boolean {
  const p = checkRedirectUri(presented);
  if (!p.ok) return false;
  for (const r of registered) {
    if (r === presented) return true;
    if (p.url.protocol !== "http:") continue;
    const q = checkRedirectUri(r);
    if (
      q.ok &&
      q.url.protocol === "http:" &&
      q.url.hostname === p.url.hostname &&
      q.url.pathname === p.url.pathname &&
      q.url.search === p.url.search
    ) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// The client's metadata document

/** What the consent page and the token endpoint need of a client: its name, redirect addresses and how it authenticates. */
export interface ClientInfo {
  name: string;
  redirectUris: string[];
  authMethod: AuthMethod;
}

/** A client's document after validation, with the key material to store when it signs its requests. */
export interface ParsedClient extends ClientInfo {
  /** The signing algorithm the document declared (`private_key_jwt` only). */
  authAlg: SigningAlg | null;
  /** Where the key set came from, or null for an inline `jwks` (or a public client). */
  jwksUri: string | null;
  /** The public signing keys (`private_key_jwt` only). */
  keys: ClientKey[] | null;
}

export interface ClientDocumentOptions {
  /** The key set the Worker fetched from the document's `jwks_uri`. */
  fetchedJwks?: unknown;
  allowLoopback?: boolean;
}

/**
 * Validate a fetched client metadata document (design §9 step 3): its
 * `client_id` is its own address, its redirect addresses are usable, its name
 * passes the label rules, and its client authentication is one the board
 * supports (`none`, or `private_key_jwt` with exactly one of `jwks_uri` and an
 * inline `jwks`). Throws `bad_request` with the reason.
 */
export function parseClientDocument(
  doc: unknown,
  clientId: string,
  host: string,
  config: Pick<BoardConfig, "oauthJwksMaxBytes" | "oauthJwksMaxKeys">,
  opts: ClientDocumentOptions = {},
): ParsedClient {
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
    throw new BbsError("bad_request", "the client's metadata document is not a JSON object");
  }
  const d = doc as Record<string, unknown>;
  if (d.client_id !== clientId) {
    throw new BbsError("bad_request", "the client's metadata document names a client_id that is not its own address");
  }
  const uris = d.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0 || uris.length > MAX_REDIRECT_URIS) {
    throw new BbsError("bad_request", `the client's metadata document needs 1 to ${MAX_REDIRECT_URIS} redirect_uris`);
  }
  const redirectUris: string[] = [];
  for (const u of uris) {
    const c = typeof u === "string" ? checkRedirectUri(u) : bad("redirect_uris holds a non-string");
    if (!c.ok) throw new BbsError("bad_request", `the client's metadata document: ${c.reason}`);
    redirectUris.push(u as string);
  }
  const method = d.token_endpoint_auth_method;
  if (method !== undefined && method !== "none" && method !== "private_key_jwt") {
    throw new BbsError(
      "bad_request",
      "the client's metadata document asks for a client authentication method the board does not support; it supports none and private_key_jwt",
    );
  }
  let name = host;
  if (d.client_name !== undefined && d.client_name !== null) {
    if (typeof d.client_name !== "string") throw new BbsError("bad_request", "the client's name must be a string");
    const cut = d.client_name.slice(0, MAX_CLIENT_NAME).trim();
    if (UNSAFE_LABEL_RE.test(cut)) {
      throw new BbsError("bad_request", "the client's name contains a control, line-separator or bidirectional character");
    }
    if (cut !== "") name = cut;
  }
  if (method !== "private_key_jwt") {
    return { name, redirectUris, authMethod: "none", authAlg: null, jwksUri: null, keys: null };
  }
  const refuse = (why: string): never => {
    throw new BbsError("bad_request", `the client's metadata document asks for private_key_jwt but ${why}`);
  };
  const hasUri = d.jwks_uri !== undefined && d.jwks_uri !== null;
  const hasInline = d.jwks !== undefined && d.jwks !== null;
  if (hasUri && hasInline) refuse("has both jwks_uri and jwks; it must have exactly one");
  if (!hasUri && !hasInline) refuse("has neither jwks_uri nor jwks");
  let authAlg: SigningAlg | null = null;
  if (d.token_endpoint_auth_signing_alg !== undefined && d.token_endpoint_auth_signing_alg !== null) {
    const a = d.token_endpoint_auth_signing_alg;
    if (typeof a !== "string" || !(SIGNING_ALGS as readonly string[]).includes(a)) {
      refuse(`declares a token_endpoint_auth_signing_alg the board does not support; it supports ${SIGNING_ALGS.join(" and ")}`);
    }
    authAlg = a as SigningAlg;
  }
  let jwksUri: string | null = null;
  let rawKeys: unknown;
  if (hasUri) {
    if (typeof d.jwks_uri !== "string") refuse("its jwks_uri is not a string");
    const c = checkJwksUri(d.jwks_uri as string, clientId, opts.allowLoopback === true);
    if (!c.ok) throw new BbsError("bad_request", `the client's metadata document: ${c.reason}`);
    if (opts.fetchedJwks === undefined || opts.fetchedJwks === null) refuse("its key set was not fetched; try again");
    jwksUri = d.jwks_uri as string;
    rawKeys = opts.fetchedJwks;
  } else {
    rawKeys = d.jwks;
  }
  const set = parseKeySet(rawKeys, config);
  if (!set.ok) throw new BbsError("bad_request", `the client's metadata document: ${set.reason}`);
  return { name, redirectUris, authMethod: "private_key_jwt", authAlg, jwksUri, keys: set.keys };
}

/** The board's copy of a client's document, when it is newer than `oauthClientCacheMs`. */
export function cachedClient(sql: Sql, config: BoardConfig, now: number, clientId: string): ClientInfo | undefined {
  const row = sql.one<{ name: string; redirect_uris: string; fetched_at: number; auth_method: AuthMethod }>(
    "SELECT name, redirect_uris, fetched_at, auth_method FROM oauth_clients WHERE client_id = ?",
    clientId,
  );
  if (!row || Number(row.fetched_at) <= now - config.oauthClientCacheMs) return undefined;
  return { name: row.name, redirectUris: JSON.parse(row.redirect_uris) as string[], authMethod: row.auth_method };
}

// ---------------------------------------------------------------------------
// Shared rules

/** `S256`: the code challenge for a verifier, base64url of the SHA-256 of its ASCII bytes. */
export function s256(sha256: Sha256, verifier: string): string {
  const hex = sha256(verifier);
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = Number.parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  return base64url(bytes);
}

const VERIFIER_RE = /^[A-Za-z0-9._~-]{43,128}$/;
const CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/;

function requireAdmin(tx: Tx, what: string, vias: readonly string[]): void {
  if (tx.actor.kind !== "human" || !tx.actor.isAdmin) throw denied(`only a human admin can ${what}`);
  if (!vias.includes(tx.ctx.via)) {
    throw denied(vias.length === 1 && vias[0] === "cli" ? `${what} is only available from the bbs CLI` : `${what} is not available here`);
  }
}

/** Start the prune timer when there is none (an INSERT judged by its own condition). */
function armPrune(tx: Tx): void {
  tx.sql.exec(
    `INSERT INTO timers (due_at, kind, ref)
     SELECT ?, 'oauth_prune', 'board'
     WHERE NOT EXISTS (SELECT 1 FROM timers WHERE kind = 'oauth_prune')`,
    tx.now + tx.config.oauthPruneIntervalMs,
  );
}

/**
 * Delete one grant with its codes and tokens, and end the live board sessions
 * that were joined through it (`sessions.grant_id`), in the caller's transaction.
 * Every path that ends a grant goes through here, so a new one cannot forget the
 * sessions. A session ends as it does everywhere else: `state = 'gone'` and
 * `detached_at`. A live `via_grant` session with no `grant_id` was made before
 * schema version 18 and cannot be attributed: when the handle has no grant left
 * after this one, those end too; while another grant remains the idle timer
 * keeps them. Returns whether the grant existed and the ids of the sessions ended.
 */
function deleteGrant(tx: Tx, id: string): { existed: boolean; ended: string[] } {
  const sql = tx.sql;
  const grant = sql.one<{ handle: string }>("SELECT handle FROM oauth_grants WHERE id = ?", id);
  sql.exec("DELETE FROM timers WHERE kind = 'oauth_code_unused' AND ref = ?", id);
  sql.exec("DELETE FROM oauth_codes WHERE grant_id = ?", id);
  sql.exec("DELETE FROM oauth_tokens WHERE grant_id = ?", id);
  const existed = sql.all<{ id: string }>("DELETE FROM oauth_grants WHERE id = ? RETURNING id", id).length > 0;
  const ended = sql
    .all<{ id: string }>(
      "UPDATE sessions SET state = 'gone', ws_open = 0, detached_at = ? WHERE grant_id = ? AND state <> 'gone' RETURNING id",
      tx.now,
      id,
    )
    .map((r) => r.id);
  if (existed && grant) {
    ended.push(
      ...sql
        .all<{ id: string }>(
          `UPDATE sessions SET state = 'gone', ws_open = 0, detached_at = ?
           WHERE handle = ? AND via_grant = 1 AND grant_id IS NULL AND state <> 'gone'
             AND NOT EXISTS (SELECT 1 FROM oauth_grants WHERE handle = ?)
           RETURNING id`,
          tx.now,
          grant.handle,
          grant.handle,
        )
        .map((r) => r.id),
    );
  }
  return { existed, ended };
}

/** Delete every grant of `handle` (a kick), ending their sessions. Returns their ids. */
export function revokeOAuthGrants(tx: Tx, handle: string): string[] {
  const ids = tx.sql.all<{ id: string }>("SELECT id FROM oauth_grants WHERE handle = ?", handle).map((r) => r.id);
  for (const id of ids) deleteGrant(tx, id);
  return ids;
}

/**
 * Bookkeeping for a call made with a grant's access token, inside `act`'s
 * transaction beside `users.last_seen`: the grant's last use.
 */
export function noteGrantUse(sql: Sql, now: number, grantId: string): void {
  sql.exec("UPDATE oauth_grants SET last_used_at = ? WHERE id = ?", now, grantId);
}

/** A short public id of a pending request for the audit row: a prefix of its hash, never the id. */
const requestTarget = (idHash: string): string => `req_${idHash.slice(0, 12)}`;

function hostOf(clientId: string): string {
  try {
    return new URL(clientId).host;
  } catch {
    return clientId;
  }
}

// ---------------------------------------------------------------------------
// Authorization request (design §9 steps 3 and 4)

/**
 * Whether `handle` is free for the page to suggest: nobody has it, or it is an
 * agent account an earlier approval made that never signed in (no static
 * token, never seen, no grant, no session), such as one left by an approval
 * whose code was never exchanged (issue #67).
 */
function suggestable(tx: Tx, handle: string): boolean {
  const stored = canonicalHandle(tx.sql, handle);
  if (stored === undefined) return true;
  const user = tx.sql.one<{ handle: string; kind: string; status: string; token_hash: string | null; last_seen: number | null }>(
    "SELECT handle, kind, status, token_hash, last_seen FROM users WHERE handle = ?",
    stored,
  );
  if (!user) return true;
  return (
    user.handle === handle &&
    user.kind === "agent" &&
    user.status === "active" &&
    user.token_hash === null &&
    user.last_seen === null &&
    !tx.sql.one("SELECT 1 AS x FROM oauth_grants WHERE handle = ?", handle) &&
    !tx.sql.one("SELECT 1 AS x FROM sessions WHERE handle = ?", handle)
  );
}

/** A handle for the page to suggest from the client's name: one nobody has, or a never-used connector account. */
function suggestHandle(tx: Tx, name: string): string {
  let base = name
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "")
    .slice(0, 24);
  if (base === "" || !validHandle(base)) base = "connector";
  let handle = base;
  for (let n = 2; n < 1_000 && !suggestable(tx, handle); n++) {
    handle = `${base}-${n}`;
  }
  return handle;
}

/**
 * Internal: validate an authorization request and, when it holds, store it as
 * pending for the person's decision. Called by `Board.oauthRequest` as the
 * signed-in human admin, `via = web`. The Worker adds `client_doc` (the
 * fetched document, when the board's copy was older than `oauthClientCacheMs`,
 * and `client_jwks`, the key set fetched from its `jwks_uri`), `resource_expected` (this board's `/mcp`) and, in tests, `allow_loopback_client`.
 *
 * A request that fails before its redirect address is known to be the
 * client's throws `bad_request`: the page shows it and never redirects. One
 * that fails after returns `status: "redirect_error"`, which the Worker turns
 * into a redirect back to the client with that error.
 */
export const oauthRequest: ActionDef = {
  name: "oauth_request",
  kind: "change",
  passive: true,
  run(tx, input) {
    requireAdmin(tx, "approve a connector", ["web"]);
    const p = asParams(input);
    const clientId = reqString(p, "client_id", MAX_URL);
    const checked = checkClientIdUrl(clientId, optBool(p, "allow_loopback_client") === true);
    if (!checked.ok) throw new BbsError("bad_request", checked.reason);
    const redirectUri = reqString(p, "redirect_uri", MAX_URL);
    // Every parameter is read before anything is written, so a malformed call leaves nothing behind.
    const state = optString(p, "state", MAX_STATE);
    const responseType = optString(p, "response_type", 32);
    const method = optString(p, "code_challenge_method", 16);
    const challenge = optString(p, "code_challenge", 256);
    const presentedResource = optString(p, "resource", MAX_URL);
    const scope = optString(p, "scope", 64);
    const expected = reqString(p, "resource_expected", MAX_URL);
    const doc = p.client_doc;
    const fetched = doc !== undefined && doc !== null;
    const parsed = fetched
      ? parseClientDocument(doc, clientId, checked.url.host, tx.config, {
          fetchedJwks: p.client_jwks,
          allowLoopback: optBool(p, "allow_loopback_client") === true,
        })
      : undefined;
    const info: ClientInfo | undefined = parsed ?? cachedClient(tx.sql, tx.config, tx.now, clientId);
    if (!info) throw new BbsError("bad_request", "the client's metadata document is not available; try again");
    if (!redirectRegistered(info.redirectUris, redirectUri)) {
      throw new BbsError("bad_request", "redirect_uri is not one of the addresses the client registered");
    }
    const redirect = checkRedirectUri(redirectUri);
    if (!redirect.ok) throw new BbsError("bad_request", redirect.reason);
    if (parsed) {
      tx.sql.exec(
        `INSERT INTO oauth_clients
           (client_id, name, redirect_uris, fetched_at, auth_method, auth_alg, jwks_uri, jwks, jwks_fetched_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (client_id) DO UPDATE SET
           name = excluded.name, redirect_uris = excluded.redirect_uris, fetched_at = excluded.fetched_at,
           auth_method = excluded.auth_method, auth_alg = excluded.auth_alg, jwks_uri = excluded.jwks_uri,
           jwks = excluded.jwks, jwks_fetched_at = excluded.jwks_fetched_at`,
        clientId,
        parsed.name,
        JSON.stringify(parsed.redirectUris),
        tx.now,
        parsed.authMethod,
        parsed.authAlg,
        parsed.jwksUri,
        parsed.keys === null ? null : JSON.stringify(parsed.keys),
        tx.now,
      );
    }
    // From here the redirect address is the client's own, so a refusal goes back to it.
    const refusal = (error: string, description: string) => ({
      value: {
        status: "redirect_error" as const,
        error,
        error_description: description,
        redirect_uri: redirectUri,
        ...(state !== undefined ? { state } : {}),
      },
      audit: { targetType: "oauth_client", targetId: clientId, detail: { outcome: "redirect_error", error, reason: description } },
    });
    if (responseType !== "code") return refusal("unsupported_response_type", "response_type must be code");
    if (method !== "S256") return refusal("invalid_request", "code_challenge_method must be S256");
    if (challenge === undefined || !CHALLENGE_RE.test(challenge)) {
      return refusal("invalid_request", "code_challenge must be the base64url SHA-256 of a verifier");
    }
    if (presentedResource !== expected) return refusal("invalid_target", "resource must be this board's /mcp address");
    if (scope !== undefined && scope !== OAUTH_SCOPE) return refusal("invalid_scope", `the only scope is ${OAUTH_SCOPE}`);

    const id = base64url(tx.randomBytes(24));
    const idHash = tx.sha256(id);
    // The board-wide limit is a condition of the INSERT: two requests cannot both take the last place.
    const inserted = tx.sql.all<{ id_hash: string }>(
      `INSERT INTO oauth_requests
         (id_hash, client_id, redirect_uri, code_challenge, resource, state, requested_by, created_at, expires_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
       WHERE (SELECT COUNT(*) FROM oauth_requests WHERE consumed_at IS NULL AND expires_at > ?) < ?
       RETURNING id_hash`,
      idHash,
      clientId,
      redirectUri,
      challenge,
      expected,
      state ?? null,
      tx.actor.handle,
      tx.now,
      tx.now + tx.config.oauthRequestTtlMs,
      tx.now,
      tx.config.oauthRequestMaxPending,
    );
    if (inserted.length === 0) {
      throw new BbsError("rate_limited", "too many authorization requests are waiting; try again in a few minutes", "denied");
    }
    armPrune(tx);
    const agents = tx.sql
      .all<{ handle: string }>("SELECT handle FROM users WHERE kind = 'agent' AND status <> 'kicked' AND parent IS NULL ORDER BY handle LIMIT ?", MAX_AGENT_CHOICES)
      .map((r) => r.handle);
    return {
      value: {
        status: "consent" as const,
        request_id: id,
        client: { id: clientId, name: info.name, host: checked.url.host },
        client_auth: info.authMethod,
        redirect: { uri: redirectUri, host: redirect.url.host, localhost: LOOPBACK_HOSTS.has(redirect.url.hostname) },
        scope: OAUTH_SCOPE,
        expires_in_ms: tx.config.oauthRequestTtlMs,
        suggested_handle: suggestHandle(tx, info.name),
        agents,
      },
      audit: {
        targetType: "oauth_request",
        targetId: requestTarget(idHash),
        detail: { client: clientId, client_name: info.name, client_auth: info.authMethod, redirect_host: redirect.url.host, fetched },
      },
    };
  },
};

// ---------------------------------------------------------------------------
// Decision (design §9 step 5)

/**
 * The agent a connector would be granted: refuses a handle that cannot be
 * (a person, a removed agent, another spelling of an existing name). The
 * consent decision is the one caller input that is not resolved to the stored
 * spelling (issue #90): the person must see, and an approval's signed scope
 * must name, the exact agent a connector will act as, so a case variant is
 * refused with the stored spelling in the message. Returns
 * whether the agent already exists. Read only, so both the request for an
 * approval and the decision itself can run it.
 */
function checkAgent(tx: Tx, handle: string): boolean {
  const stored = canonicalHandle(tx.sql, handle);
  if (stored === undefined) return false;
  if (stored !== handle) throw new BbsError("exists", `a user named ${stored} already exists`);
  const existing = tx.sql.one<{ handle: string; kind: string; status: string; parent: string | null }>(
    "SELECT handle, kind, status, parent FROM users WHERE handle = ?",
    handle,
  );
  if (!existing) return false;
  if (existing.kind !== "agent") throw denied(`${handle} is a person; a connector acts as an agent`);
  // A connector keeps its one handle and a session per chat; a local session's handle has no token and is not its to use (issue #98).
  if (existing.parent !== null) throw denied(`${handle} is a session handle of ${existing.parent}; a connector acts as an agent of its own`);
  if (existing.status === "kicked") throw new BbsError("conflict", `${handle} has been removed; reinstate it first`);
  return true;
}

function grantLimitError(tx: Tx, handle: string): BbsError {
  return new BbsError(
    "conflict",
    `${handle} already has ${tx.config.oauthGrantMaxPerHandle} connector approvals, the most allowed; revoke one first (bbs oauth revoke <id>)`,
    "denied",
  );
}

/** The client's name as the board shows it: the stored one, else its host. */
function clientName(tx: Tx, clientId: string): string {
  const named = tx.sql.one<{ name: string }>("SELECT name FROM oauth_clients WHERE client_id = ?", clientId);
  return named?.name ?? hostOf(clientId);
}

/**
 * The decision itself, as the signed-in human admin: both the ungated tool
 * and an approved request run it. The request is consumed by its first
 * decision, judged by the rows the UPDATE changes. Approving, in the same
 * transaction, creates the agent user when the handle is new (no static token),
 * makes the grant and makes a single-use authorization code.
 */
function decide(tx: Tx, idHash: string, approve: boolean, handle: string | undefined): ActionOutcome {
  const rows = tx.sql.all<{
    client_id: string;
    redirect_uri: string;
    code_challenge: string;
    resource: string;
    state: string | null;
  }>(
    `UPDATE oauth_requests SET consumed_at = ?
     WHERE id_hash = ? AND consumed_at IS NULL AND expires_at > ?
     RETURNING client_id, redirect_uri, code_challenge, resource, state`,
    tx.now,
    idHash,
    tx.now,
  );
  const req = rows[0];
  if (!req) throw new BbsError("not_found", "that request is not pending (unknown, expired or already decided)");
  const state = req.state ?? undefined;
  const target = { targetType: "oauth_request", targetId: requestTarget(idHash) };
  if (!approve || handle === undefined) {
    return {
      value: { approved: false, redirect_uri: req.redirect_uri, ...(state !== undefined ? { state } : {}) },
      audit: { ...target, detail: { client: req.client_id, approved: false } },
    };
  }
  const created = !checkAgent(tx, handle);
  if (created) {
    insertUserOnce(tx, ["handle", "kind", "token_hash", "created_at"], [handle, "agent", null, tx.now]);
  }
  const host = hostOf(req.client_id);
  const name = clientName(tx, req.client_id);
  const grant = `og_${base64url(tx.randomBytes(9))}`;
  const expiresAt = tx.now + tx.config.oauthGrantTtlMs;
  // The per-handle limit is a condition of the INSERT, judged by the row it makes.
  const made = tx.sql.all<{ id: string }>(
    `INSERT INTO oauth_grants
       (id, client_id, client_name, client_host, handle, approved_by, created_at, renewed_at, expires_at)
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
     WHERE (SELECT COUNT(*) FROM oauth_grants WHERE handle = ? AND expires_at > ?) < ?
     RETURNING id`,
    grant,
    req.client_id,
    name,
    host,
    handle,
    tx.actor.handle,
    tx.now,
    tx.now,
    expiresAt,
    handle,
    tx.now,
    tx.config.oauthGrantMaxPerHandle,
  );
  if (made.length === 0) throw grantLimitError(tx, handle);
  const code = base64url(tx.randomBytes(32));
  tx.sql.exec(
    `INSERT INTO oauth_codes (code_hash, grant_id, client_id, redirect_uri, code_challenge, resource, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    tx.sha256(code),
    grant,
    req.client_id,
    req.redirect_uri,
    req.code_challenge,
    req.resource,
    tx.now,
    tx.now + tx.config.oauthCodeTtlMs,
  );
  // A grant whose code is never exchanged ends when the code does (issue #67).
  tx.sql.exec("INSERT INTO timers (due_at, kind, ref) VALUES (?, 'oauth_code_unused', ?)", tx.now + tx.config.oauthCodeTtlMs, grant);
  armPrune(tx);
  return {
    // `code` is for the Worker's redirect only, never in the audit row.
    value: { approved: true, redirect_uri: req.redirect_uri, code, grant, handle, created, ...(state !== undefined ? { state } : {}) },
    audit: {
      targetType: "oauth_grant",
      targetId: grant,
      detail: { request: target.targetId, client: req.client_id, client_name: name, handle, created_user: created, expires_at: expiresAt },
    },
  };
}

/**
 * An approved decision to grant a connector (`approval-finish.ts`): the
 * request, by its id hash, and the agent handle the approval named. Checks the
 * caller is the human admin again; everything `decide` checks runs here too.
 * The client's name is part of what the person signed: a later authorization
 * request for the same client can store a new name from a fresh metadata
 * document, and the grant must never record a name the person did not see.
 */
export function oauthApprove(tx: Tx, idHash: string, handle: string, signedName: string): ActionOutcome {
  requireAdmin(tx, "approve a connector", ["web"]);
  const req = tx.sql.one<{ client_id: string }>("SELECT client_id FROM oauth_requests WHERE id_hash = ?", idHash);
  if (req && clientName(tx, req.client_id) !== signedName) {
    throw new BbsError("conflict", "the client's details changed after the approval was requested; start again", "denied");
  }
  return decide(tx, idHash, true, handle);
}

/**
 * Internal: the person's decision on a pending request, as the signed-in human
 * admin, `via = web`. A deny is final at once. An approval, when the board
 * requires one, is checked as always (the request pending, the agent handle
 * usable, room for a grant) and then asks for a passkey's approval instead of
 * granting; the request stays pending until the signature arrives. Called by
 * `Board.oauthDecide`.
 */
export const oauthDecide: ActionDef = {
  name: "oauth_decide",
  kind: "change",
  passive: true,
  run(tx, input) {
    requireAdmin(tx, "approve a connector", ["web"]);
    const p = asParams(input);
    const requestId = reqString(p, "request_id", 128);
    const approve = optBool(p, "approve");
    if (approve === undefined) throw new BbsError("bad_request", "approve must be true or false");
    const handle = approve ? reqHandle(p, "handle") : undefined;
    const idHash = tx.sha256(requestId);
    // Look before writing, so an unknown request changes nothing; the UPDATE in `decide` then
    // repeats the conditions and is judged by the rows it changes.
    const pending = tx.sql.one<{ client_id: string; redirect_uri: string; expires_at: number }>(
      "SELECT client_id, redirect_uri, expires_at FROM oauth_requests WHERE id_hash = ? AND consumed_at IS NULL AND expires_at > ?",
      idHash,
      tx.now,
    );
    if (!pending) throw new BbsError("not_found", "that request is not pending (unknown, expired or already decided)");
    if (tx.approval.required && approve && handle !== undefined) {
      checkAgent(tx, handle);
      const grants = tx.sql.one<{ n: number }>("SELECT COUNT(*) AS n FROM oauth_grants WHERE handle = ? AND expires_at > ?", handle, tx.now);
      if (Number(grants?.n ?? 0) >= tx.config.oauthGrantMaxPerHandle) throw grantLimitError(tx, handle);
      return requestApproval(tx, {
        action: "oauth_decide",
        ref: idHash,
        scope: {
          action: "oauth_decide",
          handle: tx.actor.handle,
          request: requestTarget(idHash),
          client: pending.client_id,
          client_name: clientName(tx, pending.client_id),
          agent: handle,
          redirect_origin: new URL(pending.redirect_uri).origin,
        },
        notAfter: Number(pending.expires_at),
      });
    }
    return decide(tx, idHash, approve, handle);
  },
};

// ---------------------------------------------------------------------------
// Tokens (design §9 steps 6, 8 and 9)

export interface TokenValue {
  access_token: string;
  refresh_token: string;
  token_type: "Bearer";
  expires_in: number;
  scope: string;
}

/** Make a new access and refresh token for `grant` and answer with them (`insertTokens` records them). */
function newTokens(tx: Tx, grant: string): { value: TokenValue; accessHash: string; refreshHash: string } {
  const access = `bbsat_${base64url(tx.randomBytes(32))}`;
  const refresh = `bbsrt_${base64url(tx.randomBytes(32))}`;
  return {
    value: {
      access_token: access,
      refresh_token: refresh,
      token_type: "Bearer",
      expires_in: Math.floor(tx.config.oauthAccessTtlMs / 1_000),
      scope: OAUTH_SCOPE,
    },
    accessHash: tx.sha256(access),
    refreshHash: tx.sha256(refresh),
  };
}

/**
 * Record a new token pair for `grant` (`parent` is the row whose refresh token
 * produced it, null for the code exchange's), then delete all but the newest
 * `MAX_TOKEN_ROWS` replaced rows. A row with `replaced_at` NULL is never deleted.
 */
function insertTokens(tx: Tx, grant: string, parent: number | null, t: { accessHash: string; refreshHash: string }): void {
  tx.sql.exec(
    `INSERT INTO oauth_tokens (grant_id, parent_id, access_hash, access_expires_at, refresh_hash, issued_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    grant,
    parent,
    t.accessHash,
    tx.now + tx.config.oauthAccessTtlMs,
    t.refreshHash,
    tx.now,
  );
  tx.sql.exec(
    `DELETE FROM oauth_tokens WHERE grant_id = ? AND replaced_at IS NOT NULL AND id NOT IN
       (SELECT id FROM oauth_tokens WHERE grant_id = ? AND replaced_at IS NOT NULL ORDER BY id DESC LIMIT ?)`,
    grant,
    grant,
    MAX_TOKEN_ROWS,
  );
}

export interface CodeParams {
  code: string;
  codeVerifier: string;
  clientId: string;
  redirectUri: string;
  resource: string;
}

export type CodeCheck =
  | { kind: "ok" }
  | { kind: "unknown" | "mismatch" | "expired" }
  /** The code was already spent: a replay, and the grant it made is to be revoked. */
  | { kind: "used"; grantId: string };

/**
 * Read-only check of an authorization code against what the client sent, so a
 * refused exchange is counted by the failed sign-in guards instead of writing
 * a row. The exchange's own UPDATE repeats every condition and is the verdict.
 */
export function checkCode(sql: Sql, sha256: Sha256, now: number, c: CodeParams): CodeCheck {
  const row = sql.one<{
    grant_id: string;
    client_id: string;
    redirect_uri: string;
    code_challenge: string;
    resource: string;
    expires_at: number;
    used_at: number | null;
  }>(
    `SELECT grant_id, client_id, redirect_uri, code_challenge, resource, expires_at, used_at
     FROM oauth_codes WHERE code_hash = ?`,
    sha256(c.code),
  );
  if (!row) return { kind: "unknown" };
  if (row.used_at !== null) return { kind: "used", grantId: row.grant_id };
  if (Number(row.expires_at) <= now) return { kind: "expired" };
  if (
    row.client_id !== c.clientId ||
    row.redirect_uri !== c.redirectUri ||
    row.resource !== c.resource ||
    !VERIFIER_RE.test(c.codeVerifier) ||
    row.code_challenge !== s256(sha256, c.codeVerifier)
  ) {
    return { kind: "mismatch" };
  }
  return { kind: "ok" };
}

/**
 * Internal: spend an authorization code and make the grant's first tokens.
 * Runs as `system`; called by `Board.oauthToken` after `checkCode` passed. The
 * one UPDATE that marks the code used is the verdict, judged by the rows it
 * changes, so two exchanges of one code make exactly one token pair.
 */
export const oauthCodeExchange: ActionDef = {
  name: "oauth_code_exchange",
  kind: "change",
  run(tx, input) {
    const p = asParams(input);
    const verifier = reqString(p, "code_verifier", 256);
    const spent = tx.sql.all<{ grant_id: string }>(
      `UPDATE oauth_codes SET used_at = ?
       WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?
         AND client_id = ? AND redirect_uri = ? AND resource = ? AND code_challenge = ?
       RETURNING grant_id`,
      tx.now,
      tx.sha256(reqString(p, "code", 256)),
      tx.now,
      reqString(p, "client_id", MAX_URL),
      reqString(p, "redirect_uri", MAX_URL),
      reqString(p, "resource", MAX_URL),
      s256(tx.sha256, verifier),
    );
    const grantId = spent[0]?.grant_id;
    if (grantId === undefined) throw new BbsError("conflict", "that code is not valid (unknown, expired or already used)", "denied");
    const grant = tx.sql.one<{ handle: string; client_id: string }>(
      "SELECT handle, client_id FROM oauth_grants WHERE id = ? AND expires_at > ?",
      grantId,
      tx.now,
    );
    if (!grant) throw new BbsError("conflict", "that grant has ended", "denied");
    const t = newTokens(tx, grantId);
    insertTokens(tx, grantId, null, t);
    return {
      value: t.value,
      audit: { targetType: "oauth_grant", targetId: grantId, detail: { handle: grant.handle, client: grant.client_id, grant_type: "authorization_code" } },
    };
  },
};

export type RefreshCheck =
  | { kind: "ok"; grantId: string }
  | { kind: "unknown" | "mismatch" | "expired" }
  /** The token already has `oauthRefreshMaxSuccessors` successors: refused, but not a replay. */
  | { kind: "limit" }
  /** A refresh token replaced longer ago than the grace: a replay, so the grant is to be revoked. */
  | { kind: "replay"; grantId: string };

/** Read-only check of a refresh token, as `checkCode` is for a code. */
export function checkRefresh(
  sql: Sql,
  config: BoardConfig,
  sha256: Sha256,
  now: number,
  token: string,
  clientId: string,
  resource: string,
  expected: string,
): RefreshCheck {
  const row = sql.one<{ grant_id: string; client_id: string; expires_at: number; replaced_at: number | null; successors: number }>(
    `SELECT g.id AS grant_id, g.client_id, g.expires_at, t.replaced_at, t.successors
     FROM oauth_tokens t JOIN oauth_grants g ON g.id = t.grant_id
     WHERE t.refresh_hash = ?`,
    sha256(token),
  );
  if (!row) return { kind: "unknown" };
  if (row.replaced_at !== null && Number(row.replaced_at) <= now - config.oauthRefreshGraceMs) {
    return { kind: "replay", grantId: row.grant_id };
  }
  if (row.client_id !== clientId || resource !== expected) return { kind: "mismatch" };
  if (Number(row.expires_at) <= now) return { kind: "expired" };
  if (Number(row.successors) >= config.oauthRefreshMaxSuccessors) return { kind: "limit" };
  return { kind: "ok", grantId: row.grant_id };
}

/**
 * Internal: issue a new token pair for a valid refresh token. Runs as
 * `system`; called by `Board.oauthToken` after `checkRefresh` passed. The
 * presented token is marked replaced (at its first presentation) and stays
 * usable for `oauthRefreshGraceMs`, so a client that lost the answer, or sent
 * two refreshes at once, can ask again; each such call issues another pair, at
 * most `oauthRefreshMaxSuccessors` from one token, and no access token is cut
 * short by a refresh. The first refresh of one of those pairs picks the
 * surviving line: its siblings (the other pairs from the same parent) are
 * retired. A refresh more than `oauthGrantRenewAfterMs` after the grant's last
 * renewal renews the grant. The UPDATE carrying the grace, grant and successor
 * conditions (and counting the successor) is the verdict, judged by rows changed.
 */
export const oauthRefresh: ActionDef = {
  name: "oauth_refresh",
  kind: "change",
  run(tx, input) {
    const p = asParams(input);
    const presented = tx.sha256(reqString(p, "refresh_token", 256));
    const grantId = reqString(p, "grant", 64);
    const rows = tx.sql.all<{ id: number; parent_id: number | null }>(
      `UPDATE oauth_tokens SET replaced_at = COALESCE(replaced_at, ?), successors = successors + 1
       WHERE grant_id = ? AND refresh_hash = ?
         AND (replaced_at IS NULL OR replaced_at > ?)
         AND successors < ?
         AND EXISTS (SELECT 1 FROM oauth_grants WHERE id = ? AND expires_at > ?)
       RETURNING id, parent_id`,
      tx.now,
      grantId,
      presented,
      tx.now - tx.config.oauthRefreshGraceMs,
      tx.config.oauthRefreshMaxSuccessors,
      grantId,
      tx.now,
    );
    const row = rows[0];
    if (!row) throw new BbsError("conflict", "that refresh token is not valid", "denied");
    // Refreshing this pair picks it as the surviving line: its siblings are retired. Their
    // `replaced_at` is set to the edge of the grace (or earlier, if already older), which is
    // what makes any later use of a sibling's refresh token a replay; their access tokens
    // end now.
    let retired = 0;
    if (row.parent_id !== null) {
      retired = tx.sql.all<{ id: number }>(
        `UPDATE oauth_tokens SET
           replaced_at = MIN(COALESCE(replaced_at, ?), ?),
           access_expires_at = MIN(access_expires_at, ?)
         WHERE grant_id = ? AND parent_id = ? AND id <> ?
         RETURNING id`,
        tx.now - tx.config.oauthRefreshGraceMs,
        tx.now - tx.config.oauthRefreshGraceMs,
        tx.now,
        grantId,
        row.parent_id,
        row.id,
      ).length;
      // The token this pair came from is closed too, however much of its grace is left: otherwise a
      // second holder could present it now and get a pair created after the retirement above, a line
      // that nothing would retire or detect. Setting its `replaced_at` to the edge of the grace
      // makes any later presentation a replay (`checkRefresh`, and the UPDATE above, which needs
      // `replaced_at` newer than now - grace).
      tx.sql.exec(
        "UPDATE oauth_tokens SET replaced_at = MIN(COALESCE(replaced_at, ?), ?) WHERE id = ?",
        tx.now - tx.config.oauthRefreshGraceMs,
        tx.now - tx.config.oauthRefreshGraceMs,
        row.parent_id,
      );
    }
    const t = newTokens(tx, grantId);
    insertTokens(tx, grantId, row.id, t);
    const renewed = tx.sql.all<{ id: string }>(
      `UPDATE oauth_grants SET renewed_at = ?, expires_at = ?
       WHERE id = ? AND renewed_at < ? RETURNING id`,
      tx.now,
      tx.now + tx.config.oauthGrantTtlMs,
      grantId,
      tx.now - tx.config.oauthGrantRenewAfterMs,
    ).length;
    return {
      value: t.value,
      audit: { targetType: "oauth_grant", targetId: grantId, detail: { grant_type: "refresh_token", renewed: renewed > 0, retired_siblings: retired } },
    };
  },
};

/**
 * Internal: end a grant for a stated reason (`code_replay`, `refresh_replay`,
 * `client_revoke`). Runs as `system`.
 */
export const oauthGrantEnded: ActionDef = {
  name: "oauth_grant_ended",
  kind: "change",
  run(tx, input) {
    const p = asParams(input);
    const id = reqString(p, "grant", 64);
    const reason = reqString(p, "reason", 64);
    const grant = tx.sql.one<{ handle: string; client_id: string }>("SELECT handle, client_id FROM oauth_grants WHERE id = ?", id);
    if (!grant) throw new BbsError("not_found", "no such grant");
    const { ended } = deleteGrant(tx, id);
    return {
      value: { revoked: id },
      audit: {
        targetType: "oauth_grant",
        targetId: id,
        detail: { reason, handle: grant.handle, client: grant.client_id, sessions_ended: ended.length, ended_sessions: ended },
      },
    };
  },
};

/**
 * The timer set by an approval, due when its code expires (issue #67): a grant
 * that no token was ever issued for is ended, with reason `code_unexchanged`,
 * so an approval the client never completed leaves no live grant and does not
 * count toward `oauthGrantMaxPerHandle`. The agent account stays; the consent
 * page suggests it again (`suggestHandle`) and a later approval reuses it.
 * Outcomes: `ended`, `exchanged` (a token pair exists; nothing to do) and
 * `gone` (the grant already ended).
 */
export const oauthCodeUnused: ActionDef = {
  name: "oauth_code_unused",
  kind: "change",
  run(tx, input) {
    const timerId = optInt(asParams(input), "timer", 1, Number.MAX_SAFE_INTEGER) ?? 0;
    const timer = tx.sql.one<{ ref: string }>("SELECT ref FROM timers WHERE id = ? AND kind = 'oauth_code_unused'", timerId);
    if (!timer) throw new BbsError("not_found", `no code timer ${timerId}`);
    tx.sql.exec("DELETE FROM timers WHERE id = ?", timerId);
    const id = timer.ref;
    const target = { targetType: "oauth_grant", targetId: id };
    const grant = tx.sql.one<{ handle: string; client_id: string }>("SELECT handle, client_id FROM oauth_grants WHERE id = ?", id);
    if (!grant) return { value: { outcome: "gone" }, audit: { ...target, detail: { timer: timerId, outcome: "gone" } } };
    if (tx.sql.one("SELECT 1 AS x FROM oauth_tokens WHERE grant_id = ?", id)) {
      return { value: { outcome: "exchanged" }, audit: { ...target, detail: { timer: timerId, outcome: "exchanged" } } };
    }
    const { ended } = deleteGrant(tx, id);
    return {
      value: { outcome: "ended", revoked: id },
      audit: {
        ...target,
        detail: {
          timer: timerId,
          outcome: "ended",
          reason: "code_unexchanged",
          handle: grant.handle,
          client: grant.client_id,
          sessions_ended: ended.length,
          ended_sessions: ended,
        },
      },
    };
  },
};

// ---------------------------------------------------------------------------
// Listing, revoking, pruning (design §9 steps 9 and 10)

/** `bbs_oauth_grants`: every live connector approval (a read). */
export const oauthGrants: ActionDef = {
  name: "oauth_grants",
  kind: "read",
  run(tx) {
    if (tx.actor.kind !== "human") throw denied("only a person can list connector approvals");
    if (tx.ctx.via !== "cli" && tx.ctx.via !== "web") throw denied("listing connector approvals is not available here");
    const rows = tx.sql.all<{
      id: string;
      client_id: string;
      client_name: string;
      client_host: string;
      handle: string;
      approved_by: string;
      created_at: number;
      last_used_at: number | null;
      expires_at: number;
      client_auth: AuthMethod | null;
    }>(
      `SELECT g.id, g.client_id, g.client_name, g.client_host, g.handle, g.approved_by, g.created_at, g.last_used_at, g.expires_at,
              c.auth_method AS client_auth
       FROM oauth_grants g LEFT JOIN oauth_clients c ON c.client_id = g.client_id
       WHERE g.expires_at > ? ORDER BY g.created_at, g.rowid`,
      tx.now,
    );
    return {
      value: {
        grants: rows.map((r) => ({
          id: r.id,
          client_id: r.client_id,
          client_name: r.client_name,
          client_host: r.client_host,
          client_auth: r.client_auth ?? "none",
          handle: r.handle,
          approved_by: r.approved_by,
          created_at: Number(r.created_at),
          last_used_at: r.last_used_at === null ? null : Number(r.last_used_at),
          expires_at: Number(r.expires_at),
        })),
      },
      audit: { targetType: "user", targetId: tx.actor.handle },
    };
  },
};

/** `bbs_oauth_grant_revoke`: the human admin ends one grant by its id, from the CLI. */
export const oauthGrantRevoke: ActionDef = {
  name: "oauth_grant_revoke",
  kind: "change",
  run(tx, input) {
    requireAdmin(tx, "revoke a connector approval", ["cli"]);
    const id = reqString(asParams(input), "id", 64);
    const grant = tx.sql.one<{ handle: string; client_id: string }>("SELECT handle, client_id FROM oauth_grants WHERE id = ?", id);
    if (!grant) throw new BbsError("not_found", "no such connector approval");
    const { ended } = deleteGrant(tx, id);
    return {
      value: { revoked: id, handle: grant.handle, sessions_ended: ended.length },
      audit: {
        targetType: "oauth_grant",
        targetId: id,
        detail: { reason: "admin_revoke", handle: grant.handle, client: grant.client_id, sessions_ended: ended.length, ended_sessions: ended },
      },
    };
  },
};

/**
 * The prune timer: delete expired requests, codes, grants (with their tokens)
 * stale client copies and spent assertion ids (all of them are already refused when used; this only
 * frees the rows), then run again after `oauthPruneIntervalMs` while any row
 * is left. With none left it stays off until the next request arms it.
 */
export const oauthPrune: ActionDef = {
  name: "oauth_prune",
  kind: "change",
  run(tx) {
    tx.sql.exec("DELETE FROM timers WHERE kind = 'oauth_prune'");
    const requests = tx.sql.all<{ id_hash: string }>("DELETE FROM oauth_requests WHERE expires_at <= ? RETURNING id_hash", tx.now).length;
    const codes = tx.sql.all<{ code_hash: string }>("DELETE FROM oauth_codes WHERE expires_at <= ? RETURNING code_hash", tx.now).length;
    const grantIds = tx.sql.all<{ id: string }>("SELECT id FROM oauth_grants WHERE expires_at <= ?", tx.now).map((r) => r.id);
    const sessionsEnded: string[] = [];
    for (const id of grantIds) sessionsEnded.push(...deleteGrant(tx, id).ended);
    // A client with a live grant keeps its row, whatever its age: it holds the method the token
    // endpoint enforces and the keys it checks, and deleting it would turn a signing client into
    // a public one.
    const clients = tx.sql.all<{ client_id: string }>(
      `DELETE FROM oauth_clients WHERE fetched_at <= ?
         AND NOT EXISTS (SELECT 1 FROM oauth_grants g WHERE g.client_id = oauth_clients.client_id)
       RETURNING client_id`,
      tx.now - tx.config.oauthClientCacheMs,
    ).length;
    const jtis = tx.sql.all<{ jti_hash: string }>("DELETE FROM oauth_client_jtis WHERE expires_at <= ? RETURNING jti_hash", tx.now).length;
    const left = tx.sql.one<{ n: number }>(
      `SELECT (SELECT COUNT(*) FROM oauth_requests) + (SELECT COUNT(*) FROM oauth_codes)
            + (SELECT COUNT(*) FROM oauth_grants) + (SELECT COUNT(*) FROM oauth_clients)
            + (SELECT COUNT(*) FROM oauth_client_jtis) AS n`,
    );
    const rearm = Number(left?.n ?? 0) > 0;
    if (rearm) armPrune(tx);
    const detail = {
      requests,
      codes,
      grants: grantIds.length,
      sessions_ended: sessionsEnded.length,
      ended_sessions: sessionsEnded,
      clients,
      jtis,
      rearmed: rearm,
    };
    return { value: detail, audit: { targetType: "timer", detail } };
  },
};

// ---------------------------------------------------------------------------
// Client authentication: the write side (design §9 "Client authentication")

/**
 * Internal: spend a verified client assertion's `jti`. Runs as `system`; called
 * by `Board.oauthToken` and `Board.oauthRevoke` after `Board.authenticateOAuthClient`
 * checked the signature (asynchronously, before this write). The `jti` is
 * single use: it is inserted with `ON CONFLICT DO NOTHING` and the rows the
 * statement makes are the verdict, so concurrent requests with one assertion
 * cannot both pass. Expired rows of the client are deleted first, and the
 * per-client cap is a condition of the INSERT. A refusal throws and changes
 * nothing.
 */
export const oauthAssertionUse: ActionDef = {
  name: "oauth_assertion_use",
  kind: "change",
  run(tx, input) {
    const p = asParams(input);
    const clientId = reqString(p, "client_id", MAX_URL);
    const jtiHash = reqString(p, "jti_hash", 128);
    const expiresAt = p.expires_at;
    if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt)) throw new BbsError("bad_request", "expires_at must be a number");
    tx.sql.exec("DELETE FROM oauth_client_jtis WHERE client_id = ? AND expires_at <= ?", clientId, tx.now);
    const made = tx.sql.all<{ jti_hash: string }>(
      `INSERT INTO oauth_client_jtis (client_id, jti_hash, expires_at)
       SELECT ?, ?, ?
       WHERE (SELECT COUNT(*) FROM oauth_client_jtis WHERE client_id = ?) < ?
       ON CONFLICT (client_id, jti_hash) DO NOTHING
       RETURNING jti_hash`,
      clientId,
      jtiHash,
      expiresAt,
      clientId,
      tx.config.oauthJtiMaxPerClient,
    );
    if (made.length === 0) throw new BbsError("conflict", JTI_REFUSED, "denied");
    armPrune(tx);
    return {
      value: { used: true },
      audit: {
        targetType: "oauth_client",
        targetId: clientId,
        detail: { client_auth: "private_key_jwt", alg: reqString(p, "alg", 16), kid: optString(p, "kid", 256) ?? null },
      },
    };
  },
};

/** The refusal text of `oauthAssertionUse`, which `Board` maps to `invalid_client`. */
export const JTI_REFUSED = "that client assertion was already used, or the client has used too many";

/**
 * Internal: claim the right to fetch a client's key set again (an assertion
 * named a `kid` the stored set lacks). Runs as `system`. The UPDATE moves
 * `jwks_fetched_at` to now only when it is at least `oauthJwksRefetchMs` old and
 * the client has a `jwks_uri`, and the rows it changes are the verdict, so a
 * client gets at most one refetch per interval however many requests ask. The
 * claim counts even when the fetch then fails.
 */
export const oauthKeyRefetch: ActionDef = {
  name: "oauth_key_refetch",
  kind: "change",
  run(tx, input) {
    const clientId = reqString(asParams(input), "client_id", MAX_URL);
    const rows = tx.sql.all<{ jwks_uri: string }>(
      `UPDATE oauth_clients SET jwks_fetched_at = ?
       WHERE client_id = ? AND auth_method = 'private_key_jwt' AND jwks_uri IS NOT NULL AND jwks_fetched_at <= ?
       RETURNING jwks_uri`,
      tx.now,
      clientId,
      tx.now - tx.config.oauthJwksRefetchMs,
    );
    const row = rows[0];
    if (!row) throw new BbsError("rate_limited", "that client's key set was fetched too recently", "denied");
    return { value: { uri: row.jwks_uri }, audit: { targetType: "oauth_client", targetId: clientId, detail: { claimed: true } } };
  },
};

/**
 * Internal: store a client's key set after the Worker fetched it again.
 * Runs as `system`. The key set goes through the same rules as a document's
 * (`parseKeySet`); only a client that signs and has a `jwks_uri` takes one.
 */
export const oauthKeysStore: ActionDef = {
  name: "oauth_keys_store",
  kind: "change",
  run(tx, input) {
    const p = asParams(input);
    const clientId = reqString(p, "client_id", MAX_URL);
    const set = parseKeySet(p.jwks, tx.config);
    if (!set.ok) throw new BbsError("bad_request", `the client's key set: ${set.reason}`);
    const rows = tx.sql.all<{ client_id: string }>(
      `UPDATE oauth_clients SET jwks = ?, jwks_fetched_at = ?
       WHERE client_id = ? AND auth_method = 'private_key_jwt' AND jwks_uri IS NOT NULL
       RETURNING client_id`,
      JSON.stringify(set.keys),
      tx.now,
      clientId,
    );
    if (rows.length === 0) throw new BbsError("not_found", "no such client with a key set address");
    return { value: { keys: set.keys.length }, audit: { targetType: "oauth_client", targetId: clientId, detail: { keys: set.keys.length } } };
  },
};

/** The stored method, algorithm and keys of a client, for `Board.authenticateOAuthClient`. */
export interface StoredClientAuth {
  method: AuthMethod;
  alg: SigningAlg | null;
  keys: ClientKey[];
  hasJwksUri: boolean;
}

export function storedClientAuth(sql: Sql, clientId: string): StoredClientAuth | undefined {
  const row = sql.one<{ auth_method: AuthMethod; auth_alg: SigningAlg | null; jwks: string | null; jwks_uri: string | null }>(
    "SELECT auth_method, auth_alg, jwks, jwks_uri FROM oauth_clients WHERE client_id = ?",
    clientId,
  );
  if (!row) return undefined;
  const keys = readStoredKeys(row.jwks) ?? [];
  return { method: row.auth_method, alg: row.auth_alg, keys, hasJwksUri: row.jwks_uri !== null };
}

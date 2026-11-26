// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0

/**
 * The Board Durable Object: the only place `core` runs (design §3). One
 * instance, named "board". The Worker calls it by RPC; each method is one
 * synchronous `core` call, so every board write is single-threaded.
 */

import { DurableObject } from "cloudflare:workers";
import { createHash } from "node:crypto";
import {
  Board,
  callToolWithCold,
  DEFAULT_CONFIG,
  exportColdTopics,
  type ColdStore,
  exportAudit,
  type AuditSink,
  validateConfig,
  type AuthResult,
  type CallContext,
  type ErrorCode,
  type OAuthFailure,
  type OAuthTokenParams,
  type OAuthTokenResult,
  type ActResult,
  type RingNotification,
  type Surface,
  type ToolResult,
  type Via,
} from "@bbs-5000/core";
import { DoSql } from "./do-sql.ts";
import { approvalFromEnv } from "./http.ts";
import { R2ColdStore } from "./r2-cold-store.ts";
import { auditSinkFromEnv, MAX_LEASE_MS, MIN_LEASE_MS, spansFromEnv, type AuditEnv } from "./env.ts";
import {
  ALLOW_TEST_FAULTS,
  anySocketFault,
  CLOSE,
  closeReason,
  MAX_SOCKET_MESSAGE,
  messageBytes,
  parseAdapterMessage,
  socketFaultsFromEnv,
  type SocketAttachment,
  type SocketFaults,
} from "./ws-protocol.ts";

/** Internal headers the Worker sets when it forwards an authenticated `/ws` upgrade. */
export const WS_HANDLE_HEADER = "x-bbs-ws-handle";
export const WS_REQUEST_HEADER = "x-bbs-request-id";
/** SHA-256 of the token the upgrade was authenticated with (M4b, B48). */
export const WS_TOKEN_HASH_HEADER = "x-bbs-ws-token-sha256";

export interface Env extends AuditEnv {
  BOARD: DurableObjectNamespace<BoardDO>;
  /** The web view's static files (wrangler.jsonc `assets.binding`); the Worker serves them itself. */
  ASSETS: Fetcher;
  /** Build id `npm run setup` writes into the deploy config; `/health` reports it. Not a secret. */
  BBS_BUILD_ID?: string;
  /** Full commit of the checkout `npm run setup` deployed (`-dirty` after it when tracked files differed); `/health` and `bbs_whoami` report it. Not a secret. */
  BBS_GIT_COMMIT?: string;
  /**
   * `1`: the board requires a passkey's approval for the gated human-only actions
   * (design §12). Written by `npm run setup -- --require-approval`; absent means off.
   * Read once at start; no tool changes it. Not a secret.
   */
  BBS_REQUIRE_APPROVAL?: string;
  /** `1`: a passkey that syncs between devices may approve too (a stopgap; needs `BBS_REQUIRE_APPROVAL`). */
  BBS_APPROVER_ALLOW_SYNCED?: string;
  /** Handle of the static local human admin (spec §4.2, Q1). */
  BBS_HUMAN_HANDLE?: string;
  /** SHA-256 (lowercase hex) of the human credential; never the token itself. */
  BBS_HUMAN_TOKEN_SHA256?: string;
  /**
   * Task lease in milliseconds (design §8; default 2 hours). A tunable,
   * read once at start; the e2e suite sets a short one to watch a lease run
   * out through the real alarm.
   */
  BBS_TASK_LEASE_MS?: string;
  /**
   * Lobby rate window and Lobby mute length in milliseconds (design §10;
   * defaults 10 minutes and 1 hour). Tunables read once at start, with the
   * same bounds as the lease; the e2e suite sets short ones to walk a Lobby
   * flood to a kick.
   */
  BBS_LOBBY_WINDOW_MS?: string;
  BBS_LOBBY_MUTE_MS?: string;
  /** Audit export span and hot period in milliseconds (design §13; e2e shortens them). */
  BBS_AUDIT_EXPORT_INTERVAL_MS?: string;
  BBS_AUDIT_HOT_MS?: string;
  /** Doorbell debounce in milliseconds (design §6; default 5 s). The e2e suite sets a short one. */
  BBS_DOORBELL_DEBOUNCE_MS?: string;
  /** Wake budget window in milliseconds and doorbells per window (design §6; 1 hour, 20). */
  BBS_WAKE_BUDGET_WINDOW_MS?: string;
  BBS_WAKE_BUDGET?: string;
  /** Test only (e2e): see `parseSocketFaults` in ws-protocol.ts. Never set outside tests. */
  BBS_TEST_SOCKET_FAULTS?: string;
  /** Test only: `1` lets `BBS_TEST_SOCKET_FAULTS` take effect (F, B55); otherwise it is refused. */
  BBS_ALLOW_TEST_FAULTS?: string;
  /**
   * Test only (e2e): `1` lets a client metadata document be fetched from a local
   * port over plain http. Honored only for a request that arrived on a loopback
   * hostname (`loopbackClientsAllowed`), so a deployed board ignores it.
   */
  BBS_TEST_OAUTH_LOOPBACK_CLIENTS?: string;
  /**
   * Topic cold storage (M6b, design §14): the R2 binding archived topics are
   * exported to. Local R2 under `wrangler dev`. Unset: topics stay archived.
   */
  COLD?: R2Bucket;
  /** Archive idle span, notice span, scan interval, cold age and cold retry (e2e shortens them). */
  BBS_ARCHIVE_IDLE_MS?: string;
  BBS_ARCHIVE_NOTICE_MS?: string;
  BBS_ARCHIVE_SCAN_MS?: string;
  BBS_COLD_AFTER_MS?: string;
  BBS_COLD_RETRY_MS?: string;
  /** A replaced refresh token's grace in milliseconds (design §9 step 8; default 60 s). The e2e suite shortens it. */
  BBS_OAUTH_REFRESH_GRACE_MS?: string;
  /** Pairs one refresh token may produce (design §9 step 8; default 5). */
  BBS_OAUTH_REFRESH_MAX_SUCCESSORS?: string;
}

/** After an export run, the next one waits at least this long (no alarm loop). */
const EXPORT_MIN_GAP_MS = 1_000;

const sha256 = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

export class BoardDO extends DurableObject<Env> {
  readonly #board: Board;
  /** The alarm time this instance last set (undefined: not yet known). */
  #armed: number | null | undefined;
  /** Where audit batches go (M6a); null: export off, rows stay in SQLite. */
  readonly #sink: AuditSink | null;
  /** Test-only socket faults (e2e); none in normal use. */
  readonly #faults: SocketFaults;
  /** No export run before this time (set after each run). */
  #exportNotBefore = 0;
  /** Where cold topics go (M6b); null: archived topics stay archived. */
  readonly #cold: ColdStore | null;
  /** No cold export run before this time (set after each run). */
  #coldNotBefore = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Test-only faults take effect only with the explicit dev flag (F, B55).
    const faults = socketFaultsFromEnv(env);
    this.#faults = faults.faults;
    if (faults.refused) console.warn(`BBS_TEST_SOCKET_FAULTS refused: test-only; set ${ALLOW_TEST_FAULTS}=1 only in tests`);
    else if (anySocketFault(this.#faults)) console.warn("BBS_TEST_SOCKET_FAULTS is set: test-only socket faults are on");
    const spans = spansFromEnv(env);
    for (const name of spans.ignored) {
      console.warn(
        name === "BBS_WAKE_BUDGET"
          ? `${name} ignored: needs a whole number from 1 to 10000`
          : `${name} ignored: needs an integer from ${MIN_LEASE_MS} to ${MAX_LEASE_MS}`,
      );
    }
    // Overrides that would break the config's own rules (validateConfig) are
    // dropped as a whole, with a warning, rather than failing the board.
    const problem = validateConfig({ ...DEFAULT_CONFIG, ...spans.config });
    if (problem) console.warn(`span overrides ignored: ${problem}`);
    const audit = auditSinkFromEnv(env);
    // Once per start, and only when export was asked for but cannot run.
    if (audit.problem) console.info(audit.problem);
    this.#sink = audit.sink;
    this.#board = new Board({
      sql: new DoSql(ctx.storage),
      now: Date.now,
      sha256,
      config: problem ? {} : spans.config,
      server: { build: env.BBS_BUILD_ID, commit: env.BBS_GIT_COMMIT },
      approval: approvalFromEnv(env),
      // What only this object knows, for bbs_admin_status (G5): its open
      // adapter sockets (hibernated ones included) and whether a sink is set.
      runtime: {
        openSockets: (handle) => this.#openSockets(handle),
        auditExportConfigured: () => this.#sink !== null,
      },
    });
    this.#cold = env.COLD ? new R2ColdStore(env.COLD) : null;
    const handle = env.BBS_HUMAN_HANDLE?.trim();
    const hash = env.BBS_HUMAN_TOKEN_SHA256?.trim().toLowerCase();
    if (handle && hash) {
      // No-op when already current; creation or rotation is audited by core.
      const r = this.#board.bootstrapHuman(handle, hash);
      if (!r.ok) console.error(`human bootstrap refused: ${r.error.code}`);
    } else {
      console.warn("no human credential configured (BBS_HUMAN_HANDLE, BBS_HUMAN_TOKEN_SHA256)");
    }
    // A rotated or retired credential closes sockets bound to it (B48).
    this.#closeRevokedSockets();
    // The archive scan timer (M6b): started once per board, audited; it re-arms itself.
    this.#board.ensureArchiveScan();
    // Timers survive restarts in SQLite; make sure the alarm matches them.
    void ctx.blockConcurrencyWhile(() => this.#syncAlarm());
  }

  /**
   * Keep the one Durable Object alarm at the earliest timer (or none). Only
   * calls storage when the wanted time differs from what this instance last
   * set; a new instance reads the stored alarm first.
   */
  async #syncAlarm(): Promise<void> {
    const want = this.#nextAlarm();
    if (this.#armed === undefined) this.#armed = await this.ctx.storage.getAlarm();
    if (want === this.#armed) return;
    if (want === null) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(want);
    this.#armed = want;
  }

  /** The earliest of the next timer and, with a sink, the next audit export or prune. */
  #nextAlarm(): number | null {
    const timer = this.#board.nextTimerDue();
    const cold = this.#nextColdDue();
    const earliest = (a: number | null, b: number | null): number | null =>
      a === null ? b : b === null ? a : Math.min(a, b);
    if (!this.#sink) return earliest(timer, cold);
    let exp = this.#board.nextAuditExportDue();
    if (exp !== null) exp = Math.max(exp, this.#exportNotBefore);
    return earliest(earliest(timer, exp), cold);
  }

  /** With a cold store, when the next archived topic goes cold (M6b). */
  #nextColdDue(): number | null {
    if (!this.#cold) return null;
    const due = this.#board.nextColdExportDue();
    return due === null ? null : Math.max(due, this.#coldNotBefore);
  }

  /** Move due archived topics to the cold store (M6b); failures are recorded by core and retried. */
  async #exportCold(): Promise<void> {
    if (!this.#cold) return;
    try {
      const run = await exportColdTopics(this.#board, this.#cold);
      for (const f of run.failed) console.warn(`cold export of #${f.topic} failed: ${f.error}`);
    } catch (err) {
      console.error(`cold export error: ${err instanceof Error ? err.message : String(err)}`);
    }
    this.#coldNotBefore = Date.now() + EXPORT_MIN_GAP_MS;
  }

  /** Write due audit batches through the sink (M6a); failures are recorded by core and retried. */
  async #exportAudit(): Promise<void> {
    if (!this.#sink) return;
    try {
      // Notification work (the export-failure notice) is for M2's doorbells.
      const run = await exportAudit(this.#board, this.#sink);
      if (run.failed) console.warn(`audit export of ${run.failed.first}-${run.failed.last} failed: ${run.failed.error}`);
    } catch (err) {
      console.error(`audit export error: ${err instanceof Error ? err.message : String(err)}`);
    }
    this.#exportNotBefore = Date.now() + EXPORT_MIN_GAP_MS;
  }

  /** The alarm: run the due timers (lease checks, Lobby unmutes), then re-arm for the next one. */
  override async alarm(): Promise<void> {
    // The alarm that fired is spent: treat none as set, so the next one is
    // always written (even for the same time, when timers are left over).
    this.#armed = null;
    this.#runTimersAndRing();
    this.#closeRevokedSockets();
    // Failed sign-in windows that ended are written out here too (B5).
    this.#board.flushAuthWindows();
    // A scan timer dropped after a failed run is started again (M6b).
    this.#board.ensureArchiveScan();
    // Audit export last: it awaits the sink.
    await this.#exportAudit();
    await this.#exportCold();
    await this.#syncAlarm();
  }

  /**
   * The alarm's timer step: run the due timers (leases, unmutes, doorbell
   * debounce) and send the doorbells they ring (M2). The only alarm code M2
   * adds, so other alarm work can sit beside it.
   */
  #runTimersAndRing(): void {
    this.#sendRings(this.#board.runDueTimers());
  }

  async authenticate(
    token: string | undefined,
    info: {
      via: Via;
      requestId: string;
      endpoint: string;
      source: string;
      detail?: Record<string, unknown>;
      /** `/mcp` only: also accept a connector's OAuth access token (issue #55). */
      accessToken?: boolean;
    },
  ): Promise<AuthResult> {
    const result = this.#board.authenticate(token, info);
    // A refusal can add audit rows (B44), which may bring the row-count export
    // forward; re-arm the alarm for them, as after a tool call. A valid
    // sign-in writes none of its own. The check is cheap when nothing changed.
    if (!result.ok) await this.#syncAlarm();
    return result;
  }

  /** A browser asks for a web sign-in pairing (issue #47); see `Board.webPairStart`. */
  async webPairStart(info: {
    source: string;
    label: string;
    requestId: string;
  }): Promise<ActResult<{ code: string; poll_secret: string; expires_in_ms: number }>> {
    const result = this.#board.webPairStart(info);
    // The call may have armed the prune timer or added audit rows.
    await this.#syncAlarm();
    return result;
  }

  /** The browser polls its pairing, and an approved one makes its session; see `Board.webPairClaim`. */
  async webPairClaim(info: {
    pollSecret: string | undefined;
    source: string;
    requestId: string;
  }): Promise<ActResult<Record<string, unknown>>> {
    const result = this.#board.webPairClaim(info);
    await this.#syncAlarm();
    return result;
  }

  /** A person in a web session asks to register a passkey (issue #54); see `Board.passkeyRegisterStart`. */
  async passkeyRegisterStart(ctx: CallContext, info: { rpId: string; origin: string; source: string }): Promise<ActResult> {
    const result = this.#board.passkeyRegisterStart(ctx, info);
    // The call may have armed the prune timer or added audit rows.
    await this.#syncAlarm();
    return result;
  }

  /** The browser's registration answer; see `Board.passkeyRegisterFinish`. */
  async passkeyRegisterFinish(
    ctx: CallContext,
    info: { rpId: string; origin: string; credential: unknown; label?: unknown },
  ): Promise<ActResult> {
    const result = await this.#board.passkeyRegisterFinish(ctx, info);
    await this.#syncAlarm();
    return result;
  }

  /** A browser with no session asks to sign in with a passkey; see `Board.passkeySigninStart`. */
  async passkeySigninStart(info: {
    rpId: string;
    origin: string;
    source: string;
    requestId: string;
  }): Promise<ActResult<Record<string, unknown>>> {
    const result = this.#board.passkeySigninStart(info);
    await this.#syncAlarm();
    return result;
  }

  /** The browser's sign-in answer, which makes a web session; see `Board.passkeySigninFinish`. */
  async passkeySigninFinish(info: {
    rpId: string;
    origin: string;
    credential: unknown;
    label: string;
    source: string;
    requestId: string;
  }): Promise<ActResult<Record<string, unknown>>> {
    const result = await this.#board.passkeySigninFinish(info);
    await this.#syncAlarm();
    return result;
  }

  /** A browser opens an approval request (issue #54); see `Board.approvalStart`. */
  async approvalStart(info: {
    approval: string | undefined;
    rpId: string;
    origin: string;
    source: string;
    requestId: string;
  }): Promise<ActResult<Record<string, unknown>>> {
    const result = this.#board.approvalStart(info);
    // A refusal adds an audit row, like a refused sign-in.
    await this.#syncAlarm();
    return result;
  }

  /** The browser's assertion for an approval; see `Board.approvalFinish`. */
  async approvalFinish(info: {
    approval: string | undefined;
    rpId: string;
    origin: string;
    credential: unknown;
    source: string;
    requestId: string;
  }): Promise<ActResult<Record<string, unknown>>> {
    const result = await this.#board.approvalFinish(info);
    await this.#syncAlarm();
    return result;
  }

  /** Resolve a session cookie value to its person; see `Board.authenticateWebSession`. */
  async authenticateWebSession(
    cookie: string,
    info: { requestId: string; endpoint: string; source: string },
  ): Promise<AuthResult> {
    const result = this.#board.authenticateWebSession(cookie, info);
    // A refusal or a renewal adds audit rows, like a refused bearer sign-in.
    await this.#syncAlarm();
    return result;
  }

  /** Whether the board holds a fresh copy of a client's metadata document (issue #55); see `Board.oauthClientFresh`. */
  async oauthClientFresh(clientId: string): Promise<boolean> {
    return this.#board.oauthClientFresh(clientId);
  }

  /** The consent page's first call (issue #55); see `Board.oauthRequest`. */
  async oauthRequest(ctx: CallContext, params: unknown): Promise<ActResult> {
    const result = this.#board.oauthRequest(ctx, params);
    // The call may have armed the prune timer or added audit rows.
    await this.#syncAlarm();
    return result;
  }

  /** The consent page's second call (issue #55); see `Board.oauthDecide`. */
  async oauthDecide(ctx: CallContext, params: unknown): Promise<ActResult> {
    const result = this.#board.oauthDecide(ctx, params);
    await this.#syncAlarm();
    return result;
  }

  /**
   * `POST /oauth/token` (issue #55): authenticate the client (`Board.authenticateOAuthClient`,
   * the one `await`: it verifies a signed assertion), then `Board.oauthToken`, which is synchronous.
   */
  async oauthToken(info: {
    params: OAuthTokenParams;
    resource: string;
    audiences: string[];
    keysRefetched?: boolean;
    source: string;
    requestId: string;
  }): Promise<OAuthTokenResult> {
    const auth = await this.#board.authenticateOAuthClient({
      clientId: info.params.client_id,
      assertionType: info.params.client_assertion_type,
      assertion: info.params.client_assertion,
      audiences: info.audiences,
      endpoint: "/oauth/token",
      keysRefetched: info.keysRefetched,
      source: info.source,
      requestId: info.requestId,
    });
    const result: OAuthTokenResult = auth.ok
      ? this.#board.oauthToken({
          params: info.params,
          resource: info.resource,
          clientAuth: auth.auth,
          source: info.source,
          requestId: info.requestId,
        })
      : auth;
    await this.#syncAlarm();
    return result;
  }

  /** `POST /oauth/revoke` (issue #55): authenticate the client, then `Board.oauthRevoke`. */
  async oauthRevoke(info: {
    token: string | undefined;
    clientId: string | undefined;
    clientAssertionType: string | undefined;
    clientAssertion: string | undefined;
    audiences: string[];
    keysRefetched?: boolean;
    source: string;
    requestId: string;
  }): Promise<{ ok: true } | OAuthFailure> {
    const auth = await this.#board.authenticateOAuthClient({
      clientId: info.clientId,
      assertionType: info.clientAssertionType,
      assertion: info.clientAssertion,
      audiences: info.audiences,
      endpoint: "/oauth/revoke",
      keysRefetched: info.keysRefetched,
      source: info.source,
      requestId: info.requestId,
    });
    const result = auth.ok
      ? this.#board.oauthRevoke({
          token: info.token,
          clientId: info.clientId,
          clientAuth: auth.auth,
          source: info.source,
          requestId: info.requestId,
        })
      : auth;
    await this.#syncAlarm();
    return result;
  }

  /** Whether the Worker may fetch a client's key set again, and from where; see `Board.oauthClaimKeyRefetch`. */
  async oauthClaimKeyRefetch(clientId: string, requestId: string): Promise<string | null> {
    const uri = this.#board.oauthClaimKeyRefetch(clientId, requestId);
    await this.#syncAlarm();
    return uri;
  }

  /** Store a key set the Worker fetched; see `Board.oauthStoreKeys`. */
  async oauthStoreKeys(clientId: string, jwks: unknown, requestId: string): Promise<boolean> {
    const stored = this.#board.oauthStoreKeys(clientId, jwks, requestId);
    await this.#syncAlarm();
    return stored;
  }

  async callTool(
    ctx: CallContext,
    name: string,
    args: unknown,
    surface: Surface,
  ): Promise<ToolResult> {
    // callTool, except that unarchiving a cold topic reads its object first (M6b).
    const result = await callToolWithCold(this.#board, this.#cold, ctx, name, args, surface);
    if (name === "bbs_join" && !result.isError) this.#closeEndedSessions(ctx.handle);
    // A kick (a Lobby flood's follow-up) or a revoked credential closes the
    // user's sockets in this same request (M4b, B48).
    this.#closeRevokedSockets(ctx.requestId);
    // An action may have added, moved or removed a timer (lease, doorbell).
    await this.#syncAlarm();
    return result;
  }

  /**
   * The Worker forwards an authenticated agent's `/ws` upgrade here (it set
   * WS_HANDLE_HEADER after checking the token and kind). The socket is
   * accepted for hibernation, tagged with the handle, and its facts kept in
   * its attachment; everything else lives in SQLite.
   */
  override async fetch(request: Request): Promise<Response> {
    const handle = request.headers.get(WS_HANDLE_HEADER);
    const requestId = request.headers.get(WS_REQUEST_HEADER) ?? crypto.randomUUID();
    const tokenHash = request.headers.get(WS_TOKEN_HASH_HEADER);
    if (!handle || !tokenHash || request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("not found", { status: 404 });
    }
    // The Worker's sign-in and this upgrade are two calls: a kick or a
    // revocation between them refuses the socket here (B48).
    const credential = this.#board.socketCredential(handle, tokenHash);
    const opened =
      credential === "ok"
        ? this.#board.socketAct({ handle, via: "ws", requestId }, "socket_open", {})
        : this.#board.refuse({ handle, via: "ws", requestId }, "socket_open", `credential ${credential}`, {
            credential,
          }, "unauthorized");
    if (!opened.ok) return new Response(JSON.stringify({ ok: false, error: opened.error }), { status: 403 });
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server, [handle]);
    const attachment: SocketAttachment = this.#faults.noHash.has(handle)
      ? { handle, session: null, openedAt: Date.now() }
      : { handle, session: null, openedAt: Date.now(), tokenHash };
    server.serializeAttachment(attachment);
    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const requestId = crypto.randomUUID();
    try {
      this.#onSocketMessage(ws, message, requestId);
    } finally {
      // Every call ends by applying closings, early returns included
      // (orchestrator review n4).
      this.#closeRevokedSockets(requestId);
    }
  }

  #onSocketMessage(ws: WebSocket, message: string | ArrayBuffer, requestId: string): void {
    const att = ws.deserializeAttachment() as SocketAttachment | null;
    if (!att) {
      ws.close(CLOSE.protocol, "no attachment");
      return;
    }
    // A socket the board already closed for its credential takes nothing more.
    if (att.closedBy) return;
    // A socket opened before M4b carries no token hash: refused, so its
    // adapter signs in again (close 4003) and the new socket carries one.
    if (att.tokenHash === undefined) {
      this.#board.refuse({ handle: att.handle, via: "ws", requestId }, "socket_message", "sign in again", {
        no_hash: true,
      }, "unauthorized");
      this.#closeSocket(ws, att, "no_hash", CLOSE.refused, "sign in again");
      return;
    }
    // B48: the credential the socket opened with must still hold, on every
    // message (one primary-key lookup on users).
    const credential = this.#board.socketCredential(att.handle, att.tokenHash);
    if (credential !== "ok") {
      const reason = credential === "kicked" ? "kicked" : "credential_revoked";
      this.#board.refuse({ handle: att.handle, via: "ws", requestId }, "socket_message", `credential ${credential}`, {
        credential,
      }, "unauthorized");
      if (this.#closeForCredential(ws, att, reason)) {
        // Only this socket's session is detached (review m1).
        this.#board.socketsClosed(att.handle, reason, 1, CLOSE.credentialRevoked, requestId, att.session);
      }
      return;
    }
    const tooBig = messageBytes(message) > MAX_SOCKET_MESSAGE;
    const msg = parseAdapterMessage(message);
    if ("error" in msg) {
      // Audited as denied, then closed.
      this.#board.refuse({ handle: att.handle, via: "ws", requestId }, "socket_message", msg.error, {
        endpoint: "/ws",
      }, "bad_request");
      ws.close(tooBig ? CLOSE.tooBig : CLOSE.protocol, closeReason(msg.error));
      return;
    }
    let r: ActResult;
    if (msg.type === "hello") {
      r = this.#board.socketAct({ handle: att.handle, via: "ws", session: msg.session, requestId }, "socket_hello", {
        harness: msg.harness,
        machine: msg.machine,
        state: msg.state,
      });
      if (r.ok) ws.serializeAttachment({ ...att, session: msg.session } satisfies SocketAttachment);
    } else if (att.session === null) {
      r = this.#board.refuse({ handle: att.handle, via: "ws", requestId }, "socket_message", "send hello first", {
        type: msg.type,
      }, "bad_request");
    } else if (msg.type === "state") {
      r = this.#board.socketAct({ handle: att.handle, via: "ws", session: att.session, requestId }, "session_state", {
        state: msg.state,
      });
    } else {
      r = this.#board.socketAct({ handle: att.handle, via: "ws", session: att.session, requestId }, "ring_result", {
        id: msg.id,
        result: msg.result,
        confirmed: msg.confirmed,
      });
    }
    if (!r.ok) {
      const ended = r.error.code === "unauthorized";
      ws.close(ended ? CLOSE.sessionEnded : CLOSE.refused, closeReason(r.error.message));
      return;
    }
    this.#sendRings([r]);
  }

  override async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    this.#socketGone(ws, code);
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code, "closing");
    } catch {
      // Already closed.
    }
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    this.#socketGone(ws, 1006);
  }

  #socketGone(ws: WebSocket, code: number): void {
    const att = ws.deserializeAttachment() as SocketAttachment | null;
    // A socket the board closed for its credential is on the record already
    // (`sockets_closed`); a `socket_close` in a kicked user's name would only
    // be refused.
    // A no-hash socket's close is still the user's own socket_close (its
    // session is detached there).
    if (!att || att.closedBy === "kicked" || att.closedBy === "credential_revoked") return;
    const stillOpen =
      att.session !== null &&
      this.ctx.getWebSockets(att.handle).some((other) => {
        if (other === ws || other.readyState !== WebSocket.OPEN) return false;
        return (other.deserializeAttachment() as SocketAttachment | null)?.session === att.session;
      });
    this.#board.socketAct({ handle: att.handle, via: "ws", requestId: crypto.randomUUID() }, "socket_close", {
      session: att.session,
      code,
      still_open: stillOpen,
    });
  }

  /**
   * Send each ring as `{"type":"doorbell","id","text"}` (spec §4.3) on the
   * sockets attached to its session. With none open, `core` is told so the
   * doorbell rings at the next attach.
   */
  #sendRings(results: readonly ActResult[]): void {
    const rings = results.flatMap((r) => r.notifications.filter((n): n is RingNotification => n.type === "ring"));
    for (const ring of rings) {
      const frame = JSON.stringify({ type: "doorbell", id: ring.id, text: ring.text });
      let sent = 0;
      for (const ws of this.#socketsOf(ring.recipient)) {
        const att = ws.deserializeAttachment() as SocketAttachment | null;
        if (att?.session !== ring.session || ws.readyState !== WebSocket.OPEN) continue;
        try {
          ws.send(frame);
          sent += 1;
        } catch {
          // Counted as not sent.
        }
      }
      if (sent === 0) this.#board.ringUndeliverable(ring.recipient, ring.id, ring.session);
    }
  }

  /**
   * After a `bbs_join` that replaced the caller's session, close that
   * user's adapter sockets whose session ended (code 4001: do not reconnect
   * with it). Sockets are looked up by the handle tag, which M4b reuses to
   * close a kicked user's socket.
   */
  #closeEndedSessions(handle: string): void {
    for (const ws of this.ctx.getWebSockets(handle)) {
      const att = ws.deserializeAttachment() as SocketAttachment | null;
      if (att?.session && !this.#board.sessionLive(att.session)) {
        try {
          ws.close(CLOSE.sessionEnded, "session replaced by a later bbs_join");
        } catch {
          // Already closed.
        }
      }
    }
  }

  /**
   * Close the adapter sockets of every user a committed call kicked or whose
   * credential it revoked (M4b, B48), taken from `core` after the call: a
   * `{"type":"kicked","reason"}` frame first for a kick, then close 4004.
   * Each closing of one or more sockets is audited (`sockets_closed`).
   */
  #closeRevokedSockets(requestId?: string): void {
    for (const d of this.#board.takeDisconnects()) {
      let closed = 0;
      // Test only: a kick leaves the sockets open (see parseSocketFaults).
      if (d.reason === "kicked" && this.#faults.keepKicked) continue;
      for (const ws of this.#socketsOf(d.handle)) {
        const att = ws.deserializeAttachment() as SocketAttachment | null;
        if (!att || att.closedBy) continue;
        if (this.#closeForCredential(ws, att, d.reason)) closed += 1;
      }
      // No open socket, nothing closed: the kick or revocation's own row says enough.
      if (closed > 0) this.#board.socketsClosed(d.handle, d.reason, closed, CLOSE.credentialRevoked, requestId);
    }
  }

  /** Tell a kicked adapter why, and close with 4004; marked closed by the board only when the close went through. */
  #closeForCredential(ws: WebSocket, att: SocketAttachment, reason: "kicked" | "credential_revoked"): boolean {
    if (reason === "kicked") {
      try {
        ws.send(JSON.stringify({ type: "kicked", reason: "removed from the board by the auto-administrator" }));
      } catch {
        // Closing anyway.
      }
    }
    return this.#closeSocket(
      ws,
      att,
      reason,
      CLOSE.credentialRevoked,
      reason === "kicked" ? "kicked: token revoked" : "credential revoked or replaced",
    );
  }

  /**
   * Close a socket for the board's own reason and mark it (`closedBy`) so its
   * close is not audited again as the user's `socket_close` (review n2, n3:
   * marked only after the close went through).
   */
  #closeSocket(ws: WebSocket, att: SocketAttachment, by: NonNullable<SocketAttachment["closedBy"]>, code: number, text: string): boolean {
    try {
      ws.close(code, text);
    } catch {
      // Already closed.
      return false;
    }
    try {
      ws.serializeAttachment({ ...att, closedBy: by } satisfies SocketAttachment);
    } catch {
      // A closed socket may refuse it; its close is then recorded as socket_close.
    }
    return true;
  }

  /**
   * The adapter sockets that belong to `handle`. A socket is tagged with the
   * handle of the token it signed in with, and says which session it serves at
   * its `hello`. A session handle (issue #98) has no token, so its sockets are
   * its parent's whose session is its own; any other handle gets every socket
   * under its tag, those of its session handles included (a kick or a revoked
   * token closes them all).
   */
  #socketsOf(handle: string): WebSocket[] {
    const parent = this.#board.parentOf(handle);
    if (parent === undefined) return this.ctx.getWebSockets(handle);
    return this.ctx.getWebSockets(parent).filter((ws) => {
      const att = ws.deserializeAttachment() as SocketAttachment | null;
      return att?.session != null && this.#board.sessionOwner(att.session) === handle;
    });
  }

  /** Adapter sockets open for a handle that the board has not closed itself (G5 admin status). */
  #openSockets(handle: string): number {
    let n = 0;
    for (const ws of this.#socketsOf(handle)) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      const att = ws.deserializeAttachment() as SocketAttachment | null;
      if (!att || att.closedBy) continue;
      // A token's own count leaves out the sockets its session handles' sessions hold.
      if (att.session !== null && this.#board.sessionOwner(att.session) !== handle) continue;
      n += 1;
    }
    return n;
  }

  /** Refuse a request without running it; audited as `denied`. */
  refuse(
    ctx: CallContext,
    action: string,
    reason: string,
    detail: Record<string, unknown>,
    code: ErrorCode = "forbidden",
  ): { code: string; message: string } {
    const r = this.#board.refuse(ctx, action, reason, detail, code);
    return r.ok
      ? { code: "internal", message: "refusal did not refuse" }
      : { code: r.error.code, message: r.error.message };
  }
}

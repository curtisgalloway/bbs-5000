<!--
SPDX-FileCopyrightText: 2026 Curtis Galloway
SPDX-License-Identifier: Apache-2.0
-->

# Instructions for agents working on BBS-5000

This project was developed in a private repository before publication. Code comments and
documents refer to that tracker: `issue #N` with N up to 116, and labels such as `B26`,
`M6a` or `G4`. Those numbers are not this repository's issue numbers.
`docs/issue-numbers.md` maps the ones that are still open; the rest are closed history.

## Start here

- The design ([docs/BBS-5000-design.md](docs/BBS-5000-design.md)) is the source of truth
  for behavior; the build spec ([docs/BBS-5000-build-spec.md](docs/BBS-5000-build-spec.md))
  says what v1 builds. If they disagree, stop and ask.
- Current obligations are the GitHub issues labeled `backlog`.
- When a change settles a design question, record it in the design document next to the
  behavior it changes, with the date and who decided.

## This repository is public

Never commit host names, LAN addresses, home-directory paths, usernames, tokens or other
private details, in code, docs, tests, fixtures or commit messages. Use role names
("workstation-1", "the dev machine") and example names (`example.com`,
`app.example.com`). Grep a diff for these before committing.

## Working conventions

- **Branches and pull requests.** One branch per change, named for it (for example
  `fix-lease-renewal`), landed as one pull request into `main`. Merge style: merge commit.
  Never merge on red CI. Several agents working at once each use their own `git worktree`
  (under `.worktrees/`, which is gitignored), never the same checkout.
- **Commits.** Detailed messages that say what changed and why, and any notable
  decision. Use your GitHub noreply address as the author email. Stage files by name
  (never `git add -A`) and check `git status` for files you did not touch.
- **Review.** Review before the change is final, with fixes landing before the last
  commit: an independent reviewer (a person, or a fresh agent that did not write the
  change) reads the diff and the checks below, and its findings are answered in the pull
  request. Tests that pin a behavior change with it; do not loosen a guard test to make a
  change pass, fix the change.
- **Runs locally; deploys are the maintainers'.** Development and every test run under
  `wrangler dev` or plain Node, with no Cloudflare account. This repository's maintainers
  deploy their own board. Never deploy from a pull request, and never run
  `wrangler login`. [docs/deploy.md](docs/deploy.md) describes deploying your own copy.
- **Architecture decisions that still hold.** `core` defines one small synchronous `Sql`
  interface (`exec`, `one`, `all`, `transaction`) with two implementations, the Durable
  Object's `ctx.storage.sql` and Node's built-in `node:sqlite` for unit tests; it takes an
  injected clock and an injected synchronous SHA-256 function (a Durable Object
  transaction is synchronous, so the hash cannot be `crypto.subtle`). The audit hash chain
  is written with every audit row, from the first. The `bbs_*` tool set is defined once in
  `core` (name, input schema, handler that calls `act`); `/mcp`, `/api` and the CLI are
  thin mappings of it, so add a tool there, never in one front end. The adapter is the
  stdio MCP server Claude Code starts, and its tools proxy to `/api` with the agent's token.

## Checks

```bash
npm ci
npm run typecheck   # TypeScript strict, no emit
npm test            # vitest, plain Node, in-memory node:sqlite
npm run test:e2e    # wrangler dev for real (test/e2e/harness.ts); about 4 minutes
# Browser check of the web view (CI runs it; playwright-core + installed Chrome):
# BROWSER_CHANNEL=chrome node scripts/web-check.mjs   (screenshots go to .web-check/)
```

CI (`.github/workflows/ci.yml`) runs typecheck and unit tests on Node 22 and 24, and the
e2e suite on Node 24.

## Code rules

- `packages/core` imports nothing from Cloudflare, `wrangler` or Node (the one exception
  is `src/node-sqlite.ts`, the test-side SQL handle). A test enforces this.
- Every board write goes through `Board.act` (or its internal paths `authenticate`,
  `bootstrapHuman` and `refuse`), which writes the audit row in the same transaction;
  `migrate` writes only the schema, `meta` rows, the Lobby and `#admin-log`. Actions never open
  transactions or call `act`. A guard test enforces this, and allows an unaudited
  transaction to write nothing but `users.last_seen`, the actor's task-lease renewal
  (`tasks.lease_expires_at`, design §8) and a connector call's bookkeeping (see the OAuth rule below). Timers run through `Board.runDueTimers`, as
  the `system` actor inside `act`, each with its own audit row. An action that needs a
  system change after it (the auto-administrator's warning, mute, kick or circuit
  breaker) returns or throws a `FollowUp`; `act` runs it afterwards, in its own
  transaction with its own audit row and the call's `request_id`. Thresholds live in
  `BoardConfig` only.
- A new topic is announced in the Lobby by the board itself (`actions/topic-announce.ts`): the first one inside `topic_create`'s own transaction as a `system` message, the rest by the `topic_announce` timer through `Board.runDueTimers`; whether it is the first is the conditional INSERT of the window's timer row, judged by rows changed, and `topics.announce_pending` marks the rest. Its window and list length are in `BoardConfig`.
- Short labels (handle, role, harness, machine, os, model) go through `optLabel`/`reqLabel`, which
  refuse control, line-separator and bidirectional characters. A handle a caller gives is matched without regard to case (ASCII fold): resolve it once with `canonicalHandle` or `resolveHandle` (`actions/common.ts`) and use the stored spelling after that; a new account's uniqueness is the INSERT's own condition (`insertUserOnce`), never a lookup first. The connector consent decision is the exception: it refuses a case variant of an existing agent and names the stored spelling, so the person and the signed scope name the exact agent.
- Every SQL statement uses `?` parameters; never interpolate values into SQL text.
- Tokens are never stored or logged; only their SHA-256.
- `core` runs only inside the Board Durable Object; the Worker authenticates through it,
  derives `via` from the endpoint and the caller's kind, and forwards one tool call at a
  time. Real secrets go in `packages/worker/.dev.vars` (gitignored), never in git.
- Message bodies leave the board only wrapped as peer content (`src/peer.ts`).
- The web view (`packages/web/public`) renders user text only as text nodes or
  `setAttribute` values (`render.js`): no `innerHTML`, `outerHTML`,
  `insertAdjacentHTML`, `document.write` or `eval`; nothing loaded from another origin;
  no inline script or style (the `_headers` Content-Security-Policy forbids them); the
  session is an HttpOnly cookie, and the page keeps no credential in any web storage
  (`sessionStorage`, `localStorage`), the address or a cookie it can read; status as text
  and shape, never color alone; no sound. A unit test scans for these.
- A person signs in to the web view by pairing code (`web-session.ts`): the board stores
  only SHA-256 of the code, the poll secret and the cookie value. `bbs_web_pairing_show`,
  `bbs_web_pairing_approve`, `bbs_web_session_revoke` are for a person via `cli` only, never on
  `/mcp`; `via = web` comes only from a session cookie (never from `x-bbs-client`), and the
  Worker reads that cookie on the web host only, for a same-origin `POST`. The web host's
  unauthenticated endpoints are `/api/web/pair/start`, `/api/web/pair/claim` and
  `/api/web/session` (404 on the API host); a renewal re-sends the cookie with the full lifetime. Pairing starts
  and claims are limited inside the write, and their refusals go through the failed
  sign-in guards, never a row per request.
- A person can also sign in to the web view with a passkey (`actions/passkey.ts`, the checks in
  `actions/passkey-verify.ts`, Web Crypto only, ES256 and RS256; attestation statements are never
  verified). The Worker derives the relying party id (the web view's exact hostname) and the
  expected origin from the request and passes them in; the page never sends them, and the four
  endpoints (`/api/web/passkey/register/{start,finish}` with the session cookie,
  `/api/web/passkey/signin/{start,finish}` with none) are the web host's alone. Only a web session
  made by a pairing code (`web_sessions.method`) may register a passkey, and removing the last one
  is `via = cli` only. A passkey sign-in records its passkey on the session (`web_sessions.passkey`),
  and removing a passkey deletes those sessions in the same transaction. Revoking a person's
  credential (`retireOtherAdmins`, the kick path, a rotation of the person's own token) also calls `revokePasskeys` beside
  `revokeWebSessions`, since the account stays `active`. Challenges are single use, stored as SHA-256 only, and every limit and
  one-shot rule (pending caps, spending a challenge, `passkeysPerUser`, a credential id's
  uniqueness, the sign count's rule, the last-passkey rule) is a condition of its write judged by
  the rows changed. The checks that need Web Crypto are the one `await`, reads only
  (`Board.passkeySigninFinish`, `Board.passkeyRegisterFinish`), with no `await` before the
  synchronous write; a passkey sign-in makes its session through `createWebSession`, the code a
  pairing claim uses. Refusals at the two unauthenticated endpoints go through the failed sign-in
  guards, never a row each. Tokens, challenges, keys and signatures never reach an audit row;
  `bbs_passkeys` and `bbs_passkey_remove` are never on `/mcp`.
- A board deployed with approval required (`BBS_REQUIRE_APPROVAL=1`, from `--require-approval`; `BBS_APPROVER_ALLOW_SYNCED` lets synced passkeys approve; both passed once into `BoardOptions.approval`, never changed by a tool) gates three human-only actions behind a passkey (`actions/approval.ts`, `approval-finish.ts`, design §12): `web_pairing_approve`, the web `oauth_decide` with an approve decision, and `passkey_remove` of a passkey that can approve. `admin_*` is not gated. A gated action validates as it always did, then calls `requestApproval` and answers `approval_required` instead of changing anything; the change is one function that both the ungated path and the approved path call (`approvePairing`, `oauthApprove`, `removePasskey`). The scope is built by the board, never the client, with a fixed key order, and the challenge is `SHA-256(scope || "\n" || nonce)` recomputed from the stored row (the nonce is stored in clear on purpose); the secret approval id is stored only as its SHA-256, and a pairing's browser gets a second id derived from its poll secret (`pollApprovalId`; only `web_pairings.approval_hash` is stored). Only a device-bound passkey (BE flag 0, stored and asserted) of the request's own active human, with user verification, approves, unless the stopgap is on, and never one registered while approval was required (`passkeys.approver_barred`, set by `passkey_register`); `APPROVER_CONDITION` and `mayApprove` in `approval.ts` are the one rule every check uses, so a new check must use them. Adding or replacing an approver key means redeploying with approval off, registering, and turning it on again; with none, a gated action is refused (fail closed), never run unapproved. `Board.approvalFinish` makes its Web Crypto checks in the one `await` (`checkApproval`, reads only), then one synchronous write (`approvalFinish` action, under the gated action's own audit name) spends the request, moves the sign count and runs the change, each judged by the rows changed, so two finishes make one success and a change that can no longer run spends nothing. The per-person cap is a condition of the INSERT, and a new request for the same action and target replaces the older one. The request is audited as `approval_request` (public id, action, scope), the change under its own name with `approval` and `passkey` in the detail; never the secret id, the nonce or the challenge. Refusals at `/api/web/approval/start` and `/finish` (web host only, no cookie, 404 on the API host) go through the failed sign-in guards, never a row per request. `bbs_approval_status` (cli or web, never on `/mcp`) answers only pending, approved or expired, never the result. A connector's `approval_required` answer carries no `url` (the standalone page cannot follow the redirect), and `oauthApprove` refuses when the client's name no longer matches the signed scope.
- The approving pages (issue #54, `approval.js`, `approve.html`/`approve.js` at `/approve`, no web session needed): the secret approval id lives in a variable and a request body only; `approve.js` reads it from the address fragment and removes it with `history.replaceState` at once (the one script allowed to touch the address), and no other script reads `location.hash` for it. The panel sets every scope value (a browser label, a client name) as text nodes, shows the match code and the time left as text, has no Decline button, and uses the credential helpers of `webauthn.js` shared with `passkey.js`. The same web view rules above apply to it.
- A remote connector (a claude.ai or ChatGPT client) signs in to `/mcp` with OAuth, built
  into the board (`actions/oauth.ts`); the Worker is only the HTTP layer and the fetcher of
  the client's metadata document, and `core` never fetches. The board stores only SHA-256 of
  the pending request's id, codes, and access and refresh tokens. A grant is one approval of
  one agent handle; only the human admin approves, through the web view's two calls
  (`/api/web/oauth/request`, `/api/web/oauth/decide`, web host only, session cookie, same-origin
  `POST`) from the consent page (`oauth/authorize.html` and `authorize.js` beside the main page, sharing `signin.js`, and offering the main page's passkey sign-in through `passkey.js`, which shares its credential helpers with `approval.js` through `webauthn.js`; the same web view rules apply: text nodes only, no form, no web storage, `location.assign` to the board's address). `bbs_oauth_grants` and `bbs_oauth_grant_revoke` are never on `/mcp`. An access token
  is accepted on `/mcp` only (`Board.authenticate` with `accessToken`), runs as the agent with
  `via = mcp`, and every audit row of its calls carries the grant's id (`CallContext.oauthGrant`).
  Every limit and one-shot rule (pending requests, grants per handle, a code, a request's
  decision, a refresh rotation) is a condition of its write, judged by the rows changed; an approval whose code expires unexchanged is ended by its `oauth_code_unused` timer (reason `code_unexchanged`); a
  second use of a code or a replay of a refresh token replaced longer ago than the grace ends the grant, and refusals at
  `/oauth/token` and `/oauth/revoke` go through the failed sign-in guards. The only writes
  allowed in an unaudited transaction beside `users.last_seen` is the grant's `last_used_at`.
  A refresh token stays usable for `oauthRefreshGraceMs` after it is first presented, for at
  most `oauthRefreshMaxSuccessors` pairs; the first refresh of one of those pairs retires its
  siblings and closes the token they came from (so a stolen token used inside the grace cannot keep a second line), and a later use
  of a replaced token is a replay. The token-row cap never deletes an unreplaced row. The e2e harness may serve a client document
  over plain http from a local port (`BBS_TEST_OAUTH_LOOPBACK_CLIENTS`), honored only for a
  request that arrived on a loopback hostname.
- Times in tool results are ISO 8601 UTC text (`new Date(ms).toISOString()`), converted at one
  point, `toToolResult` in `packages/core/src/tools.ts`, through `isoTimes` in `iso-times.ts`;
  nothing else converts one. Storage, audit rows and `detail`, the hash chain, archives, timers
  and socket frames keep epoch milliseconds. A number is converted only under a key ending `_at`
  or on that file's list (`ACTION_TIME_KEYS` for a key that is a time in one tool only); durations
  (`*_ms`) and sequence numbers are never converted. A new time field in a result needs its key
  there, and the guard test in `packages/core/test/iso-times.test.ts` fails on one that is missed.
  A tool input that is a time goes through `optTime` (milliseconds or ISO text).
- A client whose document asks for `private_key_jwt` signs every `/oauth/token` and
  `/oauth/revoke` request with an RS256 or ES256 assertion (`actions/client-auth.ts`). The
  Worker only fetches the key set (`jwks_uri`, same host as the `client_id`, the document's fetch
  rules) and passes the form fields through; every rule and the signature check live in
  `core` (`Board.authenticateOAuthClient`, the one `await`, before the synchronous write, using
  Web Crypto and no Node import). The assertion's `jti` is single use as a condition of the
  write (`oauth_assertion_use`: `INSERT ... ON CONFLICT DO NOTHING` under a per-client cap,
  judged by rows changed), and a refetch of the key set after an unknown `kid` is claimed by
  an UPDATE on its fetch time. A failed assertion is `invalid_client`, goes through the failed
  sign-in guards and never ends a grant. The assertion, keys and tokens are never logged;
  the client row of a client with a live grant is never pruned, so its method keeps being enforced.
- A connector handle holds one board session per chat, named by the optional `session` argument of every tool on `/mcp` (the id `bbs_join` returned; never in the CLI or `/api` definitions, `mcpTools()` adds it). `callTool` takes it off the arguments into `ctx.sessionArg` before any action sees them; `act` (`#bindMcpSession`) honors it only with `ctx.oauthGrant`, for an agent with no session of its own, when it names one of the handle's live `via_grant` sessions, and ignores any other value without an error. It wins over the `Mcp-Session-Id` hash (the Worker still assigns one at `initialize`; the board stores only its SHA-256 in `sessions.mcp_session_hash`). A grant join that is not bound adds a session and ends none; every other join replaces all as before. `connectorSessionsMaxPerHandle` counts every live `via_grant` session and is a condition of the INSERT, judged by rows changed; the `connector_idle` timer (a system action through `runDueTimers`) ends idle ones from the audit table, with no new unaudited write. Ending a grant, by any route (`deleteGrant`), ends the sessions joined through it (`sessions.grant_id`) in the same transaction, and, when the handle has no grant left, its live pre-version-18 connector sessions with no `grant_id`. `bbs_who` lists `sessions` and never a session id or hash.
- A session handle (issue #98, design §4) is an agent user with `users.parent`, the agent whose static token it was made under, and a `harness_session` unique per parent; `bbs_join` under an agent's token with a `harness_session` (no session of its own to update, not a connector) finds or makes it (`actions/session-handles.ts`, `resolveSessionHandle`) and everything after that line of the join is the handle's, so its audit row names it as actor (`AuditTarget.actor`). It has no token, no `coordinator` or `admin` flag (the column's CHECK and the actions' refusals; `admin_coordinator_grant`, `admin_reinstate` and a connector approval refuse it), and only an agent with no parent can be a parent. `Board.#bindSessionHandle` is the one place a call becomes the session handle's: the token authenticated agent P, the call names a session of a user whose `parent` is P, and `ctx.oauthGrant` is not set; any other session stays the caller's and is refused by `#checkCaller` with the one message every foreign or unknown session gets. Every audit row of its calls carries `parent` in its detail (like `grant`). Its name is a condition of the INSERT (case-insensitive, retried on a clash), `sessionHandlesMaxPerParent` counts the non-retired ones as a condition of the same INSERT and of the UPDATE that revives a retired one; `admin_session_handle_retire` (human admin, never `/mcp`) frees a place now; `admin_reinstate` refuses a session handle, and only `/api` joins make one, and the join rate limit counts per parent. Sanctions and limits follow the token: the Lobby limit, the offenses and their steps (`admin_events`), the mute and the kick are counted and applied per `parent ?? handle` (`tokenHandle`, `checkLobbyPost`; an offense a session handle earns is recorded against, and its mute or kick lands on, the token handle, and a muted token's status is read for every session handle under it), and the join limit counts per token; what stays per session handle (wake budget, breaker, subscription and notice caps, socket window) is listed in design §4. A kick of the parent ends them all in the same transaction (`endSessionHandles`; their `harness_session` is cleared and reinstating does not bring them back); the `session_handle_retire` timer retires an idle one (`users.retired_at`, read as status `retired` through `userStatusSql`; its tasks go stale through `staleHeldTasks`), and a join with the same harness session brings it back. The adapter's sockets are tagged with the parent's handle: a Durable Object that looks up a handle's sockets goes through `#socketsOf`, which finds a session handle's under its parent's tag by the session each socket attached. `bbs_who` shows `parent` and still no session id or hash. Ending a session clears its `ws_open`, a socket close detaches a session owned by the token or its session handles, and the refusals that tell a client to join again end with `SESSION_ENDED_MARKER`. A session handle's reported status is effective (`userStatusSql`: retired, or muted while its token is). Review of a task (`requireNotOwnReview`) compares tokens.
- `kind` is fixed when an account is made; no action changes it. Only a human admin
  runs `admin_*` actions, and their tools are never offered on `/mcp`.
- Every source file starts with the two-line SPDX header (`SPDX-FileCopyrightText: 2026
  Curtis Galloway`, `SPDX-License-Identifier: Apache-2.0`) in its own comment syntax.
- TypeScript strict; American spelling in prose and identifiers.

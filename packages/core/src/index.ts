// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0

/**
 * @bbs-5000/core: board logic in plain TypeScript. Takes a SQL handle, a
 * clock and a SHA-256 function; imports nothing from Cloudflare or Node.
 * The `node:sqlite` implementation is a separate entry point
 * (`@bbs-5000/core/node-sqlite`).
 */

export {
  Board,
  MAX_TIMERS_PER_RUN,
  MAX_TOKEN_LENGTH,
  PUBLIC_ACTIONS,
  SOCKET_ACTIONS,
  type AuthResult,
  type OAuthClientAuth,
  type OAuthClientAuthResult,
  type OAuthErrorCode,
  type OAuthFailure,
  type OAuthTokenParams,
  type OAuthTokenResult,
  type PublicAction,
} from "./act.ts";
export { checkClientIdUrl, checkJwksUri, OAUTH_SCOPE, type TokenValue, type UrlCheck } from "./actions/oauth.ts";
export { TASK_STATES, type TaskState } from "./actions/tasks.ts";
export {
  AUDIT_FIELDS,
  canonicalAuditJson,
  chainValueAfter,
  GENESIS_HASH,
  verifyChain,
  type AuditResult,
  type AuditRow,
  type ChainCheck,
  type Sha256,
} from "./audit.ts";
export {
  AUDIT_PREFIX,
  batchLine,
  batchBoardId,
  batchPath,
  BOARD_ID_RE,
  buildBatch,
  exportAudit,
  MAX_BATCHES_PER_RUN,
  parseBatch,
  verifyAuditArchive,
  type ArchiveCheck,
  type AuditBatch,
  type AuditExporter,
  type AuditSink,
  type ExportRun,
  type ParsedBatch,
} from "./audit-export.ts";
export {
  callToolWithCold,
  ColdConflictError,
  exportColdTopics,
  MAX_COLD_PER_RUN,
  MemoryColdStore,
  type ColdExporter,
  type ColdJob,
  type ColdRun,
  type ColdStore,
} from "./cold.ts";
export {
  COLD_FORMAT,
  COLD_PREFIX,
  coldKey,
  parseColdBody,
  utf8Bytes,
  type ColdContent,
  type ColdCounts,
} from "./cold-object.ts";
export { GcsSink, gcsSinkFromServiceAccount, GCS_TIMEOUT_MS, type GcsSinkOptions } from "./gcs-sink.ts";
export type { ChainState } from "./actions/audit-export.ts";
export { RING_RESULTS, type RingResult } from "./actions/wake.ts";
export { doorbellText, type DoorbellSummary } from "./notify.ts";
export { AGENT_GUIDE, NO_WORK_IN_LOBBY, TOPIC_RULE } from "./agent-guide.ts";
export { PEER_CONTENT_NOTICE, wrapMessage, type PeerMessage } from "./peer.ts";
export { migrate, SCHEMA_VERSION } from "./schema.ts";
export type { Row, Sql, SqlValue } from "./sql.ts";
export {
  callTool,
  mcpTools,
  findTool,
  TOOLS,
  type Surface,
  type ToolDef,
  type ToolResult,
} from "./tools.ts";
export {
  BbsError,
  DEFAULT_CONFIG,
  SESSION_ENDED_MARKER,
  validateConfig,
  VIAS,
  VIAS_BY_KIND,
  type ActResult,
  type Actor,
  type AdminNoticeReason,
  type AdminNotification,
  type BoardConfig,
  type BoardOptions,
  type CallContext,
  type DisconnectNotification,
  type ErrorCode,
  type MessageNotification,
  type NotificationWork,
  type RingNotification,
  type RuntimeFacts,
  type ServerInfo,
  type TaskNoticeReason,
  type TaskNotification,
  type UserKind,
  type Via,
} from "./types.ts";
export { ASSERTION_TYPE } from "./actions/client-auth.ts";

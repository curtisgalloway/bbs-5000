// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0

/**
 * The `bbs_*` tools every ring's stdio MCP server serves, proxied to the
 * board's `/api` with the agent token (plan decision P6). Shared by the
 * Claude ring and the Codex ring (G3); each ring builds its own `Server`
 * (its own capabilities and instructions) and registers these handlers on it.
 */

import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { SESSION_ENDED_MARKER, TOOLS } from "@bbs-5000/core";
import type { BoardApi } from "./board-api.ts";

/** Tools the adapter serves: the ones offered on `/mcp` (no admin tools). */
export const ADAPTER_TOOLS = TOOLS.filter((t) => t.surfaces.includes("mcp")).map((t) => ({
  name: t.name,
  description: t.description,
  inputSchema: t.inputSchema as { type: "object"; properties?: Record<string, unknown> },
}));

export interface ToolServeOptions {
  api: BoardApi;
  /** The adapter's board session, sent with every proxied call. */
  session(): string | undefined;
  log(event: string, detail?: Record<string, unknown>): void;
  /**
   * Before each proxied tool call: make sure there is a live session (join
   * fresh when the board replaced it, and attach again). Review M1.
   */
  prepareCall?: () => Promise<void>;
  /** The board said this session has ended: forget it (the call is retried once after `prepareCall`). */
  sessionEnded?: () => void;
  /** Called with the request's `_meta` before each call (the Codex ring reads its thread id there). */
  onCallMeta?: (meta: Record<string, unknown> | undefined) => void;
}

/** Register `tools/list` and `tools/call` on `server`. */
export function serveBbsTools(server: Server, o: ToolServeOptions): void {
  const call = async (name: string, args: unknown) => {
    try {
      await o.prepareCall?.();
    } catch {
      // The call below reports the board's answer (or that it is unreachable).
    }
    return o.api.tool(name, args, o.session());
  };
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: ADAPTER_TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    o.onCallMeta?.(req.params._meta as Record<string, unknown> | undefined);
    const name = req.params.name;
    const known = ADAPTER_TOOLS.some((t) => t.name === name);
    if (!known) {
      return { isError: true, content: [{ type: "text" as const, text: `Error (unknown_action): no tool ${name}` }] };
    }
    const args = req.params.arguments ?? {};
    let r = await call(name, args);
    if (sessionEnded(r) && o.sessionEnded) {
      // The board replaced the session between our last look and this call.
      o.sessionEnded();
      r = await call(name, args);
    }
    o.log("tool", { name, ok: !r.isError, ...toolFacts(name, r.structuredContent) });
    return r;
  });
}

/**
 * Whether a tool result is the board refusing an ended session (B19) or a call as a
 * retired session handle (issue #98): the shared marker, not the wording. Both are
 * answered by joining again.
 */
function sessionEnded(r: { isError: boolean; structuredContent?: Record<string, unknown> }): boolean {
  const e = r.structuredContent?.error as { code?: unknown; message?: unknown } | undefined;
  return r.isError && e?.code === "unauthorized" && typeof e.message === "string" && e.message.includes(SESSION_ENDED_MARKER);
}

/** Facts about a tool result for the adapter's log: ids and counts, never text. */
function toolFacts(name: string, value: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!value || name !== "bbs_inbox") return {};
  const seqs = (list: unknown): number[] =>
    Array.isArray(list) ? list.map((m) => Number((m as { seq?: unknown }).seq)).filter(Number.isFinite) : [];
  return {
    wake_seqs: seqs(value.wake),
    digest_seqs: seqs(value.digest),
    notices: Array.isArray(value.notices) ? value.notices.length : 0,
  };
}

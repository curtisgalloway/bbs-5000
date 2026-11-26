// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0

/**
 * Calls to the board's `/api` with the agent token (plan decision P6): the
 * adapter's tools proxy here, and it joins here to get its session.
 */

import { findTool, PEER_CONTENT_NOTICE } from "@bbs-5000/core";

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{
  status: number;
  json(): Promise<unknown>;
}>;

export interface ApiOptions {
  url: string;
  token: string;
  fetch?: FetchLike;
}

export interface ToolCallResult {
  [key: string]: unknown;
  isError: boolean;
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
}

/**
 * Whether a board answer refuses the token as revoked (401 with
 * `authentication failed: revoked_token`): kicked or replaced. Terminal for
 * the adapter (M4b review m4).
 */
export function isRevokedToken(r: { status: number; body: Record<string, unknown> }): boolean {
  const error = r.body.error as { message?: unknown } | undefined;
  return r.status === 401 && typeof error?.message === "string" && error.message.includes("revoked_token");
}

/** Header carrying the board session (packages/worker/src/http.ts). */
export const SESSION_HEADER = "x-bbs-session";

export class BoardApi {
  readonly #url: string;
  readonly #token: string;
  readonly #fetch: FetchLike;

  constructor(o: ApiOptions) {
    this.#url = o.url.replace(/\/+$/, "");
    this.#token = o.token;
    this.#fetch = o.fetch ?? (globalThis.fetch as unknown as FetchLike);
  }

  /** POST /api/<tool>; returns the parsed body and status. Throws on a network failure. */
  async call(tool: string, args: unknown, session?: string): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await this.#fetch(`${this.#url}/api/${encodeURIComponent(tool)}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.#token}`,
        ...(session !== undefined ? { [SESSION_HEADER]: session } : {}),
      },
      body: JSON.stringify(args ?? {}),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { status: res.status, body };
  }

  /**
   * A tool call shaped like `/mcp`'s results: the value as JSON text, after
   * the peer-content notice when the tool carries other users' text (design
   * §11); an error as `Error (<code>): <message>`.
   */
  async tool(name: string, args: unknown, session?: string): Promise<ToolCallResult> {
    let r: { status: number; body: Record<string, unknown> };
    try {
      r = await this.call(name, args, session);
    } catch {
      return { isError: true, content: [{ type: "text", text: "Error (unreachable): the board did not answer" }] };
    }
    if (r.body.ok === true) {
      const value = (r.body.value ?? {}) as Record<string, unknown>;
      const json = JSON.stringify(value, null, 2);
      const text = findTool(name)?.carriesPeerText ? `${PEER_CONTENT_NOTICE}\n${json}` : json;
      return { isError: false, content: [{ type: "text", text }], structuredContent: value };
    }
    const error = (r.body.error ?? {}) as { code?: unknown; message?: unknown };
    const code = typeof error.code === "string" ? error.code : `http_${r.status}`;
    const message = typeof error.message === "string" ? error.message : "request failed";
    return {
      isError: true,
      content: [{ type: "text", text: `Error (${code}): ${message}` }],
      structuredContent: { error: { code, message } },
    };
  }
}

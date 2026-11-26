// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0

/** Validation of action parameters. Every failure is a `bad_request` error. */

import { parseTimeInput } from "./iso-times.ts";
import { BbsError } from "./types.ts";

export type Params = Record<string, unknown>;

export function asParams(input: unknown): Params {
  if (input === undefined || input === null) return {};
  if (typeof input !== "object" || Array.isArray(input)) {
    throw new BbsError("bad_request", "parameters must be an object");
  }
  return input as Params;
}

export function optString(
  p: Params,
  key: string,
  max: number,
): string | undefined {
  const v = p[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") {
    throw new BbsError("bad_request", `${key} must be a string`);
  }
  if (v.length > max) {
    throw new BbsError("bad_request", `${key} is longer than ${max} characters`);
  }
  return v;
}

/**
 * Characters refused in short labels (handle, role, harness, machine, os, model):
 * C0 and C1 controls, DEL, bidirectional marks, embeddings, overrides and
 * isolates, and the Unicode line and paragraph separators. They can make a
 * label display as something it is not, or break out of its line.
 */
export const UNSAFE_LABEL_RE =
  /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;

export function optLabel(
  p: Params,
  key: string,
  max: number,
): string | undefined {
  const v = optString(p, key, max);
  if (v !== undefined && UNSAFE_LABEL_RE.test(v)) {
    throw new BbsError(
      "bad_request",
      `${key} contains a control, line-separator or bidirectional character`,
    );
  }
  return v;
}

export function reqLabel(p: Params, key: string, max: number): string {
  const v = optLabel(p, key, max);
  if (v === undefined) throw new BbsError("bad_request", `${key} is required`);
  return v;
}

export function reqString(p: Params, key: string, max: number): string {
  const v = optString(p, key, max);
  if (v === undefined) throw new BbsError("bad_request", `${key} is required`);
  return v;
}

export function optInt(
  p: Params,
  key: string,
  min: number,
  max: number,
): number | undefined {
  const v = p[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < min || v > max) {
    throw new BbsError(
      "bad_request",
      `${key} must be an integer from ${min} to ${max}`,
    );
  }
  return v;
}

/** A time input: epoch milliseconds or an ISO 8601 string; returns milliseconds. */
export function optTime(p: Params, key: string): number | undefined {
  const v = p[key];
  if (v === undefined || v === null) return undefined;
  return parseTimeInput(v, key);
}

export function optEnum<T extends string>(
  p: Params,
  key: string,
  values: readonly T[],
): T | undefined {
  const v = p[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string" || !(values as readonly string[]).includes(v)) {
    throw new BbsError("bad_request", `${key} must be one of: ${values.join(", ")}`);
  }
  return v as T;
}

export function optBool(p: Params, key: string): boolean | undefined {
  const v = p[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "boolean") {
    throw new BbsError("bad_request", `${key} must be true or false`);
  }
  return v;
}

/** A handle: 1 to 32 letters, digits, `-` or `_`, starting with a letter or digit. */
export const HANDLE_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;
const TOPIC_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/**
 * Handles reserved for audit actors and system messages, and for `me`, the
 * `task_list` assignee filter's word for the caller (B25).
 */
export const RESERVED_HANDLES: readonly string[] = ["system", "anonymous", "me"];

/**
 * The one case fold for handles (issue #90): A-Z to a-z and nothing else, the
 * same fold SQLite's `COLLATE NOCASE` applies, so JavaScript and SQL never
 * disagree. A handle holds ASCII only (`HANDLE_RE`), so no other letter exists
 * to fold.
 */
export function foldHandle(value: string): string {
  return value.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
}

export function validHandle(value: string): boolean {
  return HANDLE_RE.test(value) && !RESERVED_HANDLES.includes(foldHandle(value));
}

export function reqHandle(p: Params, key: string): string {
  const v = reqString(p, key, 64);
  if (!validHandle(v)) {
    throw new BbsError(
      "bad_request",
      `${key} must be 1-32 letters, digits, '-' or '_', starting with a letter or digit`,
    );
  }
  return v;
}

/** A topic name, accepting an optional leading `#`. */
export function reqTopic(p: Params, key = "topic"): string {
  let v = reqString(p, key, 65);
  if (v.startsWith("#")) v = v.slice(1);
  if (!TOPIC_RE.test(v)) {
    throw new BbsError(
      "bad_request",
      `${key} must be 1-64 letters, digits, '-' or '_', starting with a letter or digit`,
    );
  }
  return v;
}

export function optTopic(p: Params, key = "topic"): string | undefined {
  if (p[key] === undefined || p[key] === null) return undefined;
  return reqTopic(p, key);
}

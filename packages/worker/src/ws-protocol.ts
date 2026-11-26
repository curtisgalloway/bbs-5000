// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0

/**
 * The adapter WebSocket protocol (spec §4.3), parsed and checked in plain
 * functions (testable in Node). Additions to the spec's messages, recorded in
 * the pre-publication M2 notes: `hello.state` (busy/idle at attach) and
 * `ring_result.confirmed` (the adapter saw the turn start).
 */

/** Largest adapter message accepted; anything longer closes the socket. */
export const MAX_SOCKET_MESSAGE = 4 * 1024;

/** Close codes the board uses (4000-4999 are for applications). */
export const CLOSE = {
  /** A message that is not the protocol. */
  protocol: 1008,
  /** A message over MAX_SOCKET_MESSAGE. */
  tooBig: 1009,
  /** The session ended (a later bbs_join replaced it); do not reconnect with it. */
  sessionEnded: 4001,
  /** The board refused the message (audited); see the reason. */
  refused: 4003,
  /**
   * The credential no longer holds (M4b, B48): the user was kicked (a
   * `{"type":"kicked"}` frame comes first) or its token was revoked or
   * replaced. Do not reconnect with this token.
   */
  credentialRevoked: 4004,
} as const;

export type AdapterMessage =
  | { type: "hello"; session: string; harness?: string; machine?: string; state?: "idle" | "busy" }
  | { type: "state"; state: "idle" | "busy" }
  | { type: "ring_result"; id: string; result: "turn_started" | "held_busy" | "failed"; confirmed?: boolean };

const STATES = new Set(["idle", "busy"]);
const RESULTS = new Set(["turn_started", "held_busy", "failed"]);

function str(v: unknown, max: number): string | undefined {
  return typeof v === "string" && v.length > 0 && v.length <= max ? v : undefined;
}

/**
 * Parse one adapter message. Returns the message, or `{ error }` for
 * anything else (bad JSON, unknown type, missing or bad fields). Field
 * contents (labels) are checked again by `core`.
 */
/** Size of a socket message in bytes (UTF-8 for text), for the MAX_SOCKET_MESSAGE limit. */
export function messageBytes(raw: string | ArrayBuffer): number {
  return typeof raw === "string" ? new TextEncoder().encode(raw).byteLength : raw.byteLength;
}

export function parseAdapterMessage(raw: string | ArrayBuffer): AdapterMessage | { error: string } {
  if (typeof raw !== "string") return { error: "binary messages are not accepted" };
  if (messageBytes(raw) > MAX_SOCKET_MESSAGE) return { error: "message too large" };
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return { error: "not JSON" };
  }
  if (v === null || typeof v !== "object" || Array.isArray(v)) return { error: "not a JSON object" };
  const m = v as Record<string, unknown>;
  switch (m.type) {
    case "hello": {
      const session = str(m.session, 128);
      if (!session) return { error: "hello needs a session" };
      const out: AdapterMessage = { type: "hello", session };
      if (m.harness !== undefined) {
        const h = str(m.harness, 64);
        if (!h) return { error: "bad harness" };
        out.harness = h;
      }
      if (m.machine !== undefined) {
        const h = str(m.machine, 64);
        if (!h) return { error: "bad machine" };
        out.machine = h;
      }
      if (m.state !== undefined) {
        if (typeof m.state !== "string" || !STATES.has(m.state)) return { error: "bad state" };
        out.state = m.state as "idle" | "busy";
      }
      return out;
    }
    case "state":
      if (typeof m.state !== "string" || !STATES.has(m.state)) return { error: "bad state" };
      return { type: "state", state: m.state as "idle" | "busy" };
    case "ring_result": {
      const id = str(m.id, 64);
      if (!id) return { error: "ring_result needs an id" };
      if (typeof m.result !== "string" || !RESULTS.has(m.result)) return { error: "bad result" };
      const out: AdapterMessage = {
        type: "ring_result",
        id,
        result: m.result as "turn_started" | "held_busy" | "failed",
      };
      if (m.confirmed !== undefined) {
        if (typeof m.confirmed !== "boolean") return { error: "bad confirmed" };
        out.confirmed = m.confirmed;
      }
      return out;
    }
    default:
      return { error: "unknown message type" };
  }
}

/** What the DO keeps with each socket (`serializeAttachment`, at most 16 KiB). */
export interface SocketAttachment {
  handle: string;
  /** The session from `hello`, or null before it. */
  session: string | null;
  openedAt: number;
  /**
   * SHA-256 of the token the socket opened with (M4b, B48), rechecked on
   * every message. Missing on a socket opened before M4b: closed with
   * `refused` so the adapter signs in again.
   */
  tokenHash?: string;
  /**
   * Set when the board closed the socket itself: for a credential (audited by
   * `sockets_closed`) or for a missing hash (audited by the refusal).
   */
  closedBy?: "kicked" | "credential_revoked" | "no_hash";
}

/** Close reasons are at most 123 bytes; keep them short and plain. */
export function closeReason(text: string): string {
  return text.replace(/[^\x20-\x7e]/g, "?").slice(0, 120);
}

/**
 * Test-only faults for the e2e suite (`BBS_TEST_SOCKET_FAULTS`, M4b review
 * m2): they make the board's defensive socket checks reachable end to end,
 * which the normal paths never are (a kick closes sockets before they can
 * send). Never set outside tests; the Board DO warns at start when it is.
 * Comma-separated:
 * - `keep_kicked`: a kick does not close the user's sockets (so the
 *   per-message recheck, or a later revocation, must close them);
 * - `no_hash=<handle>`: that user's sockets are kept without a token hash
 *   (a socket from before M4b);
 * - `bad_hash=<handle>`: the Worker forwards a wrong token hash for that
 *   user's upgrade (a revocation between sign-in and upgrade).
 */
export interface SocketFaults {
  keepKicked: boolean;
  noHash: ReadonlySet<string>;
  badHash: ReadonlySet<string>;
}

export function parseSocketFaults(value: string | undefined): SocketFaults {
  const noHash = new Set<string>();
  const badHash = new Set<string>();
  let keepKicked = false;
  for (const part of (value ?? "").split(",").map((p) => p.trim()).filter(Boolean)) {
    if (part === "keep_kicked") keepKicked = true;
    else if (part.startsWith("no_hash=")) noHash.add(part.slice(8));
    else if (part.startsWith("bad_hash=")) badHash.add(part.slice(9));
  }
  return { keepKicked, noHash, badHash };
}

/** Whether any fault is set (the Board DO warns once at start). */
export function anySocketFault(f: SocketFaults): boolean {
  return f.keepKicked || f.noHash.size > 0 || f.badHash.size > 0;
}

/** The explicit dev flag that lets `BBS_TEST_SOCKET_FAULTS` take effect (F, B55). */
export const ALLOW_TEST_FAULTS = "BBS_ALLOW_TEST_FAULTS";

const NO_FAULTS: SocketFaults = { keepKicked: false, noHash: new Set(), badHash: new Set() };

/**
 * The socket faults to use, from the environment (F, B55). Faults take
 * effect only when `BBS_ALLOW_TEST_FAULTS` is `1` as well (surrounding
 * spaces ignored); set without it, they are refused (no fault is on) and
 * `refused` says so, for a warning at start. A deployment that copies a
 * test env file by mistake therefore keeps every defensive socket path.
 */
export function socketFaultsFromEnv(env: {
  BBS_TEST_SOCKET_FAULTS?: string;
  BBS_ALLOW_TEST_FAULTS?: string;
}): { faults: SocketFaults; refused: boolean } {
  const faults = parseSocketFaults(env.BBS_TEST_SOCKET_FAULTS);
  if (!anySocketFault(faults)) return { faults: NO_FAULTS, refused: false };
  if (env.BBS_ALLOW_TEST_FAULTS?.trim() === "1") return { faults, refused: false };
  return { faults: NO_FAULTS, refused: true };
}

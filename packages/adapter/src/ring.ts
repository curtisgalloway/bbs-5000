// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0

/**
 * The ring-function interface (spec §4.4, design §7, §16): what each harness
 * supplies to the shared adapter: the Claude ring (`claude-ring.ts`) and,
 * from G3, the Codex ring (`codex-ring.ts`). Antigravity and Muse rings are
 * later work.
 */

import type { Doorbell, RingResult, SessionState } from "./board-socket.ts";

export interface RingOutcome {
  result: RingResult;
  /** True when the adapter saw the turn start (a busy signal after the push). */
  confirmed?: boolean;
  /** How the ring was handed over, for the adapter's log only (Claude: `inbox` or `channel`, G4). */
  via?: string;
}

export interface RingFunction {
  /** Reported in `hello` (for example `claude-code`). */
  readonly harness: string;
  /** Start a turn with the doorbell text. Called only while the session is idle. */
  ring(d: Doorbell): Promise<RingOutcome>;
}

/** Where busy/idle comes from (Claude Code: its hooks, `hooks.ts`; Codex: the app-server, `codex-ring.ts`). */
export interface StateSource {
  current(): SessionState;
  onChange(cb: (s: SessionState) => void): void;
}

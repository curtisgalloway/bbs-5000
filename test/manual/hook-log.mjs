#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0
//
// Manual wake test only: a second hook command beside `bbs-adapter hook`, so
// the driver sees hook timing on its own and can total token usage from the
// session transcript. Appends one JSON line per hook to WAKE_HOOK_LOG in the
// run's temporary directory. Prints nothing (a UserPromptSubmit hook's output
// would be added to the model's context).
import { appendFileSync } from "node:fs";

const event = process.argv[2] ?? "unknown";
let input = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) input += chunk;
let parsed = {};
try {
  parsed = JSON.parse(input);
} catch {
  parsed = {};
}
const line = {
  t: Date.now(),
  hook: event,
  promptPrefix: typeof parsed.prompt === "string" ? parsed.prompt.slice(0, 120) : null,
  // G4: the prompt ends with an inbox doorbell marker (the prefix may cut it off).
  inboxMarker: typeof parsed.prompt === "string" && /\[bbs doorbell d_[A-Za-z0-9_-]{1,40}(?: [0-9]{1,4})?\]\s*$/.test(parsed.prompt),
  transcriptPath: parsed.transcript_path ?? null,
  // PreToolUse only: which tool, and the start of a Bash command (the driver's own).
  tool: typeof parsed.tool_name === "string" ? parsed.tool_name : null,
  commandPrefix: typeof parsed.tool_input?.command === "string" ? parsed.tool_input.command.slice(0, 80) : null,
};
if (process.env.WAKE_HOOK_LOG) appendFileSync(process.env.WAKE_HOOK_LOG, JSON.stringify(line) + "\n");

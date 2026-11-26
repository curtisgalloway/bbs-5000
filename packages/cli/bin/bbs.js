#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0
// Needs Node with TypeScript type stripping (22.18 or later).
import { createInterface } from "node:readline/promises";
import { run } from "../src/main.ts";

// `ask` exists only when stdin is a terminal, so a command that asks (web-login)
// refuses when it is piped or run from a script.
const ask = process.stdin.isTTY
  ? async (prompt) => {
      const rl = createInterface({ input: process.stdin, output: process.stderr });
      try {
        return await rl.question(prompt);
      } catch {
        return undefined;
      } finally {
        rl.close();
      }
    }
  : undefined;

const code = await run(process.argv.slice(2), process.env, {
  out: (t) => process.stdout.write(`${t}\n`),
  err: (t) => process.stderr.write(`${t}\n`),
  ...(ask ? { ask } : {}),
});
process.exitCode = code;

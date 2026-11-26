#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0
// Needs Node with TypeScript type stripping (22.18 or later).
import { run } from "../src/main.ts";

const code = await run(process.argv.slice(2), process.env, {
  out: (t) => process.stdout.write(`${t}\n`),
  err: (t) => process.stderr.write(`${t}\n`),
});
process.exitCode = code;

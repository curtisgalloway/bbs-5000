// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0

/**
 * Map `bbs` command words onto the shared tool definitions (plan P4). The
 * verbs come from each tool's `cli` words; arguments come from its JSON
 * Schema: required properties may be given positionally, in schema order,
 * and every property may be given as `--name value` (`--reply-to` or
 * `--reply_to`). No verb is defined here.
 */

import { TOOLS, type ToolDef } from "@bbs-5000/core";

export class UsageError extends Error {
  override readonly name = "UsageError";
}

export const CLI_TOOLS: readonly ToolDef[] = TOOLS.filter((t) => t.surfaces.includes("cli"));

/** The tool whose `cli` words start `argv`, preferring the longest match. */
export function matchTool(argv: readonly string[]): { tool: ToolDef; rest: string[] } | undefined {
  let best: ToolDef | undefined;
  for (const t of CLI_TOOLS) {
    const words = t.cli;
    if (words.length > argv.length) continue;
    if (!words.every((w, i) => argv[i] === w)) continue;
    if (!best || words.length > best.cli.length) best = t;
  }
  return best ? { tool: best, rest: argv.slice(best.cli.length) } : undefined;
}

interface PropSchema {
  type?: string | readonly string[];
  enum?: readonly string[];
}

function convert(tool: ToolDef, key: string, raw: string): unknown {
  const schema = tool.inputSchema.properties[key] as PropSchema | undefined;
  if (!schema) throw new UsageError(`${tool.cli.join(" ")} has no option --${key}`);
  // A time (an integer of milliseconds or an ISO 8601 string): digits alone are milliseconds.
  if (Array.isArray(schema.type)) return schema.type.includes("integer") && /^\d+$/.test(raw) ? Number(raw) : raw;
  switch (schema.type) {
    case "integer": {
      if (!/^-?\d+$/.test(raw)) throw new UsageError(`--${key} must be an integer`);
      return Number(raw);
    }
    case "array": {
      // Lists of integers (task ids), comma-separated: --blocked-by 4,7.
      const parts = raw.split(",").map((x) => x.trim());
      if (parts.length === 0 || !parts.every((x) => /^\d+$/.test(x))) {
        throw new UsageError(`--${key} must be comma-separated integers, e.g. 4,7`);
      }
      return parts.map(Number);
    }
    case "boolean": {
      if (raw === "true") return true;
      if (raw === "false") return false;
      throw new UsageError(`--${key} must be true or false`);
    }
    default:
      if (schema.enum && !schema.enum.includes(raw)) {
        throw new UsageError(`--${key} must be one of: ${schema.enum.join(", ")}`);
      }
      return raw;
  }
}

function isBoolean(tool: ToolDef, key: string): boolean {
  return (tool.inputSchema.properties[key] as PropSchema | undefined)?.type === "boolean";
}

/** Turn the words after the verb into the tool's arguments object. */
export function toolArgs(tool: ToolDef, rest: readonly string[]): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const word = rest[i] as string;
    if (word === "--") {
      positional.push(...rest.slice(i + 1));
      break;
    }
    if (!word.startsWith("--") || word.length === 2) {
      positional.push(word);
      continue;
    }
    const eq = word.indexOf("=");
    const name = (eq === -1 ? word.slice(2) : word.slice(2, eq)).replaceAll("-", "_");
    let value: string;
    if (eq !== -1) {
      value = word.slice(eq + 1);
    } else if (isBoolean(tool, name)) {
      value = "true";
    } else {
      const next = rest[i + 1];
      if (next === undefined) throw new UsageError(`--${name} needs a value`);
      value = next;
      i++;
    }
    if (name in args) throw new UsageError(`--${name} given twice`);
    args[name] = convert(tool, name, value);
  }
  const required = (tool.inputSchema.required ?? []).filter((k) => !(k in args));
  if (positional.length > required.length) {
    throw new UsageError(`too many arguments for ${tool.cli.join(" ")}`);
  }
  positional.forEach((value, i) => {
    const key = required[i] as string;
    args[key] = convert(tool, key, value);
  });
  const missing = (tool.inputSchema.required ?? []).filter((k) => !(k in args));
  if (missing.length > 0) {
    throw new UsageError(`missing ${missing.map((k) => `<${k}>`).join(" ")}`);
  }
  return args;
}

/** One usage line per verb, sorted. */
export function usageLines(): string[] {
  return CLI_TOOLS.map((t) => {
    const req = (t.inputSchema.required ?? []).map((k) => `<${k}>`);
    const opt = Object.keys(t.inputSchema.properties)
      .filter((k) => !(t.inputSchema.required ?? []).includes(k))
      .map((k) => `[--${k.replaceAll("_", "-")} ...]`);
    // `admin status` prints a summary for people; --json gives its JSON (G5).
    const extra = t.name === "bbs_admin_status" ? ["[--json]"] : [];
    return `bbs ${[...t.cli, ...req, ...opt, ...extra].join(" ")}`;
  }).sort();
}

// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0

const USAGE =
  "usage: npm run setup -- [--domain <name>] [--handle <name>] [--dry-run] [--rotate-admin-token] [--change-hosts] [--link-cli] [--require-approval [--approver-allow-synced]] [--json]";

export interface Parsed {
  domain?: string;
  handle: string;
  dryRun: boolean;
  rotateAdminToken: boolean;
  changeHosts: boolean;
  linkCli: boolean;
  json: boolean;
  /** Require a passkey's approval for the gated human-only actions (design §12). Present only when given. */
  requireApproval?: true;
  /** Let a passkey that syncs between devices approve too. Present only when given, with `--require-approval`. */
  approverAllowSynced?: true;
}

/** Parse argv; returns an error message instead of throwing. */
export function parseArgs(argv: readonly string[]): Parsed | string {
  const out: Parsed = { handle: "admin", dryRun: false, rotateAdminToken: false, changeHosts: false, linkCli: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    const value = (name: string): string | undefined => {
      if (a === name) return argv[++i];
      if (a.startsWith(`${name}=`)) return a.slice(name.length + 1);
      return undefined;
    };
    if (a === "--dry-run") out.dryRun = true;
    else if (a === "--rotate-admin-token") out.rotateAdminToken = true;
    else if (a === "--change-hosts") out.changeHosts = true;
    else if (a === "--link-cli") out.linkCli = true;
    else if (a === "--json") out.json = true;
    else if (a === "--require-approval") out.requireApproval = true;
    else if (a === "--approver-allow-synced") out.approverAllowSynced = true;
    else if (a === "--domain" || a.startsWith("--domain=")) {
      const v = value("--domain");
      if (!v) return `--domain needs a value\n${USAGE}`;
      out.domain = v;
    } else if (a === "--handle" || a.startsWith("--handle=")) {
      const v = value("--handle");
      if (!v) return `--handle needs a value\n${USAGE}`;
      out.handle = v;
    } else return `unknown argument: ${a}\n${USAGE}`;
  }
  if (out.approverAllowSynced && !out.requireApproval) {
    return `--approver-allow-synced only means something with --require-approval\n${USAGE}`;
  }
  return out;
}

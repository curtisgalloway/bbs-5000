// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { parseArgs } from "../args.ts";

describe("argument parsing", () => {
  it("defaults to handle admin, no domain, nothing switched on", () => {
    expect(parseArgs([])).toEqual({ handle: "admin", dryRun: false, rotateAdminToken: false, changeHosts: false, linkCli: false, json: false });
  });

  it("reads every flag, with a space or =", () => {
    expect(parseArgs(["--domain", "example.com", "--handle=ann", "--dry-run", "--rotate-admin-token", "--change-hosts", "--link-cli", "--json"])).toEqual({
      domain: "example.com",
      handle: "ann",
      dryRun: true,
      rotateAdminToken: true,
      changeHosts: true,
      linkCli: true,
      json: true,
    });
  });

  it("reads --require-approval and --approver-allow-synced; the second needs the first", () => {
    expect(parseArgs(["--require-approval"])).toEqual({
      handle: "admin",
      dryRun: false,
      rotateAdminToken: false,
      changeHosts: false,
      linkCli: false,
      json: false,
      requireApproval: true,
    });
    expect(parseArgs(["--require-approval", "--approver-allow-synced"])).toMatchObject({ requireApproval: true, approverAllowSynced: true });
    expect(parseArgs(["--approver-allow-synced"])).toMatch(/only means something with --require-approval/);
  });

  it("returns a message for an unknown flag or a missing value", () => {
    expect(parseArgs(["--nope"])).toMatch(/unknown argument/);
    expect(parseArgs(["--domain"])).toMatch(/needs a value/);
    expect(parseArgs(["--handle="])).toMatch(/needs a value/);
  });
});

// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";
import { approvalFromEnv } from "../src/http.ts";

describe("the deploy-time approval vars", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("are off when absent, empty or 0, and on only as 1", () => {
    expect(approvalFromEnv({})).toEqual({ required: false, allowSynced: false });
    expect(approvalFromEnv({ BBS_REQUIRE_APPROVAL: "", BBS_APPROVER_ALLOW_SYNCED: "0" })).toEqual({ required: false, allowSynced: false });
    expect(approvalFromEnv({ BBS_REQUIRE_APPROVAL: "1" })).toEqual({ required: true, allowSynced: false });
    expect(approvalFromEnv({ BBS_REQUIRE_APPROVAL: "1", BBS_APPROVER_ALLOW_SYNCED: "1" })).toEqual({ required: true, allowSynced: true });
  });

  it("read a value that is not 1 or 0 in the safe direction, with a warning: approval on, the synced stopgap off", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(approvalFromEnv({ BBS_REQUIRE_APPROVAL: "true", BBS_APPROVER_ALLOW_SYNCED: "yes" })).toEqual({ required: true, allowSynced: false });
    expect(warn).toHaveBeenCalledTimes(2);
  });
});

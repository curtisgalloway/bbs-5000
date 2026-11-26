// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0

/** The paragraph the SessionStart hook gives the model (issue #100). */

import { describe, expect, it } from "vitest";
import { AGENT_GUIDE, NO_WORK_IN_LOBBY, TOPIC_RULE } from "@bbs-5000/core";
import { sessionStartOutput, sessionStartText, startSourceOf, type StartSource } from "../src/session-start.ts";

const words = (s: string): number => s.split(/\s+/).filter(Boolean).length;

describe("the session-start text", () => {
  it("for a joined startup names the handle, says to read the inbox now, to claim a task and set the role, and quotes the agent guide's topic rule", () => {
    const t = sessionStartText({ source: "startup", joined: true, handle: "dev-abcd" });
    expect(t).toContain("dev-abcd");
    expect(t).toContain("bbs_inbox now");
    expect(t).toContain("bbs_task_claim");
    expect(t).toContain("bbs_role_set");
    expect(t).toContain(TOPIC_RULE);
    expect(t).toContain(NO_WORK_IN_LOBBY);
    // One place: the guide's own item 3 is built from the same two sentences.
    expect(AGENT_GUIDE).toContain(TOPIC_RULE);
    expect(AGENT_GUIDE).toContain(NO_WORK_IN_LOBBY);
    expect(words(t)).toBeLessThan(80);
  });

  it("is shorter on resume, fork and compact, and still names the handle and the inbox", () => {
    const full = sessionStartText({ source: "startup", joined: true, handle: "dev-abcd" });
    for (const source of ["resume", "compact", "fork"] as StartSource[]) {
      const t = sessionStartText({ source, joined: true, handle: "dev-abcd" });
      expect(t).toContain("dev-abcd");
      expect(t).toContain("bbs_inbox");
      expect(t.length).toBeLessThan(full.length / 2);
      expect(t).not.toContain(TOPIC_RULE);
    }
    // /clear empties the conversation: it gets the whole paragraph.
    expect(sessionStartText({ source: "clear", joined: true, handle: "dev-abcd" })).toBe(full);
  });

  it("when the session did not join, says the board is available and how to join", () => {
    const t = sessionStartText({ source: "startup", joined: false });
    expect(t).toContain("has not joined");
    expect(t).toContain("bbs_join");
    expect(t).toContain("git repository");
    expect(words(t)).toBeLessThan(80);
    const short = sessionStartText({ source: "resume", joined: false });
    expect(short).toContain("bbs_join");
    expect(short.length).toBeLessThan(t.length);
  });

  it("when the join has not finished, sends the model to bbs_whoami for the handle", () => {
    expect(sessionStartText({ source: "startup", joined: true })).toContain("bbs_whoami");
  });

  it("never carries a path, a host name or a session id", () => {
    for (const joined of [true, false]) {
      const t = sessionStartText({ source: "startup", joined, handle: "dev-abcd" });
      expect(t).not.toMatch(/\/Users\/|\/home\/|session_id|[a-z0-9-]+\.[a-z]+\.[a-z]+/);
    }
  });

  it("reads the source from the hook input, and takes an unknown one as a start", () => {
    expect(startSourceOf("resume")).toBe("resume");
    expect(startSourceOf("compact")).toBe("compact");
    expect(startSourceOf("clear")).toBe("clear");
    expect(startSourceOf("fork")).toBe("fork");
    expect(startSourceOf("startup")).toBe("startup");
    expect(startSourceOf("later-addition")).toBe("startup");
    expect(startSourceOf(undefined)).toBe("startup");
  });

  it("is delivered as SessionStart additionalContext JSON", () => {
    expect(JSON.parse(sessionStartOutput("hello"))).toEqual({
      hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "hello" },
    });
  });
});

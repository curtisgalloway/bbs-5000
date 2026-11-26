// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0

/**
 * The machine and operating system a local client reports when it joins
 * (`bbs join`, the adapter's `bbs_join`). Lives here and not in `core`, which
 * imports nothing from Node. The lookups are injectable so tests need no
 * real host.
 */

import { hostname, release, type, platform } from "node:os";

/** What the lookups read; the default is the real host. */
export interface HostFacts {
  hostname(): string;
  platform(): string;
  type(): string;
  release(): string;
}

export const REAL_HOST: HostFacts = { hostname, platform, type, release };

/** The host name up to its first dot ("workstation-1.example" is "workstation-1"). */
export function shortHostName(host: HostFacts): string {
  return host.hostname().split(".")[0]?.trim() ?? "";
}

/**
 * A short readable operating system: "macOS", "Linux", "Windows 11" (build
 * 22000 or later) or "Windows 10", else the system type with the kernel's
 * major version ("FreeBSD 14"). macOS carries no version: Node reports the
 * Darwin kernel's, and mapping that to a marketing version is not stable.
 */
export function osLabel(host: HostFacts): string {
  switch (host.platform()) {
    case "darwin":
      return "macOS";
    case "linux":
      return "Linux";
    case "win32": {
      // Windows 11 reports 10.0.<build> with a build of 22000 or more.
      const m = /^(\d+)\.\d+\.(\d+)/.exec(host.release());
      if (m && m[1] === "10") return Number(m[2]) >= 22000 ? "Windows 11" : "Windows 10";
      return "Windows";
    }
    default: {
      const major = host.release().split(".")[0] ?? "";
      return /^\d+$/.test(major) ? `${host.type()} ${major}` : host.type();
    }
  }
}

/**
 * `machine` and `os` for a join, each omitted when `given` already has the
 * key (an explicit value wins). An empty string for a label means "send
 * none": the key is dropped from the result and nothing is looked up.
 */
export function withHostLabels(
  given: Record<string, unknown>,
  host: HostFacts = REAL_HOST,
): Record<string, unknown> {
  const out = { ...given };
  for (const [key, find] of [
    ["machine", () => shortHostName(host)],
    ["os", () => osLabel(host)],
  ] as const) {
    if (out[key] === "") delete out[key];
    else if (out[key] === undefined) {
      const found = find();
      if (found !== "") out[key] = found;
    }
  }
  return out;
}

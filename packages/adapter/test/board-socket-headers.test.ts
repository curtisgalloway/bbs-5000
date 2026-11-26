// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0

/**
 * B46: the adapter hands its token to Node's global WebSocket as a `{ headers }`
 * option (undici). The other adapter tests use a fake socket, so this one runs
 * the real `nodeSocket` against a local HTTP server that records the upgrade
 * request's headers. CI runs it on Node 22 and 24.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { nodeSocket } from "../src/board-socket.ts";

const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise((r) => s.close(() => r(undefined)));
});

describe("nodeSocket", () => {
  it("sends the Authorization header on the upgrade request", async () => {
    let seen: string | undefined;
    const server = createServer();
    servers.push(server);
    server.on("upgrade", (req, socket) => {
      seen = req.headers.authorization;
      socket.destroy();
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", () => r(undefined)));
    const { port } = server.address() as AddressInfo;

    const ws = nodeSocket(`ws://127.0.0.1:${port}/ws`, { Authorization: "Bearer test-token" });
    await new Promise((r) => {
      ws.addEventListener("error", () => r(undefined));
      ws.addEventListener("close", () => r(undefined));
    });

    expect(seen).toBe("Bearer test-token");
  });
});

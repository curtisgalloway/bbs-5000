// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0

// The one `node:crypto` call the Worker makes (synchronous SHA-256 under
// `nodejs_compat`, I0 / plan P2). Declared here so the Worker's typecheck does
// not need `@types/node` beside the Workers types.
declare module "node:crypto" {
  interface Hash {
    update(data: string, encoding?: "utf8"): Hash;
    digest(encoding: "hex"): string;
  }
  export function createHash(algorithm: "sha256"): Hash;
}

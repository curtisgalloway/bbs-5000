// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts", "scripts/setup/test/**/*.test.ts"],
    environment: "node",
    // `npm run test:coverage` (F): v8 line and branch coverage of the unit
    // tests over every package's sources. A report, not a gate: no thresholds.
    coverage: {
      provider: "v8",
      include: ["packages/*/src/**/*.ts", "packages/web/public/**/*.js"],
      exclude: ["**/*.d.ts"],
      reporter: ["text", "json-summary"],
      reportsDirectory: "coverage",
    },
  },
});

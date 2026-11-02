import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

// End-to-end för Chrome-tillägget: Chromium med tillägget mot låtsas-Awish och dev-servern.
//   npx vitest run -c extensions/awish-sync/vitest.e2e.config.ts
// Se extensions/awish-sync/test/e2e.test.ts och docs/awish-tillagg.md.
export default defineConfig({
  root: fileURLToPath(new URL("../..", import.meta.url)),
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("../../src", import.meta.url)),
      "server-only": fileURLToPath(
        new URL("../../node_modules/server-only/empty.js", import.meta.url),
      ),
    },
  },
  test: {
    environment: "node",
    include: ["extensions/awish-sync/test/**/*.test.ts"],
    fileParallelism: false,
    testTimeout: 240_000,
    hookTimeout: 120_000,
    retry: 0,
  },
});

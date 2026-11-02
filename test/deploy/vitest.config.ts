import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

// Tester för scripts/deploy: mockade API:er (inget nät) och en lokal
// testdatabas för migreringsfrågorna (DATABASE_URL_TEST, standard
// binderlab_test_driftsattning på 127.0.0.1:54322).
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("../../src", import.meta.url)),
      "server-only": fileURLToPath(
        new URL("../../node_modules/server-only/empty.js", import.meta.url),
      ),
    },
  },
  test: {
    root: fileURLToPath(new URL("../..", import.meta.url)),
    environment: "node",
    include: ["test/deploy/**/*.test.ts"],
    fileParallelism: false,
    testTimeout: 60_000,
  },
});

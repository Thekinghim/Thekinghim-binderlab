import { fileURLToPath } from "node:url";

import { config } from "dotenv";
import { defineConfig } from "vitest/config";

// E2E: Playwright-biblioteket mot en körande server (BASE_URL, standard
// http://localhost:3200) och dess databas (E2E_DATABASE_URL). Se docs/operations.md.
//
//   E2E_DATABASE_URL=postgres://postgres@127.0.0.1:54322/binderlab_e2e \
//   BASE_URL=http://localhost:3210 E2E_RESET=1 npm run test:e2e
config({ path: [".env.local", ".env"], quiet: true });

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "server-only": fileURLToPath(new URL("./node_modules/server-only/empty.js", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["e2e/**/*.e2e.test.ts"],
    globalSetup: ["e2e/global-setup.ts"],
    // Flödena delar en databas och en server: en fil i taget, i namnordning.
    fileParallelism: false,
    sequence: { shuffle: false },
    testTimeout: 180_000,
    hookTimeout: 180_000,
    // Inga omkörningar: ett test som bara går igenom ibland är ett fel att rätta.
    retry: 0,
  },
});

import { fileURLToPath } from "node:url";

import { config } from "dotenv";
import { defineConfig } from "vitest/config";

// E2E: Playwright-biblioteket mot en körande server (BASE_URL, standard
// http://localhost:3210, den egna e2e-servern) och dess databas (E2E_DATABASE_URL, med
// "e2e" eller "test" i namnet). Se docs/operations.md, avsnittet E2E-tester.
//
//   E2E_DATABASE_URL=postgres://postgres@127.0.0.1:54322/binderlab_e2e \
//   E2E_CRON_SECRET=<CRON_SECRET i kopians .env.local> E2E_RESET=1 npm run test:e2e
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
    // Flödena delar en databas och en server: en fil i taget. Filerna beror inte av
    // varandra eller av ordningen (varje körning får egen källa, mottagare och pris).
    fileParallelism: false,
    sequence: { shuffle: false },
    // Dev-servern kompilerar sidorna (och PDF:en) kallt vid första besöket; i CI tar det tid.
    testTimeout: 300_000,
    hookTimeout: 300_000,
    // Inga omkörningar: ett test som bara går igenom ibland är ett fel att rätta.
    retry: 0,
  },
});

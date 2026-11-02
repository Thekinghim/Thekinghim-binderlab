/**
 * Vitest för importens enhetstester UTAN fast tidszon (projektets
 * vitest.config.ts sätter TZ=Europe/Stockholm). `npm run test:import:tz` kör
 * dem under UTC, Europe/Stockholm och Asia/Shanghai.
 */

import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  root: fileURLToPath(new URL("../../..", import.meta.url)),
  resolve: {
    alias: { "@": fileURLToPath(new URL("../..", import.meta.url)) },
  },
  test: {
    environment: "node",
    include: ["src/import/**/*.test.ts"],
  },
});

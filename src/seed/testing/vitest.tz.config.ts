/**
 * Vitest för seedens enhetstester UTAN fast tidszon (projektets
 * vitest.config.ts sätter TZ=Europe/Stockholm). `npm run test:seed:tz` kör
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
    include: ["src/seed/**/*.test.ts"],
  },
});

/**
 * Vitest-konfiguration för expansion, scenarier, mål och effekt UTAN fast tidszon.
 *
 * Projektets vitest.config.ts sätter TZ=Europe/Stockholm. Här ärvs TZ från miljön, så att
 * samma tester kan köras under UTC och Asia/Shanghai:
 *
 *   for tz in UTC Asia/Shanghai; do
 *     TZ=$tz npx vitest run -c src/analytics/expansion/vitest.tz.config.ts
 *   done
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
    include: [
      "src/analytics/expansion/**/*.test.ts",
      "src/analytics/scenarios/**/*.test.ts",
      "src/analytics/goals/**/*.test.ts",
      "src/analytics/effect/**/*.test.ts",
    ],
  },
});

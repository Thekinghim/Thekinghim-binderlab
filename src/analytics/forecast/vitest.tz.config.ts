/**
 * Vitest-konfiguration för prognos, förlorad försäljning och inköp UTAN fast tidszon.
 *
 * Projektets vitest.config.ts sätter TZ=Europe/Stockholm. Här ärvs TZ från miljön, så att
 * samma tester kan köras under UTC och Asia/Shanghai:
 *
 *   for tz in UTC Asia/Shanghai; do
 *     TZ=$tz npx vitest run -c src/analytics/forecast/vitest.tz.config.ts
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
      "src/analytics/forecast/**/*.test.ts",
      "src/analytics/lost-sales/**/*.test.ts",
      "src/analytics/purchasing/**/*.test.ts",
    ],
  },
});

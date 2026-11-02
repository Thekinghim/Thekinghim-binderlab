/**
 * Vitest-konfiguration för marknadsanalyserna (pricing, releases, assortment) UTAN fast
 * tidszon.
 *
 * Projektets vitest.config.ts sätter TZ=Europe/Stockholm. Här ärvs TZ från miljön, så att
 * samma tester kan köras under UTC och Asia/Shanghai:
 *
 *   for tz in UTC Asia/Shanghai; do
 *     TZ=$tz npx vitest run -c src/analytics/pricing/vitest.tz.config.ts
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
      "src/analytics/pricing/**/*.test.ts",
      "src/analytics/releases/**/*.test.ts",
      "src/analytics/assortment/**/*.test.ts",
    ],
  },
});

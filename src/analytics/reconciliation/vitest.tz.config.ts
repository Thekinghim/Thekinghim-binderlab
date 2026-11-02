/**
 * Vitest-konfiguration för ekonomiområdet (avstämning, kassaflöde, avtal) UTAN fast tidszon.
 *
 * Projektets vitest.config.ts sätter TZ=Europe/Stockholm. Här ärvs TZ från miljön, så att
 * samma tester kan köras under UTC och Asia/Shanghai och visa att resultaten inte beror på
 * processens tidszon:
 *
 *   for tz in UTC Europe/Stockholm Asia/Shanghai; do
 *     TZ=$tz npx vitest run -c src/analytics/reconciliation/vitest.tz.config.ts
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
      "src/analytics/reconciliation/**/*.test.ts",
      "src/analytics/cashflow/**/*.test.ts",
      "src/analytics/contracts/**/*.test.ts",
    ],
  },
});

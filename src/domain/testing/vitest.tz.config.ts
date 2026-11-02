/**
 * Vitest-konfiguration för beräkningslagret UTAN fast tidszon.
 *
 * Projektets vitest.config.ts sätter TZ=Europe/Stockholm. Här ärvs TZ från miljön,
 * så att `npm run test:domain:tz` kan köra samma tester under UTC, Europe/Stockholm
 * och Asia/Shanghai och visa att resultaten inte beror på processens tidszon.
 */

import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  root: fileURLToPath(new URL("../../..", import.meta.url)),
  test: {
    environment: "node",
    include: ["src/domain/**/*.test.ts"],
  },
});

/**
 * Vitest-konfiguration för rapportunderlagen UTAN fast tidszon (TZ ärvs från miljön).
 * TZ=UTC npx vitest run -c src/reports/testing/vitest.tz.config.ts
 */

import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  root: fileURLToPath(new URL("../../..", import.meta.url)),
  resolve: { alias: { "@": fileURLToPath(new URL("../..", import.meta.url)) } },
  test: {
    environment: "node",
    include: ["src/reports/**/*.test.ts"],
  },
});

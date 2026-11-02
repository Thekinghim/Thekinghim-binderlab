import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Datumtester räknar med svensk tid, inklusive sommartidsskiften.
process.env.TZ = "Europe/Stockholm";

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    env: { TZ: "Europe/Stockholm" },
  },
});

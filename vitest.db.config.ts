import { fileURLToPath } from "node:url";

import { config } from "dotenv";
import { defineConfig } from "vitest/config";

// Databastesterna kör mot DATABASE_URL_TEST (binderlab_test), aldrig mot
// utvecklingsdatabasen. globalSetup återställer den en gång per körning.
config({ path: [".env.local", ".env"], quiet: true });

const testUrl = process.env.DATABASE_URL_TEST;
if (!testUrl) {
  throw new Error("DATABASE_URL_TEST saknas (.env.local).");
}

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      // src/db/client.ts importerar "server-only", som kastar utanför Next.
      "server-only": fileURLToPath(new URL("./node_modules/server-only/empty.js", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["test/db/**/*.test.ts"],
    globalSetup: ["test/db/setup.ts"],
    // En fil i taget mot samma databas. Varje test skapar egna användare och
    // organisationer, så inget behöver städas mellan testerna.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    env: { DATABASE_URL: testUrl },
  },
});

/**
 * Återställer en LOKAL databas: drop/create, auth-shim, alla migreringar.
 *
 *   npm run db:reset -- dev    # DATABASE_URL
 *   npm run db:reset -- test   # DATABASE_URL_TEST
 *
 * Vägrar om värden inte är 127.0.0.1/localhost, så att en Supabase-databas
 * aldrig kan raderas av misstag.
 */

import { config } from "dotenv";

import { resetDatabase } from "../../src/db/migrator";

config({ path: [".env.local", ".env"], quiet: true });

const TARGETS = { dev: "DATABASE_URL", test: "DATABASE_URL_TEST" } as const;
type Target = keyof typeof TARGETS;

function isTarget(value: string | undefined): value is Target {
  return value === "dev" || value === "test";
}

async function main(): Promise<void> {
  const target = process.argv[2];
  if (!isTarget(target)) {
    throw new Error("Ange dev eller test: npm run db:reset -- <dev|test>");
  }
  const variable = TARGETS[target];
  const url = process.env[variable];
  if (!url) {
    throw new Error(`${variable} saknas.`);
  }
  const started = Date.now();
  await resetDatabase(url, { log: (m) => console.log(m) });
  const { host, pathname } = new URL(url);
  console.log(`Återställde ${host}${pathname} på ${Date.now() - started} ms.`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

/**
 * Kör migreringarna i supabase/migrations som inte redan körts.
 *
 *   npm run db:migrate                  # mot DATABASE_URL (.env.local)
 *   npm run db:migrate -- --url <url>   # mot en annan databas
 *
 * En transaktion per fil. Bokförs i supabase_migrations.schema_migrations
 * (samma tabell som Supabase CLI använder).
 */

import { config } from "dotenv";

import { applyMigrations } from "../../src/db/migrator";

config({ path: [".env.local", ".env"], quiet: true });

function parseUrl(argv: string[]): string {
  const i = argv.indexOf("--url");
  if (i !== -1) {
    const value = argv[i + 1];
    if (!value) {
      throw new Error("--url saknar värde.");
    }
    return value;
  }
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL saknas (sätt den i .env.local eller använd --url).");
  }
  return url;
}

async function main(): Promise<void> {
  const url = parseUrl(process.argv.slice(2));
  const host = new URL(url).host;
  const applied = await applyMigrations(url, { log: (m) => console.log(m) });
  console.log(
    applied.length === 0
      ? `Inga nya migreringar (${host}).`
      : `${applied.length} migrering(ar) körda mot ${host}.`,
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

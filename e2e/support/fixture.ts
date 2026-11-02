/**
 * Testdata för e2e-testerna, i databasen som servern under test använder (E2E_DATABASE_URL).
 *
 * - `resetAndSeed`: återställer databasen (bara lokal) och kör seeden (Binderlab med
 *   agare@ och delagare@binderlab.local, 460 order genom importen).
 * - `prepareFixture`: idempotent. Skapar påfyllaren (pafyllare@binderlab.local) och en egen
 *   datakälla för importflödet med samma automatkopplingar som seedens källa, så att
 *   seed-CSV:n ger nya order första gången och 0 nya andra gången, oavsett tidigare körningar
 *   (varje körning får en ny källa).
 *
 * Körs av e2e/global-setup.ts (systemroll). Testerna själva går bara genom webbläsaren.
 */

import postgres from "postgres";

import { hashPassword } from "@/server/auth/password";
import { DEFAULT_DEV_SEED_PASSWORD, SEED_ORGANIZATION } from "@/seed/catalog";

export interface E2eFixture {
  readonly baseUrl: string;
  readonly password: string;
  readonly users: { owner: string; partner: string; refiller: string };
  readonly organizationId: string;
  /** Datakällan som importflödet laddar upp till (namnet visas i väljaren). */
  readonly importSource: { id: string; name: string };
  /** Seedens orderlista (Awish-CSV) på disk. */
  readonly seedCsv: string;
  /** Var servern lägger mejlen (MAIL_PROVIDER=outbox). */
  readonly outboxDir: string;
}

export const E2E_USERS = {
  owner: "agare@binderlab.local",
  partner: "delagare@binderlab.local",
  refiller: "pafyllare@binderlab.local",
} as const;

const LOCAL = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export function assertLocal(url: string): void {
  if (!LOCAL.has(new URL(url).hostname)) {
    throw new Error("E2E_DATABASE_URL måste vara en lokal databas (127.0.0.1/localhost).");
  }
}

/** Återställer databasen och kör seeden (samma som npm run db:reset + db:seed). */
export async function resetAndSeed(url: string, password: string): Promise<void> {
  assertLocal(url);
  const { resetDatabase } = await import("@/db/migrator");
  await resetDatabase(url);
  process.env.DATABASE_URL = url;
  const { getServiceDb, closeServiceDb } = await import("@/db/client");
  const { runSeed } = await import("@/seed/run-seed");
  try {
    await runSeed(getServiceDb(), { password, manageUsers: true });
  } finally {
    await closeServiceDb();
  }
}

export async function prepareFixture(
  url: string,
  options: { password?: string; runId: string },
): Promise<Omit<E2eFixture, "baseUrl" | "seedCsv" | "outboxDir">> {
  assertLocal(url);
  const password = options.password ?? DEFAULT_DEV_SEED_PASSWORD;
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    const [org] = await sql<{ id: string }[]>`
      select id from public.organizations where slug = ${SEED_ORGANIZATION.slug}`;
    if (!org) {
      throw new Error(
        "Seedens organisation saknas. Kör npm run db:seed mot E2E_DATABASE_URL (eller E2E_RESET=1).",
      );
    }
    // Påfyllaren: användare i auth-shimmen och medlemskap med rollen refiller.
    const hash = await hashPassword(password);
    const [user] = await sql<{ id: string }[]>`
      insert into auth.users (email, encrypted_password, raw_user_meta_data)
      values (${E2E_USERS.refiller}, ${hash}, ${sql.json({ full_name: "Påfyllare E2E" })})
      on conflict (email) do update set encrypted_password = excluded.encrypted_password
      returning id`;
    await sql`
      insert into public.memberships (organization_id, user_id, role)
      values (${org.id}, ${user!.id}, 'refiller')
      on conflict (organization_id, user_id) do nothing`;

    // Egen källa för importflödet, med seedens automatkopplingar.
    const [seedSource] = await sql<{ id: string; source_timezone: string }[]>`
      select id, source_timezone from public.data_sources
      where organization_id = ${org.id} and provider = 'awish_csv' and archived_at is null
      order by created_at limit 1`;
    if (!seedSource) throw new Error("Seedens datakälla saknas.");
    const name = `E2E-import ${options.runId}`;
    const [source] = await sql<{ id: string }[]>`
      insert into public.data_sources (organization_id, provider, name, source_timezone)
      values (${org.id}, 'awish_csv', ${name}, ${seedSource.source_timezone})
      returning id`;
    await sql`
      insert into public.source_machines
        (organization_id, data_source_id, external_id, external_device_no, external_name, machine_id)
      select organization_id, ${source!.id}, external_id, external_device_no, external_name, machine_id
      from public.source_machines
      where organization_id = ${org.id} and data_source_id = ${seedSource.id}`;
    return {
      password,
      users: { ...E2E_USERS },
      organizationId: org.id,
      importSource: { id: source!.id, name },
    };
  } finally {
    await sql.end();
  }
}

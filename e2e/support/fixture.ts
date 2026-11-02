/**
 * Testdata för e2e-testerna, i databasen som servern under test använder (E2E_DATABASE_URL).
 *
 * - `assertE2eDatabase`: bara en lokal databas vars namn innehåller "e2e" eller "test", och
 *   aldrig den som .env.local pekar på (den vanliga dev-databasen).
 * - `resetAndSeed`: återställer databasen och kör seeden (Binderlab med agare@ och
 *   delagare@binderlab.local, 460 order genom importen).
 * - `prepareFixture`: idempotent. Påfyllaren (pafyllare@binderlab.local, nytt lösenord varje
 *   körning, så att inloggningen visar att servern använder samma databas), två fasta
 *   datakällor med seedens automatkopplingar ("E2E-import" och "E2E-felande import") och
 *   körningens egna orderlistor: rader ur seedens CSV med ordernummer som är unika för
 *   körningen. Importen ger därför samma utfall varje gång (12 nya, sedan 0 nya), och en
 *   körning lägger bara till 12 order i databasen.
 *
 * Körs av e2e/global-setup.ts (systemroll). Testerna själva går genom webbläsaren, utom där
 * ett fel måste framkallas (e2e/06-felovervakning).
 */

import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { parse as parseDotenv } from "dotenv";
import postgres from "postgres";

import { hashPassword } from "@/server/auth/password";
import { DEFAULT_DEV_SEED_PASSWORD, SEED_ORGANIZATION } from "@/seed/catalog";

export interface E2eFixture {
  readonly baseUrl: string;
  /** Lösenordet för seedens användare (ägaren och delägaren). */
  readonly password: string;
  /** Påfyllarens lösenord (nytt för varje körning). */
  readonly refillerPassword: string;
  readonly users: { owner: string; partner: string; refiller: string };
  readonly organizationId: string;
  readonly runId: string;
  /** Datakällan som importflödet laddar upp till (namnet visas i väljaren). */
  readonly importSource: { id: string; name: string };
  /** Datakällan där felövervakningen framkallar en misslyckad import. */
  readonly failingSource: { id: string; name: string };
  /** Körningens orderlista för importen och dess ordernummer. */
  readonly importCsv: { file: string; rows: number; orderNumbers: string[] };
  /** Körningens orderlista för den misslyckade importen. */
  readonly failingCsv: { file: string; rows: number };
  /** Inköpspriset för titeln i prisflödet som gäller 2026-10-15 (öre), eller null. */
  readonly priceBefore: number | null;
  /** Var servern lägger mejlen (MAIL_PROVIDER=outbox). */
  readonly outboxDir: string;
  /** CRON_SECRET hos servern under test (för att köra jobben), eller null. */
  readonly cronSecret: string | null;
}

export const E2E_USERS = {
  owner: "agare@binderlab.local",
  partner: "delagare@binderlab.local",
  refiller: "pafyllare@binderlab.local",
} as const;

/** Titeln i prisflödet (e2e/04-prisandring). */
export const PRICE_TITLE = "Perfect Order";
export const PRICE_VALID_FROM = "2026-10-15";

const SEED_CSV = path.resolve(
  "test",
  "fixtures",
  "seed",
  "awish-orderlista-2026-10-13--2026-11-01.csv",
);
const IMPORT_ROWS = 12;
const FAILING_ROWS = 3;

const LOCAL = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

function databaseName(url: string): string {
  return decodeURIComponent(new URL(url).pathname.replace(/^\//, ""));
}

/** DATABASE_URL i .env.local (den vanliga dev-databasen), om filen finns. */
function devDatabaseUrl(): string | null {
  try {
    return parseDotenv(readFileSync(path.resolve(".env.local"), "utf8")).DATABASE_URL ?? null;
  } catch {
    return null;
  }
}

function sameDatabase(a: string, b: string): boolean {
  try {
    const x = new URL(a);
    const y = new URL(b);
    const host = (h: string) => (LOCAL.has(h) ? "local" : h);
    return (
      host(x.hostname) === host(y.hostname) &&
      (x.port || "5432") === (y.port || "5432") &&
      databaseName(a) === databaseName(b)
    );
  } catch {
    return false;
  }
}

/**
 * Vägrar allt som inte är en egen e2e-databas: testerna skriver priser, mottagare, larm,
 * order och en påfyllare med känt lösenord, och E2E_RESET=1 raderar hela databasen.
 */
export function assertE2eDatabase(url: string): void {
  if (!LOCAL.has(new URL(url).hostname)) {
    throw new Error("E2E_DATABASE_URL måste vara en lokal databas (127.0.0.1/localhost).");
  }
  const name = databaseName(url);
  if (!/e2e|test/i.test(name)) {
    throw new Error(
      `E2E_DATABASE_URL pekar på "${name}". Använd en egen databas vars namn innehåller "e2e" eller "test" (t.ex. binderlab_e2e).`,
    );
  }
  const dev = devDatabaseUrl();
  if (dev && sameDatabase(dev, url)) {
    throw new Error(
      `E2E_DATABASE_URL är samma databas som DATABASE_URL i .env.local (${name}). Använd en egen e2e-databas.`,
    );
  }
}

/** Återställer databasen och kör seeden (samma som npm run db:reset + db:seed). */
export async function resetAndSeed(url: string, password: string): Promise<void> {
  assertE2eDatabase(url);
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

/**
 * Rader ur seedens orderlista med körningens egna id:n: kolumnen ID och ordernumret (Order
 * No.) byts, resten (datum, titel, automat, belopp) är seedens.
 */
export function runCsv(
  seed: string,
  options: { runId: string; prefix: string; skip: number; take: number },
): { text: string; orderNumbers: string[] } {
  const [header, ...lines] = seed.replace(/\r\n/g, "\n").split("\n").filter(Boolean);
  if (!header?.includes("Order No.")) throw new Error("Seedens CSV har oväntade kolumner.");
  const digits = options.runId.replace(/\D/g, "");
  const orderNumbers: string[] = [];
  const rows = lines.slice(options.skip, options.skip + options.take).map((line, i) => {
    const match = /^(\d+),([^,]*),("(?:[^"]|"")*"),([^,]*),(.*)$/.exec(line);
    if (!match) throw new Error(`Oväntad rad i seedens CSV: ${line}`);
    const n = String(i + 1).padStart(2, "0");
    const orderNo = `${options.prefix}-${options.runId}-${n}`;
    orderNumbers.push(orderNo);
    return `9${digits}${n},${match[2]},${match[3]},${orderNo},${match[5]}`;
  });
  return { text: `${header}\n${rows.join("\n")}\n`, orderNumbers };
}

/** Datakälla med namnet (skapas med seedens automatkopplingar om den saknas). */
async function ensureSource(
  sql: postgres.Sql,
  orgId: string,
  seedSource: { id: string; source_timezone: string },
  name: string,
): Promise<{ id: string; name: string }> {
  const [found] = await sql<{ id: string }[]>`
    select id from public.data_sources
    where organization_id = ${orgId} and name = ${name} and archived_at is null
    order by created_at limit 1`;
  if (found) return { id: found.id, name };
  const [source] = await sql<{ id: string }[]>`
    insert into public.data_sources (organization_id, provider, name, source_timezone)
    values (${orgId}, 'awish_csv', ${name}, ${seedSource.source_timezone})
    returning id`;
  await sql`
    insert into public.source_machines
      (organization_id, data_source_id, external_id, external_device_no, external_name, machine_id)
    select organization_id, ${source!.id}, external_id, external_device_no, external_name, machine_id
    from public.source_machines
    where organization_id = ${orgId} and data_source_id = ${seedSource.id}`;
  return { id: source!.id, name };
}

export async function prepareFixture(
  url: string,
  options: { password?: string; runId: string; filesDir: string },
): Promise<
  Omit<E2eFixture, "baseUrl" | "outboxDir" | "cronSecret"> & { readonly databaseName: string }
> {
  assertE2eDatabase(url);
  const password = options.password ?? DEFAULT_DEV_SEED_PASSWORD;
  const refillerPassword = `e2e-${randomBytes(9).toString("base64url")}`;
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
    const hash = await hashPassword(refillerPassword);
    const [user] = await sql<{ id: string }[]>`
      insert into auth.users (email, encrypted_password, raw_user_meta_data)
      values (${E2E_USERS.refiller}, ${hash}, ${sql.json({ full_name: "Påfyllare E2E" })})
      on conflict (email) do update set encrypted_password = excluded.encrypted_password
      returning id`;
    await sql`
      insert into public.memberships (organization_id, user_id, role)
      values (${org.id}, ${user!.id}, 'refiller')
      on conflict (organization_id, user_id) do nothing`;

    const [seedSource] = await sql<{ id: string; source_timezone: string }[]>`
      select id, source_timezone from public.data_sources
      where organization_id = ${org.id} and provider = 'awish_csv' and archived_at is null
        and name not like 'E2E%'
      order by created_at limit 1`;
    if (!seedSource) throw new Error("Seedens datakälla saknas.");
    const importSource = await ensureSource(sql, org.id, seedSource, "E2E-import");
    const failingSource = await ensureSource(sql, org.id, seedSource, "E2E-felande import");

    // Körningens orderlistor.
    const seed = await readFile(SEED_CSV, "utf8");
    await mkdir(options.filesDir, { recursive: true });
    const ok = runCsv(seed, { runId: options.runId, prefix: "E2E", skip: 0, take: IMPORT_ROWS });
    const bad = runCsv(seed, {
      runId: options.runId,
      prefix: "E2E-FEL",
      skip: IMPORT_ROWS,
      take: FAILING_ROWS,
    });
    const importFile = path.join(options.filesDir, `e2e-orderlista-${options.runId}.csv`);
    const failingFile = path.join(options.filesDir, `e2e-felande-${options.runId}.csv`);
    await writeFile(importFile, ok.text);
    await writeFile(failingFile, bad.text);

    const [price] = await sql<{ ore: string }[]>`
      select pp.unit_cost_ore::text as ore
      from public.purchase_prices pp
      join public.titles t on t.id = pp.title_id and t.organization_id = pp.organization_id
      where pp.organization_id = ${org.id} and t.name = ${PRICE_TITLE}
        and pp.valid_from <= ${PRICE_VALID_FROM}
      order by pp.valid_from desc
      limit 1`;

    return {
      password,
      refillerPassword,
      users: { ...E2E_USERS },
      organizationId: org.id,
      runId: options.runId,
      importSource,
      failingSource,
      importCsv: { file: importFile, rows: IMPORT_ROWS, orderNumbers: ok.orderNumbers },
      failingCsv: { file: failingFile, rows: FAILING_ROWS },
      priceBefore: price ? Number(price.ore) : null,
      databaseName: databaseName(url),
    };
  } finally {
    await sql.end();
  }
}

/**
 * Testdata för e2e/14 (Automat-ranking och Bästa sortiment): två egna organisationer med
 * var sin ägare, skrivna som ägaren (RLS, auth.uid()) i E2E_DATABASE_URL. Datumen är
 * relativa till i dag, så att "30 d" alltid har data.
 *
 * - Flottan: tio automater i var sin butik. BL-001–BL-008 säljer olika mycket (Pokémon 151
 *   och 30th Celebration), BL-009 säljer lite och har en titel som står still (White
 *   Flair), BL-010 är ny (6 dagar).
 * - Ensam: en automat som säljer mer de senaste 30 dagarna än perioden innan. Den har också
 *   ett mystery pack (egen produkt med innehåll, 14 per omgång) i sortimentet: raden i
 *   Bästa sortiment har appens längsta etikett, den som måste radbrytas på en smal telefon.
 *
 * Varje körning skapar nya organisationer och användare (runId i namnet).
 */

import type postgres from "postgres";

import { hashPassword } from "@/server/auth/password";

export interface RankingFixture {
  readonly fleetOwner: string;
  readonly soloOwner: string;
  /** Delägare i flottan med Enkel vy (ägarroll, view_mode = 'simple'). */
  readonly fleetPartner: string;
  /** Påfyllare i flottan. */
  readonly fleetRefiller: string;
  /** BL-009 i flottan (den som går dåligt). */
  readonly weakMachineId: string;
}

type Tx = postgres.TransactionSql;

interface MachineSpec {
  readonly code: string;
  readonly name: string;
  /** Titel → pack per dag. */
  readonly perDay: Record<string, number>;
  /** Titlar i sortimentet utöver dem som säljer per dag. */
  readonly alsoListed?: readonly string[];
  /** Enstaka order: titel → dagar sedan. */
  readonly single?: ReadonlyArray<readonly [string, number]>;
  /** Säljer bara de senaste så här många dagarna. Standard 60. */
  readonly days?: number;
  /** Pack per dag för titeln före de senaste 30 dagarna (annars samma). */
  readonly earlier?: Record<string, number>;
}

/** Mystery-packet i Ensam (egen produkt med innehåll). */
export const RANKING_MYSTERY = "Mystery Pack Premium";

const TITLES = [
  "Pokémon 151",
  "30th Celebration",
  "Surging Sparks",
  "Prismatic Evolutions",
  "White Flair",
  RANKING_MYSTERY,
];

const FLEET: MachineSpec[] = [
  {
    code: "BL-001",
    name: "ICA Maxi Barkarby",
    perDay: { "Pokémon 151": 8, "30th Celebration": 6 },
  },
  {
    code: "BL-002",
    name: "Coop Kungens Kurva",
    perDay: { "Pokémon 151": 7, "30th Celebration": 5 },
  },
  ...[
    "Willys Älvsjö",
    "Hemköp Solna",
    "ICA Kvantum Täby",
    "Coop Farsta",
    "Lidl Sickla",
    "ICA Nära Bromma",
  ].map((name, i): MachineSpec => ({
    code: `BL-00${i + 3}`,
    name,
    perDay: { "Pokémon 151": 6 - i, "30th Celebration": 3 },
  })),
  {
    code: "BL-009",
    name: "Pressbyrån Skärholmen",
    perDay: { "Pokémon 151": 1, "Surging Sparks": 1, "Prismatic Evolutions": 1 },
    alsoListed: ["White Flair"],
    single: [
      ["White Flair", 9],
      ["White Flair", 20],
    ],
  },
  { code: "BL-010", name: "ICA Supermarket Nacka", perDay: { "Pokémon 151": 5 }, days: 6 },
];

const SOLO: MachineSpec[] = [
  {
    code: "BL-001",
    name: "Sega gubben",
    perDay: { "Pokémon 151": 4, "Surging Sparks": 2, "Prismatic Evolutions": 2 },
    earlier: { "Pokémon 151": 3 },
    alsoListed: ["White Flair", RANKING_MYSTERY],
    single: [
      ["White Flair", 12],
      [RANKING_MYSTERY, 5],
    ],
  },
];

async function createOwner(sql: postgres.Sql, email: string, password: string): Promise<string> {
  const hash = await hashPassword(password);
  const [user] = await sql<{ id: string }[]>`
    insert into auth.users (email, encrypted_password, raw_user_meta_data)
    values (${email}, ${hash}, ${sql.json({ full_name: "E2E Ranking" })})
    on conflict (email) do update set encrypted_password = excluded.encrypted_password
    returning id`;
  return user!.id;
}

async function seedOrg(
  sql: postgres.Sql,
  owner: { id: string; email: string },
  name: string,
  slug: string,
  machines: readonly MachineSpec[],
): Promise<{ orgId: string; machineIds: Map<string, string> }> {
  return sql.begin(async (tx: Tx) => {
    const machineIds = new Map<string, string>();
    await tx`select set_config('request.jwt.claims', ${JSON.stringify({
      sub: owner.id,
      email: owner.email,
      role: "authenticated",
    })}, true), set_config('role', 'authenticated', true)`;
    const [org] = await tx<
      { id: string }[]
    >`select public.create_organization(${name}, ${slug}) as id`;
    const orgId = org!.id;
    const titleId = new Map<string, string>();
    for (const title of TITLES) {
      const [t] = await tx<{ id: string }[]>`
        insert into public.titles (organization_id, name) values (${orgId}::uuid, ${title}) returning id`;
      titleId.set(title, t!.id);
      await tx`
        insert into public.purchase_prices (organization_id, title_id, unit_cost_ore, valid_from)
        values (${orgId}::uuid, ${t!.id}::uuid, 4500, current_date - 200)`;
    }
    if (machines.some((m) => m.alsoListed?.includes(RANKING_MYSTERY))) {
      await tx`update public.titles set own_product = true
               where organization_id = ${orgId}::uuid and id = ${titleId.get(RANKING_MYSTERY)!}::uuid`;
      await tx`select public.save_mystery_recipe(${orgId}::uuid,
        ${titleId.get(RANKING_MYSTERY)!}::uuid, 14,
        ${tx.json([
          { titleId: titleId.get("Pokémon 151")!, quantity: 10, hit: false },
          { titleId: titleId.get("Prismatic Evolutions")!, quantity: 4, hit: true },
        ])})`;
    }
    const [source] = await tx<{ id: string }[]>`
      insert into public.data_sources (organization_id, provider, name)
      values (${orgId}::uuid, 'awish_csv', 'E2E Ranking') returning id`;
    for (const m of machines) {
      const days = m.days ?? 60;
      const [store] = await tx<{ id: string }[]>`
        insert into public.stores (organization_id, name) values (${orgId}::uuid, ${m.name}) returning id`;
      await tx`
        insert into public.store_agreements (organization_id, store_id, valid_from, commission_bp)
        values (${orgId}::uuid, ${store!.id}::uuid, current_date - 200, 2000)`;
      const [machine] = await tx<{ id: string }[]>`
        insert into public.machines (organization_id, code, name, active_from)
        values (${orgId}::uuid, ${m.code}, ${m.name}, current_date - ${days}::int) returning id`;
      machineIds.set(m.code, machine!.id);
      await tx`
        insert into public.machine_placements (organization_id, machine_id, store_id, valid_from)
        values (${orgId}::uuid, ${machine!.id}::uuid, ${store!.id}::uuid, current_date - ${days}::int)`;
      for (const title of [...Object.keys(m.perDay), ...(m.alsoListed ?? [])]) {
        await tx`
          insert into public.machine_slots (organization_id, machine_id, title_id, slots, valid_from)
          values (${orgId}::uuid, ${machine!.id}::uuid, ${titleId.get(title)!}::uuid, 1,
                  current_date - ${days}::int)`;
      }
      const insertOrders = (title: string, count: number, fromAgo: number, toAgo: number) => tx`
        insert into public.orders (organization_id, data_source_id, machine_id, payment_method,
                                   external_id, raw_title, title_id, ordered_at, amount_ore, source_hash)
        select ${orgId}::uuid, ${source!.id}::uuid, ${machine!.id}::uuid, 'card',
               ${m.code} || '-' || ${title} || '-' || ago || '-' || k, ${title},
               ${titleId.get(title)!}::uuid,
               ((current_date - ago) + time '09:00' + k * interval '20 minutes')
                 at time zone 'Europe/Stockholm',
               7900, md5(${slug} || ${m.code} || ${title} || ago || '-' || k)
        from generate_series(${toAgo}::int, ${fromAgo}::int) as ago,
             generate_series(1, ${count}::int) as k`;
      for (const [title, count] of Object.entries(m.perDay)) {
        const before = m.earlier?.[title];
        if (before === undefined) await insertOrders(title, count, days, 1);
        else {
          await insertOrders(title, before, days, 30);
          await insertOrders(title, count, 29, 1);
        }
      }
      for (const [title, ago] of m.single ?? []) await insertOrders(title, 1, ago, ago);
    }
    return { orgId, machineIds };
  });
}

/** En medlem till i organisationen (skrivs som databasens ägare, utanför RLS). */
async function addMember(
  sql: postgres.Sql,
  orgId: string,
  email: string,
  password: string,
  role: "owner" | "refiller",
  viewMode: "full" | "simple",
): Promise<void> {
  const userId = await createOwner(sql, email, password);
  await sql`
    insert into public.memberships (organization_id, user_id, role, view_mode)
    values (${orgId}::uuid, ${userId}::uuid, ${role}, ${viewMode})
    on conflict (organization_id, user_id)
      do update set role = excluded.role, view_mode = excluded.view_mode`;
}

/** Skapar de två organisationerna. Ägarna loggar in med `password`. */
export async function prepareRankingFixture(
  sql: postgres.Sql,
  runId: string,
  password: string,
): Promise<RankingFixture> {
  const id = runId.toLowerCase();
  const fleetOwner = `ranking-flotta-${id}@binderlab.local`;
  const soloOwner = `ranking-ensam-${id}@binderlab.local`;
  const fleetPartner = `ranking-delagare-${id}@binderlab.local`;
  const fleetRefiller = `ranking-pafyllare-${id}@binderlab.local`;
  const fleet = await seedOrg(
    sql,
    { id: await createOwner(sql, fleetOwner, password), email: fleetOwner },
    `E2E Flotta ${runId}`,
    `e2e-flotta-${id}`,
    FLEET,
  );
  await addMember(sql, fleet.orgId, fleetPartner, password, "owner", "simple");
  await addMember(sql, fleet.orgId, fleetRefiller, password, "refiller", "full");
  await seedOrg(
    sql,
    { id: await createOwner(sql, soloOwner, password), email: soloOwner },
    `E2E Ensam ${runId}`,
    `e2e-ensam-${id}`,
    SOLO,
  );
  return {
    fleetOwner,
    soloOwner,
    fleetPartner,
    fleetRefiller,
    weakMachineId: fleet.machineIds.get("BL-009")!,
  };
}

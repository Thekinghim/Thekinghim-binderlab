/**
 * Seed av en lokal databas med verksamhetens riktiga försäljning och tre
 * exempelbutiker. Körs från scripts/db/seed.ts (npm run db:seed) och från
 * test/db/seed.test.ts.
 *
 * Orderna går GENOM importen: generatorn (orders.ts) skriver en Awish-CSV
 * (awish-csv.ts) som importeras med runImport som ägaren, precis som en
 * uppladdning i appen. Allt annat skrivs som ägaren med RLS (create_organization,
 * create_invitation/accept_invitation, butiker, avtal, priser, lager), så att
 * created_by, ändringsloggen och behörigheterna blir som i verkligheten.
 * Bara auth.users (inloggningstjänstens tabell) skrivs som databasägare.
 *
 * Idempotent: varje del letar först upp det som redan finns (slug, e-post,
 * namn, kod, giltig från-datum, filens sha256). En andra körning skapar
 * inget nytt. Lagerhändelserna (append-only) skrivs i en transaktion och
 * hoppas över om seedens inventering redan finns.
 */

import { sql, type SQL } from "drizzle-orm";

import type { Db, Tx } from "@/db/client";
import { normalizeText } from "@/import/adapter";
import type { FileStore } from "@/import/file-store";
import { sha256Hex } from "@/import/hash";
import { runImport, type RunImportResult } from "@/import/run-import";
import { hashPassword, verifyPassword } from "@/server/auth/password";

import { SEED_CSV_FILE_NAME, toAwishCsvBytes } from "./awish-csv";
import {
  PLACEMENT_FROM,
  SEED_LEDGER_ACCOUNTS,
  SEED_MACHINES,
  SEED_ORGANIZATION,
  SEED_STORES,
  SEED_TITLES,
  SEED_USERS,
  SOURCE_TIMEZONE,
  STOCK_COUNT_DAY,
  type SeedUser,
} from "./catalog";
import { generateSeedOrders } from "./orders";
import { planStock } from "./stock";

export const SEED_DATA_SOURCE_NAME = "Awish (CSV)";

export interface RunSeedOptions {
  /** Lösenord för dev-användarna (krävs när användarna skapas). */
  password: string;
  /**
   * true (lokalt): skapa/uppdatera användarna i auth.users (auth-shimmen).
   * false (fjärrdatabas): användarna måste redan finnas (skapade via Supabase Auth).
   */
  manageUsers: boolean;
  /** Var den importerade CSV-filen sparas. Standard: importens LocalFileStore. */
  fileStore?: FileStore;
  log?: (message: string) => void;
}

export interface SeedSectionResult {
  created: number;
  existing: number;
}

export interface RunSeedResult {
  organizationId: string;
  dataSourceId: string;
  users: { owner: string; partner: string };
  sections: Record<string, SeedSectionResult>;
  /** Null om samma fil redan var importerad (inget kördes). */
  import: Pick<RunImportResult, "importId" | "summary" | "firstRow" | "warnings"> | null;
  stockEvents: number;
  totals: { orders: number; revenueOre: number };
}

type Row = Record<string, unknown>;

async function rows<T extends Row>(executor: Db | Tx, query: SQL): Promise<T[]> {
  return Array.from(await executor.execute(query)) as T[];
}

async function first<T extends Row>(executor: Db | Tx, query: SQL): Promise<T | undefined> {
  return (await rows<T>(executor, query))[0];
}

async function single<T extends Row>(executor: Db | Tx, query: SQL, what: string): Promise<T> {
  const row = await first<T>(executor, query);
  if (!row) {
    throw new Error(`${what} saknas.`);
  }
  return row;
}

interface Actor {
  id: string;
  email: string;
  fullName: string;
}

/** Transaktion som användaren med RLS (samma som withRls, men på `db`). */
function asActor<T>(db: Db, actor: Actor, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const claims = JSON.stringify({
    sub: actor.id,
    email: actor.email,
    role: "authenticated",
    aud: "authenticated",
    user_metadata: { full_name: actor.fullName },
  });
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('request.jwt.claims', ${claims}, true)`);
    await tx.execute(sql`set local role authenticated`);
    return fn(tx);
  });
}

class Sections {
  readonly data: Record<string, SeedSectionResult> = {};
  add(name: string, created: boolean): void {
    const s = (this.data[name] ??= { created: 0, existing: 0 });
    if (created) {
      s.created++;
    } else {
      s.existing++;
    }
  }
}

async function ensureUser(
  db: Db,
  user: SeedUser,
  options: RunSeedOptions,
  sections: Sections,
): Promise<Actor> {
  const existing = await first<{ id: string; encrypted_password: string | null }>(
    db,
    sql`select id, encrypted_password from auth.users where email = ${user.email}`,
  );
  if (!options.manageUsers) {
    if (!existing) {
      throw new Error(
        `Användaren ${user.email} finns inte. Skapa den i Supabase Auth innan seeden körs mot en fjärrdatabas.`,
      );
    }
    sections.add("users", false);
    return { id: existing.id, email: user.email, fullName: user.fullName };
  }
  const meta = JSON.stringify({ full_name: user.fullName });
  if (existing) {
    // Lösenordet sätts om bara om det inte stämmer (t.ex. nytt DEV_SEED_PASSWORD).
    if (!(await verifyPassword(options.password, existing.encrypted_password))) {
      const hash = await hashPassword(options.password);
      await db.execute(
        sql`update auth.users set encrypted_password = ${hash} where id = ${existing.id}::uuid`,
      );
    }
    sections.add("users", false);
    return { id: existing.id, email: user.email, fullName: user.fullName };
  }
  const hash = await hashPassword(options.password);
  const created = await single<{ id: string }>(
    db,
    sql`insert into auth.users (email, encrypted_password, raw_user_meta_data)
        values (${user.email}, ${hash}, ${meta}::jsonb)
        on conflict (email) do update set email = excluded.email
        returning id`,
    "Användaren",
  );
  sections.add("users", true);
  return { id: created.id, email: user.email, fullName: user.fullName };
}

async function ensureOrganization(db: Db, owner: Actor, sections: Sections): Promise<string> {
  const existing = await first<{ id: string }>(
    db,
    sql`select id from public.organizations where slug = ${SEED_ORGANIZATION.slug}`,
  );
  if (existing) {
    const member = await first<{ role: string }>(
      db,
      sql`select role::text as role from public.memberships
          where organization_id = ${existing.id}::uuid and user_id = ${owner.id}::uuid`,
    );
    if (member?.role !== "owner") {
      throw new Error(
        `Organisationen "${SEED_ORGANIZATION.slug}" finns men ${owner.email} är inte ägare. Seeden rör den inte.`,
      );
    }
    sections.add("organization", false);
    return existing.id;
  }
  const created = await asActor(db, owner, (tx) =>
    single<{ id: string }>(
      tx,
      sql`select public.create_organization(${SEED_ORGANIZATION.name}, ${SEED_ORGANIZATION.slug}) as id`,
      "Organisationen",
    ),
  );
  sections.add("organization", true);
  return created.id;
}

/** Delägaren bjuds in av ägaren och accepterar själv (samma väg som i appen). */
async function ensurePartner(
  db: Db,
  orgId: string,
  owner: Actor,
  partner: Actor,
  sections: Sections,
): Promise<void> {
  const member = await first<{ role: string }>(
    db,
    sql`select role::text as role from public.memberships
        where organization_id = ${orgId}::uuid and user_id = ${partner.id}::uuid`,
  );
  if (member) {
    sections.add("memberships", false);
    return;
  }
  const { token } = await asActor(db, owner, (tx) =>
    single<{ token: string }>(
      tx,
      sql`select public.create_invitation(${orgId}::uuid, ${partner.email}, 'viewer'::public.member_role) as token`,
      "Inbjudan",
    ),
  );
  await asActor(db, partner, (tx) =>
    tx.execute(sql`select public.accept_invitation(${token}) as organization_id`),
  );
  sections.add("memberships", true);
}

interface MasterData {
  dataSourceId: string;
  titleIds: Map<string, string>;
  machineIds: Map<string, string>;
}

/** Inställningar, konton, butiker, automater, avtal, titlar, priser och datakälla. */
async function ensureMasterData(tx: Tx, orgId: string, sections: Sections): Promise<MasterData> {
  const org = sql`${orgId}::uuid`;

  // Inställningar: ingen moms, ingen kortavgift (ändras bara om de avviker).
  const settings = await rows(
    tx,
    sql`update public.organization_settings set vat_rate_bp = 0, card_fee_bp = 0
        where organization_id = ${org} and (vat_rate_bp <> 0 or card_fee_bp <> 0)
        returning id`,
  );
  sections.add("settings", settings.length > 0);

  for (const account of SEED_LEDGER_ACCOUNTS) {
    const inserted = await rows(
      tx,
      sql`insert into public.ledger_accounts (organization_id, key, bas_account, name)
          values (${org}, ${account.key}, ${account.basAccount}, ${account.name})
          on conflict (organization_id, key) do nothing
          returning id`,
    );
    sections.add("ledger_accounts", inserted.length > 0);
  }

  const storeIds = new Map<string, string>();
  for (const store of SEED_STORES) {
    let row = await first<{ id: string }>(
      tx,
      sql`select id from public.stores where organization_id = ${org} and name = ${store.name}`,
    );
    sections.add("stores", !row);
    row ??= await single<{ id: string }>(
      tx,
      sql`insert into public.stores (organization_id, name, address, contact_name, is_example)
          values (${org}, ${store.name}, ${store.address}, ${store.contactName}, true)
          returning id`,
      "Butiken",
    );
    storeIds.set(store.key, row.id);

    const a = store.agreement;
    const agreement = await rows(
      tx,
      sql`insert into public.store_agreements
            (organization_id, store_id, valid_from, commission_bp, monthly_rent_ore, note)
          select ${org}, ${row.id}::uuid, ${a.validFrom}::date, ${a.commissionBp}::integer,
                 ${a.monthlyRentOre}::bigint, ${a.note}
          where not exists (
            select 1 from public.store_agreements sa
            where sa.organization_id = ${org} and sa.store_id = ${row.id}::uuid
              and sa.valid_from = ${a.validFrom}::date
          )
          returning id`,
    );
    sections.add("store_agreements", agreement.length > 0);
  }

  const machineIds = new Map<string, string>();
  for (const machine of SEED_MACHINES) {
    const inserted = await rows<{ id: string }>(
      tx,
      sql`insert into public.machines (organization_id, code, name, serial, active_from, is_example)
          values (${org}, ${machine.code}, ${machine.name}, ${machine.serial},
                  ${machine.activeFrom}::date, true)
          on conflict (organization_id, code) do nothing
          returning id`,
    );
    sections.add("machines", inserted.length > 0);
    const id =
      inserted[0]?.id ??
      (
        await single<{ id: string }>(
          tx,
          sql`select id from public.machines where organization_id = ${org} and code = ${machine.code}`,
          "Automaten",
        )
      ).id;
    machineIds.set(machine.code, id);

    const storeId = storeIds.get(machine.storeKey);
    const placement = await rows(
      tx,
      sql`insert into public.machine_placements (organization_id, machine_id, store_id, valid_from, note)
          select ${org}, ${id}::uuid, ${storeId}::uuid, ${PLACEMENT_FROM}::date, 'Exempel: placering'
          where not exists (
            select 1 from public.machine_placements mp
            where mp.organization_id = ${org} and mp.machine_id = ${id}::uuid
              and mp.valid_from = ${PLACEMENT_FROM}::date
          )
          returning id`,
    );
    sections.add("machine_placements", placement.length > 0);

    for (const inv of machine.investments) {
      const investment = await rows(
        tx,
        sql`insert into public.machine_investments
              (organization_id, machine_id, kind, amount_ore, invested_on, depreciation_months, note)
            select ${org}, ${id}::uuid, ${inv.kind}::public.machine_investment_kind,
                   ${inv.amountOre}::bigint, ${inv.investedOn}::date,
                   ${inv.depreciationMonths}::integer, ${inv.note}
            where not exists (
              select 1 from public.machine_investments mi
              where mi.organization_id = ${org} and mi.machine_id = ${id}::uuid
                and mi.kind = ${inv.kind}::public.machine_investment_kind
                and mi.invested_on = ${inv.investedOn}::date
            )
            returning id`,
      );
      sections.add("machine_investments", investment.length > 0);
    }
  }

  // Titlar med alias (samma stavning som Awish), så att importen hittar dem.
  const titleIds = new Map<string, string>();
  for (const title of SEED_TITLES) {
    const alias = await first<{ title_id: string }>(
      tx,
      sql`select title_id from public.title_aliases
          where organization_id = ${org}
            and alias_normalized = lower(btrim(regexp_replace(normalize(${title.name}::text, NFKC), '\\s+', ' ', 'g')))`,
    );
    let titleId = alias?.title_id;
    if (!titleId) {
      const created = await single<{ id: string }>(
        tx,
        sql`insert into public.titles (organization_id, name) values (${org}, ${title.name})
            returning id`,
        "Titeln",
      );
      titleId = created.id;
      await tx.execute(
        sql`insert into public.title_aliases (organization_id, title_id, alias)
            values (${org}, ${titleId}::uuid, ${title.name})`,
      );
    }
    sections.add("titles", !alias);
    titleIds.set(title.name, titleId);

    for (const price of title.purchasePrices) {
      const inserted = await rows(
        tx,
        sql`insert into public.purchase_prices (organization_id, title_id, unit_cost_ore, valid_from, note)
            values (${org}, ${titleId}::uuid, ${price.unitCostOre}::bigint, ${price.validFrom}::date, ${price.note})
            on conflict (organization_id, title_id, valid_from) do nothing
            returning id`,
      );
      sections.add("purchase_prices", inserted.length > 0);
    }
  }

  // Datakällan och kopplingen Awish-automat → vår automat.
  const sourceInserted = await rows<{ id: string }>(
    tx,
    sql`insert into public.data_sources (organization_id, provider, name, source_timezone)
        values (${org}, 'awish_csv', ${SEED_DATA_SOURCE_NAME}, ${SOURCE_TIMEZONE})
        on conflict (organization_id, name) do nothing
        returning id`,
  );
  sections.add("data_sources", sourceInserted.length > 0);
  const dataSourceId =
    sourceInserted[0]?.id ??
    (
      await single<{ id: string }>(
        tx,
        sql`select id from public.data_sources where organization_id = ${org} and name = ${SEED_DATA_SOURCE_NAME}`,
        "Datakällan",
      )
    ).id;

  for (const machine of SEED_MACHINES) {
    const machineId = machineIds.get(machine.code);
    // Nyckeln är samma som importen använder (NFKC-normaliserat namn).
    const externalId = normalizeText(machine.awishName);
    const inserted = await rows(
      tx,
      sql`insert into public.source_machines
            (organization_id, data_source_id, external_id, external_name, machine_id)
          values (${org}, ${dataSourceId}::uuid, ${externalId}, ${machine.awishName}, ${machineId}::uuid)
          on conflict (organization_id, data_source_id, external_id) do nothing
          returning id`,
    );
    if (inserted.length === 0) {
      await tx.execute(
        sql`update public.source_machines set machine_id = ${machineId}::uuid
            where organization_id = ${org} and data_source_id = ${dataSourceId}::uuid
              and external_id = ${externalId} and machine_id is null`,
      );
    }
    sections.add("source_machines", inserted.length > 0);
  }

  return { dataSourceId, titleIds, machineIds };
}

/** Lagerhändelserna (inventering, påfyllning, leverans). Hoppas över om de redan finns. */
async function ensureStock(
  tx: Tx,
  orgId: string,
  master: MasterData,
  orders: ReturnType<typeof generateSeedOrders>,
): Promise<number> {
  const org = sql`${orgId}::uuid`;
  const already = await first<{ n: number }>(
    tx,
    sql`select count(*)::int as n from public.stock_events
        where organization_id = ${org} and kind = 'count' and business_date = ${STOCK_COUNT_DAY}::date`,
  );
  if ((already?.n ?? 0) > 0) {
    return 0;
  }
  const locations = await rows<{ id: string; machine_id: string | null; is_central: boolean }>(
    tx,
    sql`select id, machine_id, is_central from public.stock_locations
        where organization_id = ${org} and archived_at is null`,
  );
  const central = locations.find((l) => l.is_central);
  if (!central) {
    throw new Error("Centrallagret saknas.");
  }
  const byMachine = new Map<string, string>();
  for (const l of locations) {
    if (l.machine_id !== null) {
      byMachine.set(l.machine_id, l.id);
    }
  }
  const machineLocation = (code: string): string | undefined => {
    const machineId = master.machineIds.get(code);
    return machineId === undefined ? undefined : byMachine.get(machineId);
  };

  const plan = planStock(orders);
  const payload = plan.events.map((e, ord) => {
    const locationId =
      e.location.kind === "warehouse" ? central.id : machineLocation(e.location.code);
    const titleId = master.titleIds.get(e.title);
    if (!locationId || !titleId) {
      throw new Error(`Lagerplats eller titel saknas för ${e.title}.`);
    }
    return {
      ord,
      location_id: locationId,
      title_id: titleId,
      kind: e.kind,
      quantity: e.quantity,
      occurred_at: new Date(e.occurredAtMs).toISOString(),
      note: e.note,
    };
  });
  const inserted = await rows(
    tx,
    sql`insert into public.stock_events (organization_id, location_id, title_id, kind, quantity, occurred_at, note)
        select ${org}, r.location_id, r.title_id, r.kind, r.quantity, r.occurred_at, r.note
        from jsonb_to_recordset(${JSON.stringify(payload)}::jsonb) as r(
          ord integer, location_id uuid, title_id uuid, kind public.stock_event_kind,
          quantity integer, occurred_at timestamptz, note text
        )
        order by r.ord
        returning id`,
  );
  return inserted.length;
}

/** Kör hela seeden. Se filhuvudet. */
export async function runSeed(db: Db, options: RunSeedOptions): Promise<RunSeedResult> {
  const log = options.log ?? (() => {});
  const sections = new Sections();

  const owner = await ensureUser(db, SEED_USERS.owner, options, sections);
  const partner = await ensureUser(db, SEED_USERS.partner, options, sections);
  const orgId = await ensureOrganization(db, owner, sections);
  await ensurePartner(db, orgId, owner, partner, sections);
  log(`Organisation ${SEED_ORGANIZATION.slug} (${orgId}), användare klara.`);

  const master = await asActor(db, owner, (tx) => ensureMasterData(tx, orgId, sections));
  log("Butiker, automater, avtal, titlar, inköpspriser och datakälla klara.");

  // Orderna: generera CSV och importera den som ägaren.
  const orders = generateSeedOrders();
  const bytes = toAwishCsvBytes(orders);
  const sha = sha256Hex(bytes);
  const previous = await first<{ id: string }>(
    db,
    sql`select id from public.imports
        where organization_id = ${orgId}::uuid and data_source_id = ${master.dataSourceId}::uuid
          and file_sha256 = ${sha} and status = 'succeeded'
        limit 1`,
  );
  let imported: RunSeedResult["import"] = null;
  if (previous) {
    log(`Orderlistan är redan importerad (${previous.id}).`);
  } else {
    const result = await runImport(db, {
      organizationId: orgId,
      dataSourceId: master.dataSourceId,
      actorUserId: owner.id,
      actorEmail: owner.email,
      file: { name: SEED_CSV_FILE_NAME, content: bytes },
      dryRun: false,
      fileStore: options.fileStore,
      rowLimit: 0,
    });
    imported = {
      importId: result.importId,
      summary: result.summary,
      firstRow: result.firstRow,
      warnings: result.warnings,
    };
    log(
      `Importerade ${result.summary.new} nya order (${result.summary.duplicate} dubbletter, ` +
        `${result.summary.conflict} konflikter, ${result.summary.error} fel).`,
    );
  }

  const stockEvents = await asActor(db, owner, (tx) => ensureStock(tx, orgId, master, orders));
  log(stockEvents > 0 ? `${stockEvents} lagerhändelser skrivna.` : "Lagret är redan seedat.");

  const totals = await single<{ orders: number; revenue_ore: string }>(
    db,
    sql`select count(*)::int as orders, coalesce(sum(amount_ore), 0)::text as revenue_ore
        from public.orders where organization_id = ${orgId}::uuid`,
    "Summeringen",
  );
  const revenueOre = Number(totals.revenue_ore);
  if (!Number.isSafeInteger(revenueOre)) {
    throw new RangeError("Intäkten är inte ett säkert heltal.");
  }

  return {
    organizationId: orgId,
    dataSourceId: master.dataSourceId,
    users: { owner: owner.id, partner: partner.id },
    sections: sections.data,
    import: imported,
    stockEvents,
    totals: { orders: totals.orders, revenueOre },
  };
}

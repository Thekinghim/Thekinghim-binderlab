/**
 * Seedar demoorganisationen "Nordljus Automater AB (demo)" i en databas.
 * Körs från scripts/db/seed-demo.ts (npm run db:seed-demo) och från
 * test/db/demo-*.test.ts.
 *
 * Samma principer som den riktiga seeden (src/seed/run-seed.ts):
 *
 * - Orderna går GENOM importen: generatorn (generate.ts) skriver en Awish-CSV
 *   per månad som importeras med runImport som ägaren.
 * - Allt annat skrivs som användare med RLS: ägaren skapar organisationen,
 *   bjuder in läsaren och påfyllaren (som själva accepterar), och skriver
 *   butiker, avtal, priser, mål med mera. Påfyllaren skriver påfyllningar,
 *   inventeringar och svinn i automaterna. Bara auth.users skrivs som
 *   databasägare.
 * - Två undantag skrivs som databasägare, eftersom databasen annars stämplar
 *   dem med dagens tid: inköpsorderraderna (mottagningen skapar annars en
 *   inleverans "nu"; inleveranserna skrivs i stället med rätt historisk tid)
 *   och larmen (som larmjobbet skriver, se evaluateOrganization).
 * - Idempotent: varje del letar först upp det som redan finns. En andra
 *   körning skapar inget nytt.
 *
 * Demon är en EGEN organisation. Dess användare är bara medlemmar där, och
 * RLS hindrar att något blandas med den riktiga organisationen (se
 * test/db/demo-isolering.test.ts). resetDemo raderar demoorganisationen helt
 * (gallringsläget, bara för demons egna slug) så att den kan skapas på nytt.
 */

import { sql, type SQL } from "drizzle-orm";

import type { Db, Tx } from "@/db/client";
import { allocateLargestRemainder } from "@/domain/money";
import { normalizeText } from "@/import/adapter";
import type { FileStore } from "@/import/file-store";
import { sha256Hex } from "@/import/hash";
import { runImport } from "@/import/run-import";
import { parsePayoutFile } from "@/server/accounting/payout-csv";
import { evaluateOrganization } from "@/server/alerts/evaluate";
import { hashPassword, verifyPassword } from "@/server/auth/password";

import { SEED_LEDGER_ACCOUNTS } from "../catalog";
import { stockholmToUtcMs } from "../orders";
import {
  DEMO_ACTIVE_MACHINE_GOALS,
  DEMO_AGREEMENTS,
  DEMO_BASELINE_PERIOD,
  DEMO_BASELINES,
  DEMO_BIG_RELEASE,
  DEMO_CONTRACTS,
  DEMO_DATA_SOURCE_NAME,
  DEMO_EFFECT,
  DEMO_EFFECT_SETTINGS,
  DEMO_FIXED_COSTS,
  DEMO_INCIDENTS,
  DEMO_LARGE_SCALE,
  DEMO_LEADS,
  DEMO_MACHINES,
  DEMO_NOW,
  DEMO_ORGANIZATION,
  DEMO_ORGANIZATION_LARGE,
  DEMO_OWNER_SHARES,
  DEMO_OWNER_SHARES_FROM,
  DEMO_PROFIT_GOAL_BP,
  DEMO_RECIPIENTS,
  DEMO_REVENUE_GOALS_KR,
  DEMO_STORES,
  DEMO_SUPPLIERS,
  DEMO_TITLES,
  DEMO_USERS,
  type DemoUser,
} from "./catalog";
import { demoOrderFiles, demoPayoutFiles, planIncidents } from "./files";
import { generateDemo, type DemoGeneration } from "./generate";

export const DEMO_SLUGS: readonly string[] = [DEMO_ORGANIZATION.slug, DEMO_ORGANIZATION_LARGE.slug];

export interface RunDemoSeedOptions {
  /** Lösenord för demoanvändarna (krävs när användarna skapas). */
  password: string;
  /** true (lokalt): skapa/uppdatera användarna i auth.users. false: de måste finnas. */
  manageUsers: boolean;
  /** --stor: 100 000+ order i en egen organisation (nordljus-demo-stor). */
  large?: boolean;
  /** Var de importerade filerna sparas. Standard: importens LocalFileStore. */
  fileStore?: FileStore;
  log?: (message: string) => void;
}

export interface SeedSectionResult {
  created: number;
  existing: number;
}

export interface RunDemoSeedResult {
  organizationId: string;
  slug: string;
  dataSourceId: string;
  users: { owner: string; viewer: string; refiller: string };
  sections: Record<string, SeedSectionResult>;
  /** En rad per månadsfil: nya order (null = filen var redan importerad). */
  imports: { month: string; file: string; orders: number; imported: number | null }[];
  stockEvents: number;
  purchaseOrders: number;
  alerts: number | null;
  generated: { orders: number; revenueOre: number; lostSales: number; stockoutDays: number };
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

function claimsOf(actor: Actor): string {
  return JSON.stringify({
    sub: actor.id,
    email: actor.email,
    role: "authenticated",
    aud: "authenticated",
    user_metadata: { full_name: actor.fullName },
  });
}

/** Byter till användaren (RLS) inne i en pågående transaktion. */
async function becomeActor(tx: Tx, actor: Actor): Promise<void> {
  await tx.execute(sql`select set_config('request.jwt.claims', ${claimsOf(actor)}, true)`);
  await tx.execute(sql`set local role authenticated`);
}

/** Transaktion som användaren med RLS (samma som withRls, men på `db`). */
function asActor<T>(db: Db, actor: Actor, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await becomeActor(tx, actor);
    return fn(tx);
  });
}

class Sections {
  readonly data: Record<string, SeedSectionResult> = {};
  add(name: string, created: boolean, n = 1): void {
    const s = (this.data[name] ??= { created: 0, existing: 0 });
    if (created) {
      s.created += n;
    } else {
      s.existing += n;
    }
  }
}

async function ensureUser(
  db: Db,
  user: DemoUser,
  options: RunDemoSeedOptions,
  sections: Sections,
): Promise<Actor> {
  const existing = await first<{ id: string; encrypted_password: string | null }>(
    db,
    sql`select id, encrypted_password from auth.users where email = ${user.email}`,
  );
  if (!options.manageUsers) {
    if (!existing) {
      throw new Error(
        `Användaren ${user.email} finns inte. Skapa den i Supabase Auth innan demon seedas mot en fjärrdatabas.`,
      );
    }
    sections.add("users", false);
    return { id: existing.id, email: user.email, fullName: user.fullName };
  }
  if (existing) {
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
  const meta = JSON.stringify({ full_name: user.fullName });
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

async function ensureOrganization(
  db: Db,
  org: { name: string; slug: string },
  owner: Actor,
  sections: Sections,
): Promise<string> {
  const existing = await first<{ id: string }>(
    db,
    sql`select id from public.organizations where slug = ${org.slug}`,
  );
  if (existing) {
    const member = await first<{ role: string }>(
      db,
      sql`select role::text as role from public.memberships
          where organization_id = ${existing.id}::uuid and user_id = ${owner.id}::uuid`,
    );
    if (member?.role !== "owner") {
      throw new Error(
        `Organisationen "${org.slug}" finns men ${owner.email} är inte ägare. Demon rör den inte.`,
      );
    }
    sections.add("organization", false);
    return existing.id;
  }
  const created = await asActor(db, owner, (tx) =>
    single<{ id: string }>(
      tx,
      sql`select public.create_organization(${org.name}, ${org.slug}) as id`,
      "Organisationen",
    ),
  );
  sections.add("organization", true);
  return created.id;
}

/** Medlem via inbjudan från ägaren, som medlemmen själv accepterar (samma väg som i appen). */
async function ensureMember(
  db: Db,
  orgId: string,
  owner: Actor,
  member: Actor,
  role: "viewer" | "refiller",
  sections: Sections,
): Promise<void> {
  const existing = await first<{ role: string }>(
    db,
    sql`select role::text as role from public.memberships
        where organization_id = ${orgId}::uuid and user_id = ${member.id}::uuid`,
  );
  if (existing) {
    sections.add("memberships", false);
    return;
  }
  const { token } = await asActor(db, owner, (tx) =>
    single<{ token: string }>(
      tx,
      sql`select public.create_invitation(${orgId}::uuid, ${member.email}, ${role}::public.member_role) as token`,
      "Inbjudan",
    ),
  );
  await asActor(db, member, (tx) => tx.execute(sql`select public.accept_invitation(${token})`));
  sections.add("memberships", true);
}

interface MasterData {
  dataSourceId: string;
  storeIds: Map<string, string>;
  machineIds: Map<string, string>;
  titleIds: Map<string, string>;
  supplierIds: Map<string, string>;
}

const json = (value: unknown) => sql`${JSON.stringify(value)}::jsonb`;

/** Allt utom order, lager, inköp, utbetalningar, ärenden och larm. Som ägaren. */
async function ensureMasterData(
  tx: Tx,
  orgId: string,
  users: { owner: Actor; viewer: Actor | null },
  scale: number,
  sections: Sections,
): Promise<MasterData> {
  const org = sql`${orgId}::uuid`;

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

  // Butiker.
  const storeIds = new Map<string, string>();
  for (const store of DEMO_STORES) {
    let row = await first<{ id: string }>(
      tx,
      sql`select id from public.stores where organization_id = ${org} and name = ${store.name}`,
    );
    sections.add("stores", !row);
    row ??= await single<{ id: string }>(
      tx,
      sql`insert into public.stores (organization_id, name, address, contact_name, email, phone,
                                     store_type, city, open_hours_per_week, area_sqm, is_example)
          values (${org}, ${store.name}, ${store.address}, ${store.contactName}, ${store.email},
                  ${store.phone}, ${store.storeType}, ${store.city}, ${store.openHoursPerWeek}::integer,
                  ${store.areaSqm}::integer, false)
          returning id`,
      "Butiken",
    );
    storeIds.set(store.key, row.id);
  }

  // Kontrakt och avtalsvillkor.
  const contractIds = new Map<string, string>();
  for (const [key, c] of Object.entries(DEMO_CONTRACTS)) {
    const storeId = storeIds.get(c.storeKey);
    let row = await first<{ id: string }>(
      tx,
      sql`select id from public.contracts
          where organization_id = ${org} and store_id = ${storeId}::uuid and title = ${c.title}`,
    );
    sections.add("contracts", !row);
    row ??= await single<{ id: string }>(
      tx,
      sql`insert into public.contracts (organization_id, store_id, valid_from, valid_to,
                                        notice_period_months, renewal_months, terminated_on, title, terms)
          values (${org}, ${storeId}::uuid, ${c.validFrom}::date, ${c.validTo}::date,
                  ${c.noticePeriodMonths}::integer, ${c.renewalMonths}::integer,
                  ${c.terminatedOn}::date, ${c.title}, ${c.terms})
          returning id`,
      "Kontraktet",
    );
    contractIds.set(key, row.id);
  }
  for (const a of DEMO_AGREEMENTS) {
    const inserted = await rows(
      tx,
      sql`insert into public.store_agreements
            (organization_id, store_id, contract_id, valid_from, valid_to, commission_bp,
             monthly_rent_ore, note)
          select ${org}, ${storeIds.get(a.storeKey)}::uuid, ${contractIds.get(a.contractKey)}::uuid,
                 ${a.validFrom}::date, ${a.validTo}::date, ${a.commissionBp}::integer,
                 ${a.monthlyRentOre}::bigint, ${a.note}
          where not exists (
            select 1 from public.store_agreements sa
            where sa.organization_id = ${org} and sa.store_id = ${storeIds.get(a.storeKey)}::uuid
              and sa.valid_from = ${a.validFrom}::date
          )
          returning id`,
    );
    sections.add("store_agreements", inserted.length > 0);
  }

  // Automater, placeringar och investeringar.
  const machineIds = new Map<string, string>();
  for (const machine of DEMO_MACHINES) {
    const inserted = await rows<{ id: string }>(
      tx,
      sql`insert into public.machines (organization_id, code, name, serial, active_from, is_example)
          values (${org}, ${machine.code}, ${machine.name}, ${machine.serial},
                  ${machine.activeFrom}::date, false)
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

    for (const p of machine.placements) {
      const placement = await rows(
        tx,
        sql`insert into public.machine_placements (organization_id, machine_id, store_id, valid_from, valid_to, note)
            select ${org}, ${id}::uuid, ${storeIds.get(p.storeKey)}::uuid, ${p.validFrom}::date,
                   ${p.validTo}::date, ${machine.placements.length > 1 && p !== machine.placements[0] ? "Flyttad från Arboga" : "Placering"}
            where not exists (
              select 1 from public.machine_placements mp
              where mp.organization_id = ${org} and mp.machine_id = ${id}::uuid
                and mp.valid_from = ${p.validFrom}::date
            )
            returning id`,
      );
      sections.add("machine_placements", placement.length > 0);
    }

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

  // Titlar (med alias i Awish stavning) och inköpspriser.
  const titleIds = new Map<string, string>();
  for (const title of DEMO_TITLES) {
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
        sql`insert into public.titles (organization_id, name, series)
            values (${org}, ${title.name}, ${title.series}) returning id`,
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

  // Platser per titel i automaterna (sortimentet).
  for (const machine of DEMO_MACHINES) {
    for (const title of DEMO_TITLES) {
      if (title.availableFrom > DEMO_NOW.date) continue;
      const from =
        title.availableFrom > machine.activeFrom ? title.availableFrom : machine.activeFrom;
      if (title.lastRefill !== null && title.lastRefill < from) continue;
      const inserted = await rows(
        tx,
        sql`insert into public.machine_slots (organization_id, machine_id, title_id, slots, valid_from, valid_to, note)
            select ${org}, ${machineIds.get(machine.code)}::uuid, ${titleIds.get(title.name)}::uuid,
                   ${title.slots}::integer, ${from}::date, ${title.lastRefill}::date,
                   ${title.lastRefill ? "Utgår ur sortimentet" : null}
            where not exists (
              select 1 from public.machine_slots ms
              where ms.organization_id = ${org} and ms.machine_id = ${machineIds.get(machine.code)}::uuid
                and ms.title_id = ${titleIds.get(title.name)}::uuid
            )
            returning id`,
      );
      sections.add("machine_slots", inserted.length > 0);
    }
  }

  // Datakällan och kopplingen Awish-automat → vår automat.
  const sourceInserted = await rows<{ id: string }>(
    tx,
    sql`insert into public.data_sources (organization_id, provider, name, source_timezone)
        values (${org}, 'awish_csv', ${DEMO_DATA_SOURCE_NAME}, 'Asia/Shanghai')
        on conflict (organization_id, name) do nothing
        returning id`,
  );
  sections.add("data_sources", sourceInserted.length > 0);
  const dataSourceId =
    sourceInserted[0]?.id ??
    (
      await single<{ id: string }>(
        tx,
        sql`select id from public.data_sources where organization_id = ${org} and name = ${DEMO_DATA_SOURCE_NAME}`,
        "Datakällan",
      )
    ).id;
  for (const machine of DEMO_MACHINES) {
    const machineId = machineIds.get(machine.code);
    const externalId = normalizeText(machine.awishName);
    const inserted = await rows(
      tx,
      sql`insert into public.source_machines
            (organization_id, data_source_id, external_id, external_name, machine_id)
          values (${org}, ${dataSourceId}::uuid, ${externalId}, ${machine.awishName}, ${machineId}::uuid)
          on conflict (organization_id, data_source_id, external_id) do nothing
          returning id`,
    );
    sections.add("source_machines", inserted.length > 0);
  }

  // Leverantörer och deras artiklar.
  const supplierIds = new Map<string, string>();
  for (const supplier of DEMO_SUPPLIERS) {
    let row = await first<{ id: string }>(
      tx,
      sql`select id from public.suppliers where organization_id = ${org} and name = ${supplier.name}`,
    );
    sections.add("suppliers", !row);
    row ??= await single<{ id: string }>(
      tx,
      sql`insert into public.suppliers (organization_id, name, contact_name, email, phone, default_lead_time_days)
          values (${org}, ${supplier.name}, ${supplier.contactName}, ${supplier.email}, ${supplier.phone},
                  ${supplier.leadTimeDays}::integer)
          returning id`,
      "Leverantören",
    );
    supplierIds.set(supplier.key, row.id);
  }
  for (const title of DEMO_TITLES) {
    const current =
      title.purchasePrices.filter((p) => p.validFrom <= DEMO_NOW.date).at(-1) ??
      title.purchasePrices[0];
    if (!current) continue; // Titlarna utan inköpspris har ingen prislista hos leverantören.
    const supplier = DEMO_SUPPLIERS.find((s) => s.key === title.supplier);
    const inserted = await rows(
      tx,
      sql`insert into public.supplier_items
            (organization_id, supplier_id, title_id, pack_size, min_order_qty, lead_time_days, unit_cost_ore)
          values (${org}, ${supplierIds.get(title.supplier)}::uuid, ${titleIds.get(title.name)}::uuid,
                  ${title.boxSize}::integer, ${title.boxSize}::integer, ${supplier?.leadTimeDays ?? 7}::integer,
                  ${current.unitCostOre}::bigint)
          on conflict (organization_id, supplier_id, title_id) do nothing
          returning id`,
    );
    sections.add("supplier_items", inserted.length > 0);
  }

  // Ägarandelar.
  for (const share of DEMO_OWNER_SHARES) {
    const member = share.userKey === "owner" ? users.owner : users.viewer;
    const inserted = await rows(
      tx,
      sql`insert into public.owner_shares (organization_id, member_user_id, holder_name, share_bp, valid_from)
          values (${org}, ${member?.id ?? null}::uuid, ${share.holderName}, ${share.shareBp}::integer,
                  ${DEMO_OWNER_SHARES_FROM}::date)
          on conflict (organization_id, valid_from, holder_name) do nothing
          returning id`,
    );
    sections.add("owner_shares", inserted.length > 0);
  }

  // Mål per månad.
  const goalRows: { month: string; metric: string; target: number }[] = [];
  for (const [month, kr] of Object.entries(DEMO_REVENUE_GOALS_KR)) {
    const revenueOre = Math.round(kr * scale) * 100;
    goalRows.push({ month: `${month}-01`, metric: "revenue", target: revenueOre });
    goalRows.push({
      month: `${month}-01`,
      metric: "profit",
      target: Math.round((revenueOre * DEMO_PROFIT_GOAL_BP) / 10_000 / 100) * 100,
    });
  }
  for (const [month, n] of Object.entries(DEMO_ACTIVE_MACHINE_GOALS)) {
    goalRows.push({ month: `${month}-01`, metric: "active_machines", target: n });
  }
  const goals = await rows(
    tx,
    sql`insert into public.goals (organization_id, scope, month, metric, target)
        select ${org}, 'organization', r.month, r.metric::public.goal_metric, r.target
        from jsonb_to_recordset(${json(goalRows)}) as r(month date, metric text, target bigint)
        on conflict on constraint goals_scope_key do nothing
        returning id`,
  );
  sections.add("goals", goals.length > 0, Math.max(goals.length, 1));

  // Utgångsläge och effekt.
  for (const b of DEMO_BASELINES) {
    const inserted = await rows(
      tx,
      sql`insert into public.baselines (organization_id, scope, metric, value, unit, measured_from, measured_to, source)
          values (${org}, 'organization', ${b.metric}::public.baseline_metric, ${b.value}::bigint,
                  ${b.unit}::public.baseline_unit, ${DEMO_BASELINE_PERIOD.from}::date,
                  ${DEMO_BASELINE_PERIOD.to}::date, ${b.source})
          on conflict on constraint baselines_scope_key do nothing
          returning id`,
    );
    sections.add("baselines", inserted.length > 0);
  }
  const effectRows = Object.entries(DEMO_EFFECT).flatMap(([month, e]) => [
    { month: `${month}-01`, metric: "stockout_days_month", value: e.stockoutDays },
    { month: `${month}-01`, metric: "refill_hours_month", value: e.refillMinutes },
    { month: `${month}-01`, metric: "admin_hours_month", value: e.adminMinutes },
  ]);
  const effects = await rows(
    tx,
    sql`insert into public.effect_measurements (organization_id, metric, scope, month, value, note)
        select ${org}, r.metric::public.baseline_metric, 'organization', r.month, r.value,
               'Uppmätt i påfyllningsloggen och tidrapporten'
        from jsonb_to_recordset(${json(effectRows)}) as r(month date, metric text, value bigint)
        on conflict on constraint effect_measurements_key do nothing
        returning id`,
  );
  sections.add("effect_measurements", effects.length > 0, Math.max(effects.length, 1));
  const effectSettings = await rows(
    tx,
    sql`insert into public.effect_settings (organization_id, hourly_cost_ore, stockout_day_value_ore)
        select ${org}, ${DEMO_EFFECT_SETTINGS.hourlyCostOre}::bigint, ${DEMO_EFFECT_SETTINGS.stockoutDayValueOre}::bigint
        where not exists (select 1 from public.effect_settings where organization_id = ${org})
        returning id`,
  );
  sections.add("effect_settings", effectSettings.length > 0);

  // Fasta kostnader.
  for (const c of DEMO_FIXED_COSTS) {
    const machineId = c.machineCode ? machineIds.get(c.machineCode) : null;
    const inserted = await rows(
      tx,
      sql`insert into public.fixed_costs (organization_id, name, category, amount_ore, interval, starts_on, ends_on, machine_id, note)
          select ${org}, ${c.name}, ${c.category}, ${Math.round(c.amountOre)}::bigint, ${c.interval},
                 ${c.startsOn}::date, ${c.endsOn}::date, ${machineId ?? null}::uuid, ${c.note}
          where not exists (
            select 1 from public.fixed_costs f where f.organization_id = ${org} and f.name = ${c.name}
          )
          returning id`,
    );
    sections.add("fixed_costs", inserted.length > 0);
  }

  // Expansion.
  for (const lead of DEMO_LEADS) {
    const inserted = await rows(
      tx,
      sql`insert into public.expansion_leads
            (organization_id, name, stage, store_type, city, open_hours_per_week, area_sqm, address,
             contact_name, contact_email, contact_phone, notes, next_step, next_step_on,
             commission_bp, monthly_rent_ore, purchase_ore, installation_ore, store_id)
          select ${org}, ${lead.name}, ${lead.stage}::public.expansion_lead_stage, ${lead.storeType},
                 ${lead.city}, ${lead.openHoursPerWeek}::integer, ${lead.areaSqm}::integer, ${lead.address},
                 ${lead.contactName}, ${lead.contactEmail}, ${lead.contactPhone}, ${lead.notes},
                 ${lead.nextStep}, ${lead.nextStepOn}::date, ${lead.commissionBp}::integer,
                 ${lead.monthlyRentOre}::bigint, ${lead.purchaseOre}::bigint, ${lead.installationOre}::bigint,
                 ${lead.storeKey ? (storeIds.get(lead.storeKey) ?? null) : null}::uuid
          where not exists (
            select 1 from public.expansion_leads l where l.organization_id = ${org} and l.name = ${lead.name}
          )
          returning id`,
    );
    sections.add("expansion_leads", inserted.length > 0);
  }

  // Rapportmottagare.
  for (const r of DEMO_RECIPIENTS) {
    const inserted = await rows(
      tx,
      sql`insert into public.report_recipients (organization_id, name, email, kind, store_id, active)
          select ${org}, ${r.name}, ${r.email}, ${r.kind}::public.report_recipient_kind,
                 ${r.storeKey ? (storeIds.get(r.storeKey) ?? null) : null}::uuid, ${r.active}
          where not exists (
            select 1 from public.report_recipients x
            where x.organization_id = ${org} and x.email = ${r.email} and x.kind = ${r.kind}::public.report_recipient_kind
          )
          returning id`,
    );
    sections.add("report_recipients", inserted.length > 0);
  }

  // Släpp med fördelning per automat (efter butikens takt).
  for (const title of DEMO_TITLES) {
    if (!title.release || !title.preorderPacks) continue;
    let release = await first<{ id: string }>(
      tx,
      sql`select id from public.releases
          where organization_id = ${org} and name = ${title.name} and release_date = ${title.availableFrom}::date`,
    );
    sections.add("releases", !release);
    const units = Math.ceil((title.preorderPacks * scale) / title.boxSize) * title.boxSize;
    release ??= await single<{ id: string }>(
      tx,
      sql`insert into public.releases (organization_id, name, series, release_date, title_id, supplier_id,
                                       scale_bp, horizon_days, box_size, min_order_qty, source, note)
          values (${org}, ${title.name}, ${title.series}, ${title.availableFrom}::date,
                  ${titleIds.get(title.name)}::uuid, ${supplierIds.get(title.supplier)}::uuid,
                  ${title.name === DEMO_BIG_RELEASE ? 15_000 : 10_000}::integer, 28, ${title.boxSize}::integer,
                  ${title.boxSize}::integer, 'manual',
                  ${`Förhandsbeställt ${units} pack (${units / title.boxSize} lådor)`})
          returning id`,
      "Släppet",
    );
    const machines = DEMO_MACHINES.filter((m) => {
      const placement = m.placements.find(
        (p) =>
          p.validFrom <= title.availableFrom &&
          (p.validTo === null || p.validTo >= title.availableFrom),
      );
      return placement !== undefined && m.activeFrom <= title.availableFrom;
    });
    const weights = machines.map((m) => {
      const p = m.placements.find(
        (x) =>
          x.validFrom <= title.availableFrom &&
          (x.validTo === null || x.validTo >= title.availableFrom),
      );
      return Math.round((p?.baseRate ?? 1) * 10);
    });
    const shares = allocateLargestRemainder(units, weights);
    const allocations = machines.map((m, i) => ({
      machine_id: machineIds.get(m.code),
      units: shares[i] ?? 0,
    }));
    const inserted = await rows(
      tx,
      sql`insert into public.release_allocations (organization_id, release_id, machine_id, units, suggested_units)
          select ${org}, ${release.id}::uuid, r.machine_id, r.units, r.units
          from jsonb_to_recordset(${json(allocations)}) as r(machine_id uuid, units integer)
          on conflict (organization_id, release_id, machine_id) do nothing
          returning id`,
    );
    sections.add("release_allocations", inserted.length > 0, Math.max(inserted.length, 1));
  }

  return { dataSourceId, storeIds, machineIds, titleIds, supplierIds };
}

/** Lager och inköp i en transaktion. Hoppas över om inköpsorderna redan finns. */
async function ensureStockAndPurchasing(
  db: Db,
  orgId: string,
  owner: Actor,
  refiller: Actor | null,
  master: MasterData,
  gen: DemoGeneration,
): Promise<{ stockEvents: number; purchaseOrders: number }> {
  const org = sql`${orgId}::uuid`;
  const already = await first<{ n: number }>(
    db,
    sql`select count(*)::int as n from public.purchase_orders where organization_id = ${org}`,
  );
  if ((already?.n ?? 0) > 0) {
    return { stockEvents: 0, purchaseOrders: 0 };
  }
  return db.transaction(async (tx) => {
    await becomeActor(tx, owner);
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
      if (l.machine_id !== null) byMachine.set(l.machine_id, l.id);
    }
    const payload = (actor: "owner" | "refiller") =>
      gen.stockEvents
        .filter((e) => e.actor === actor)
        .map((e, ord) => {
          const locationId =
            e.location.kind === "warehouse"
              ? central.id
              : byMachine.get(master.machineIds.get(e.location.code) ?? "");
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
    const insert = async (list: ReturnType<typeof payload>): Promise<number> => {
      let n = 0;
      for (let i = 0; i < list.length; i += 5_000) {
        const chunk = list.slice(i, i + 5_000);
        const inserted = await rows(
          tx,
          sql`insert into public.stock_events (organization_id, location_id, title_id, kind, quantity, occurred_at, note)
              select ${org}, r.location_id, r.title_id, r.kind, r.quantity, r.occurred_at, r.note
              from jsonb_to_recordset(${json(chunk)}) as r(
                ord integer, location_id uuid, title_id uuid, kind public.stock_event_kind,
                quantity integer, occurred_at timestamptz, note text
              )
              order by r.ord
              returning id`,
        );
        n += inserted.length;
      }
      return n;
    };

    // Centrallagret (ägaren).
    let stockEvents = await insert(payload("owner"));

    // Inköpsorderna (ägaren).
    const poPayload = gen.purchaseOrders.map((po) => ({
      supplier_id: master.supplierIds.get(po.supplier),
      status: po.status,
      ordered_on: po.status === "draft" ? null : po.orderedOn,
      expected_on: po.expectedOn,
      received_on: po.receivedOn,
      note: `${po.key}: ${po.note}`,
    }));
    const poRows = await rows<{ id: string; note: string }>(
      tx,
      sql`insert into public.purchase_orders (organization_id, supplier_id, status, ordered_on, expected_on, received_on, note)
          select ${org}, r.supplier_id, r.status::public.purchase_order_status, r.ordered_on, r.expected_on,
                 r.received_on, r.note
          from jsonb_to_recordset(${json(poPayload)}) as r(
            supplier_id uuid, status text, ordered_on date, expected_on date, received_on date, note text
          )
          returning id, note`,
    );
    const poIds = new Map(poRows.map((r) => [r.note.split(":")[0] ?? "", r.id]));

    // Automaterna (påfyllaren: påfyllning, inventering, svinn).
    // (Utan påfyllare, som i --stor, skriver ägaren även dessa.)
    if (refiller) {
      await becomeActor(tx, refiller);
    }
    stockEvents += await insert(payload("refiller"));

    // Inköpsorderraderna som databasägare utan triggrar: mottagningstriggern skulle
    // annars skapa inleveranser med dagens tid. Inleveranserna finns redan ovan med
    // rätt tid (gen.stockEvents, kind = receipt).
    await tx.execute(sql`reset role`);
    await tx.execute(sql`set local session_replication_role = replica`);
    const linePayload = gen.purchaseOrders.flatMap((po) =>
      po.lines.map((l) => ({
        purchase_order_id: poIds.get(po.key),
        title_id: master.titleIds.get(l.title),
        quantity: l.quantity,
        unit_cost_ore: l.unitCostOre,
        received_quantity: po.status === "received" ? l.quantity : 0,
      })),
    );
    await tx.execute(
      sql`insert into public.purchase_order_lines
            (organization_id, purchase_order_id, title_id, quantity, unit_cost_ore, received_quantity, created_by)
          select ${org}, r.purchase_order_id, r.title_id, r.quantity, r.unit_cost_ore, r.received_quantity,
                 ${owner.id}::uuid
          from jsonb_to_recordset(${json(linePayload)}) as r(
            purchase_order_id uuid, title_id uuid, quantity integer, unit_cost_ore bigint, received_quantity integer
          )`,
    );
    await tx.execute(sql`set local session_replication_role = origin`);
    return { stockEvents, purchaseOrders: poRows.length };
  });
}

/** Utbetalningar och specifikation (som ägaren). Hoppas över om de redan finns. */
async function ensurePayouts(
  db: Db,
  orgId: string,
  owner: Actor,
  master: MasterData,
  files: ReturnType<typeof demoPayoutFiles>,
  sections: Sections,
): Promise<void> {
  const org = sql`${orgId}::uuid`;
  await asActor(db, owner, async (tx) => {
    for (const file of [files.payoutsCsv, files.linesCsv]) {
      const sha = sha256Hex(file.bytes);
      const done = await first(
        tx,
        sql`select 1 from public.payout_imports where organization_id = ${org} and file_sha256 = ${sha}`,
      );
      if (done) {
        sections.add("payout_imports", false);
        continue;
      }
      const parsed = parsePayoutFile(file.bytes);
      if (parsed.errors.length > 0) {
        throw new Error(`Utbetalningsfilen har fel: ${parsed.errors[0]?.message}`);
      }
      const [imp] = await rows<{ id: string }>(
        tx,
        sql`insert into public.payout_imports (organization_id, data_source_id, file_name, file_sha256,
                                               format, rows_total, rows_new)
            values (${org}, ${master.dataSourceId}::uuid, ${file.name}, ${sha}, ${parsed.format},
                    ${parsed.rows}::integer, ${parsed.rows}::integer)
            returning id`,
      );
      sections.add("payout_imports", true);
      if (parsed.format === "payouts") {
        const payload = parsed.payouts.map((p) => ({
          reference: p.reference,
          period_start: p.periodStart,
          period_end: p.periodEnd,
          paid_on: p.paidOn,
          amount_ore: p.amountOre,
          fees_ore: p.feesOre,
          refunds_ore: p.refundsOre,
          source_hash: p.sourceHash,
        }));
        const inserted = await rows(
          tx,
          sql`insert into public.payouts (organization_id, data_source_id, import_id, reference, period_start,
                                          period_end, paid_on, amount_ore, fees_ore, refunds_ore, source_hash)
              select ${org}, ${master.dataSourceId}::uuid, ${imp?.id}::uuid, r.reference, r.period_start,
                     r.period_end, r.paid_on, r.amount_ore, r.fees_ore, r.refunds_ore, r.source_hash
              from jsonb_to_recordset(${json(payload)}) as r(
                reference text, period_start date, period_end date, paid_on date, amount_ore bigint,
                fees_ore bigint, refunds_ore bigint, source_hash text
              )
              returning id`,
        );
        sections.add("payouts", true, inserted.length);
      } else {
        const payload = parsed.lines.map((l) => ({
          reference: l.reference,
          external_id: l.externalId,
          amount_ore: l.amountOre,
        }));
        const inserted = await rows(
          tx,
          sql`insert into public.payout_lines (organization_id, payout_id, import_id, external_id, amount_ore)
              select ${org}, p.id, ${imp?.id}::uuid, r.external_id, r.amount_ore
              from jsonb_to_recordset(${json(payload)}) as r(reference text, external_id text, amount_ore bigint)
              join public.payouts p on p.organization_id = ${org} and p.reference = r.reference
              returning id`,
        );
        sections.add("payout_lines", true, inserted.length);
      }
    }
  });
}

/** Kundärenden (som ägaren). Hoppas över om organisationen redan har ärenden. */
async function ensureIncidents(
  db: Db,
  orgId: string,
  owner: Actor,
  master: MasterData,
  plans: ReturnType<typeof planIncidents>,
  sections: Sections,
): Promise<void> {
  const org = sql`${orgId}::uuid`;
  await asActor(db, owner, async (tx) => {
    const existing = await first<{ n: number }>(
      tx,
      sql`select count(*)::int as n from public.incidents where organization_id = ${org}`,
    );
    if ((existing?.n ?? 0) > 0) {
      sections.add("incidents", false, existing?.n ?? 0);
      return;
    }
    for (const plan of plans) {
      const incident = DEMO_INCIDENTS[plan.index];
      if (!incident) continue;
      const order = plan.orderExternalId
        ? await single<{ id: string; title_id: string | null }>(
            tx,
            sql`select id, title_id from public.orders
                where organization_id = ${org} and data_source_id = ${master.dataSourceId}::uuid
                  and external_id = ${plan.orderExternalId}`,
            "Ordern till ärendet",
          )
        : null;
      await tx.execute(
        sql`insert into public.incidents
              (organization_id, machine_id, kind, started_at, ended_at, description, action_taken, status,
               assignee_id, order_id, title_id, refunded_ore, refunded_on, customer_contact)
            values (${org}, ${master.machineIds.get(plan.machineCode)}::uuid, ${incident.kind},
                    ${new Date(plan.startedAtMs).toISOString()}::timestamptz,
                    ${plan.endedAtMs === null ? null : new Date(plan.endedAtMs).toISOString()}::timestamptz,
                    ${incident.description}, ${incident.actionTaken}, ${incident.status},
                    ${incident.assignToOwner ? owner.id : null}::uuid, ${order?.id ?? null}::uuid,
                    ${order?.title_id ?? null}::uuid, ${plan.refundedOre}::bigint, ${plan.refundedOn}::date,
                    ${incident.customerContact})`,
      );
      sections.add("incidents", true);
    }
  });
}

/** Kör hela demoseeden. Se filhuvudet. */
export async function runDemoSeed(db: Db, options: RunDemoSeedOptions): Promise<RunDemoSeedResult> {
  const log = options.log ?? (() => {});
  const sections = new Sections();
  const large = options.large === true;
  const organization = large ? DEMO_ORGANIZATION_LARGE : DEMO_ORGANIZATION;
  const scale = large ? DEMO_LARGE_SCALE : 1;

  const started = Date.now();
  const gen = generateDemo({ scale });
  const revenueOre = gen.orders.reduce((n, o) => n + o.amountOre, 0);
  log(
    `Genererade ${gen.orders.length} order, ${gen.stockEvents.length} lagerhändelser och ` +
      `${gen.purchaseOrders.length} inköpsorder på ${Date.now() - started} ms.`,
  );

  const owner = await ensureUser(db, DEMO_USERS.owner, options, sections);
  const viewer = await ensureUser(db, DEMO_USERS.viewer, options, sections);
  const refiller = await ensureUser(db, DEMO_USERS.refiller, options, sections);
  const orgId = await ensureOrganization(db, organization, owner, sections);
  if (!large) {
    await ensureMember(db, orgId, owner, viewer, "viewer", sections);
    await ensureMember(db, orgId, owner, refiller, "refiller", sections);
  }
  log(`Organisation ${organization.slug} (${orgId}), användare klara.`);

  const master = await asActor(db, owner, (tx) =>
    ensureMasterData(tx, orgId, { owner, viewer: large ? null : viewer }, scale, sections),
  );
  log("Butiker, avtal, automater, titlar, priser, leverantörer, mål och släpp klara.");

  // Orderna: en Awish-export per månad, importerad som ägaren.
  const imports: RunDemoSeedResult["imports"] = [];
  for (const file of demoOrderFiles(gen.orders, large ? "-stor" : "")) {
    const sha = sha256Hex(file.bytes);
    const previous = await first<{ id: string }>(
      db,
      sql`select id from public.imports
          where organization_id = ${orgId}::uuid and data_source_id = ${master.dataSourceId}::uuid
            and file_sha256 = ${sha} and status = 'succeeded'
          limit 1`,
    );
    if (previous) {
      imports.push({ month: file.month, file: file.name, orders: file.orders, imported: null });
      continue;
    }
    const t0 = Date.now();
    const result = await runImport(db, {
      organizationId: orgId,
      dataSourceId: master.dataSourceId,
      actorUserId: owner.id,
      actorEmail: owner.email,
      file: { name: file.name, content: file.bytes },
      dryRun: false,
      fileStore: options.fileStore,
      rowLimit: 0,
    });
    if (result.summary.error > 0 || result.summary.conflict > 0) {
      throw new Error(
        `Importen av ${file.name} gav ${result.summary.error} fel och ${result.summary.conflict} konflikter. ` +
          "Har demogeneratorn ändrats sedan demon seedades? Kör npm run db:seed-demo -- --aterstall.",
      );
    }
    imports.push({
      month: file.month,
      file: file.name,
      orders: file.orders,
      imported: result.summary.new,
    });
    log(`Importerade ${file.name}: ${result.summary.new} nya order på ${Date.now() - t0} ms.`);
  }

  const stock = await ensureStockAndPurchasing(
    db,
    orgId,
    owner,
    large ? null : refiller,
    master,
    gen,
  );
  log(
    stock.stockEvents > 0
      ? `${stock.stockEvents} lagerhändelser och ${stock.purchaseOrders} inköpsorder skrivna.`
      : "Lager och inköp är redan seedade.",
  );

  const incidentPlans = planIncidents(gen.orders);
  await ensureIncidents(db, orgId, owner, master, incidentPlans, sections);
  await ensurePayouts(
    db,
    orgId,
    owner,
    master,
    demoPayoutFiles(gen.orders, incidentPlans),
    sections,
  );
  log("Kundärenden och utbetalningar klara.");

  // Larmen: larmjobbet utvärderar organisationen en gång vid demons "nu".
  let alerts: number | null = null;
  const runs = await first<{ n: number }>(
    db,
    sql`select count(*)::int as n from public.alert_runs where organization_id = ${orgId}::uuid`,
  );
  if ((runs?.n ?? 0) === 0) {
    const now = new Date(stockholmToUtcMs(DEMO_NOW.date, DEMO_NOW.time));
    const summary = await evaluateOrganization(db, orgId, now);
    if (summary.status === "failed") {
      throw new Error(`Larmjobbet misslyckades: ${summary.error ?? "okänt fel"}`);
    }
    alerts = summary.openIncidents;
    log(`Larmjobbet: ${summary.openIncidents} öppna larm.`);
  }

  const totals = await single<{ orders: number; revenue_ore: string }>(
    db,
    sql`select count(*)::int as orders, coalesce(sum(amount_ore), 0)::text as revenue_ore
        from public.orders where organization_id = ${orgId}::uuid`,
    "Summeringen",
  );

  return {
    organizationId: orgId,
    slug: organization.slug,
    dataSourceId: master.dataSourceId,
    users: { owner: owner.id, viewer: viewer.id, refiller: refiller.id },
    sections: sections.data,
    imports,
    stockEvents: stock.stockEvents,
    purchaseOrders: stock.purchaseOrders,
    alerts,
    generated: {
      orders: gen.orders.length,
      revenueOre,
      lostSales: gen.lostSales.length,
      stockoutDays: gen.stockoutDays,
    },
    totals: { orders: totals.orders, revenueOre: Number(totals.revenue_ore) },
  };
}

// ---------------------------------------------------------------------------
// Återställning
// ---------------------------------------------------------------------------

/**
 * Raderar demoorganisationen och allt i den (gallringsläget, som databasägare), så att
 * den kan seedas på nytt. Vägrar för allt utom demons egna slug. Användarna och de
 * importerade filerna på disk lämnas kvar. Null om organisationen inte finns.
 */
export async function resetDemo(
  db: Db,
  slug: string,
): Promise<{ organizationId: string; deleted: Record<string, number> } | null> {
  if (!DEMO_SLUGS.includes(slug)) {
    throw new Error(`Vägrar: ${slug} är inte en demoorganisation.`);
  }
  const org = await first<{ id: string; name: string }>(
    db,
    sql`select id, name from public.organizations where slug = ${slug}`,
  );
  if (!org) {
    return null;
  }
  if (!org.name.includes("(demo")) {
    throw new Error(`Vägrar: ${org.name} ser inte ut som en demoorganisation.`);
  }
  // Tabellerna med organization_id och beroendena mellan dem (barn före förälder).
  const tables = (
    await rows<{ table_name: string }>(
      db,
      sql`select c.table_name from information_schema.columns c
          join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name
          where c.table_schema = 'public' and c.column_name = 'organization_id'
            and t.table_type = 'BASE TABLE' and c.table_name <> 'organizations'`,
    )
  ).map((r) => r.table_name);
  const edges = await rows<{ child: string; parent: string }>(
    db,
    sql`select cl.relname as child, pl.relname as parent
        from pg_constraint c
        join pg_class cl on cl.oid = c.conrelid
        join pg_class pl on pl.oid = c.confrelid
        where c.contype = 'f' and c.connamespace = 'public'::regnamespace
          and c.confrelid <> c.conrelid`,
  );
  const remaining = new Set(tables);
  const order: string[] = [];
  while (remaining.size > 0) {
    const ready = [...remaining]
      .filter((t) => !edges.some((e) => e.parent === t && e.child !== t && remaining.has(e.child)))
      .sort();
    if (ready.length === 0) {
      throw new Error(`Cirkulära beroenden: ${[...remaining].join(", ")}`);
    }
    for (const t of ready) {
      remaining.delete(t);
      order.push(t);
    }
  }
  // Ändringsloggen sist: raderingarna ovan loggas i den.
  const deleteOrder = [...order.filter((t) => t !== "audit_log"), "audit_log"];
  const deleted: Record<string, number> = {};
  await db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('binderlab.allow_purge', 'on', true)`);
    for (const table of deleteOrder) {
      // Spärren "minst en ägare" gäller även gallringen; medlemskapen raderas därför
      // utan triggrar (alla rader som pekar på dem är redan borta).
      if (table === "memberships") {
        await tx.execute(sql`set local session_replication_role = replica`);
      }
      const result = await rows(
        tx,
        sql`delete from ${sql.identifier("public")}.${sql.identifier(table)}
            where organization_id = ${org.id}::uuid returning 1`,
      );
      if (table === "memberships") {
        await tx.execute(sql`set local session_replication_role = origin`);
      }
      if (result.length > 0) deleted[table] = result.length;
    }
    await tx.execute(sql`delete from public.audit_log where organization_id = ${org.id}::uuid`);
    await tx.execute(sql`delete from public.organizations where id = ${org.id}::uuid`);
  });
  return { organizationId: org.id, deleted };
}

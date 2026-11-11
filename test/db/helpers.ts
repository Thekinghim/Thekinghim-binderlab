/**
 * Hjälpfunktioner för databastesterna (test:db).
 *
 * Varje test skapar egna användare och organisationer med slumpade namn, så
 * testerna påverkar inte varandra och inget behöver städas.
 */

import { randomUUID } from "node:crypto";

import { eq, sql, type SQL } from "drizzle-orm";

import { getServiceDb, withRls, type Db, type Tx } from "../../src/db/client";
import * as s from "../../src/db/schema";
import type { MemberRole } from "../../src/db/schema";

export interface TestUser {
  id: string;
  email: string;
}

export type Row = Record<string, unknown>;

export type Outcome<T> =
  | { ok: true; value: T; code?: undefined; message?: undefined }
  | { ok: false; code: string; message: string; value?: undefined };

export const db = (): Db => getServiceDb();

// ---------------------------------------------------------------------------
// Frågor och fel
// ---------------------------------------------------------------------------

export async function rows<T extends Row = Row>(executor: Db | Tx, query: SQL): Promise<T[]> {
  const result = await executor.execute(query);
  return Array.from(result) as T[];
}

export async function one<T extends Row = Row>(executor: Db | Tx, query: SQL): Promise<T> {
  const result = await rows<T>(executor, query);
  const first = result[0];
  if (!first || result.length !== 1) {
    throw new Error(`Förväntade exakt en rad, fick ${result.length}`);
  }
  return first;
}

/** Postgres-felet (SQLSTATE) bakom ett fel från Drizzle/postgres.js. */
export function pgError(error: unknown): { code: string; message: string } | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth += 1) {
    if (
      typeof current === "object" &&
      current !== null &&
      "code" in current &&
      "severity" in current &&
      typeof (current as { code: unknown }).code === "string"
    ) {
      const e = current as { code: string; message?: string };
      return { code: e.code, message: e.message ?? "" };
    }
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/** Kör fn i en savepoint och returnerar utfallet i stället för att kasta. */
export async function attempt<T>(tx: Tx, fn: (sp: Tx) => Promise<T>): Promise<Outcome<T>> {
  try {
    const value = await tx.transaction(fn);
    return { ok: true, value };
  } catch (error) {
    const pg = pgError(error);
    if (!pg) {
      throw error;
    }
    return { ok: false, code: pg.code, message: pg.message };
  }
}

/** Kör fn (en hel transaktion) och returnerar utfallet i stället för att kasta. */
export async function settle<T>(promise: Promise<T>): Promise<Outcome<T>> {
  try {
    return { ok: true, value: await promise };
  } catch (error) {
    const pg = pgError(error);
    if (!pg) {
      throw error;
    }
    return { ok: false, code: pg.code, message: pg.message };
  }
}

/** Antal rader som påverkades av en update/delete via tx.execute. */
export async function affected(executor: Db | Tx, query: SQL): Promise<number> {
  const result = (await executor.execute(query)) as unknown as { count?: number };
  return result.count ?? 0;
}

// ---------------------------------------------------------------------------
// Roller
// ---------------------------------------------------------------------------

export function asUser<T>(user: TestUser, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return withRls({ sub: user.id, email: user.email }, fn);
}

/** Som Supabase service_role (kringgår RLS men inte triggers eller FK:er). */
export function asServiceRole<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db().transaction(async (tx) => {
    await tx.execute(sql`select set_config('request.jwt.claims', '{"role":"service_role"}', true)`);
    await tx.execute(sql`set local role service_role`);
    return fn(tx);
  });
}

/** Som anon (ej inloggad). */
export function asAnon<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db().transaction(async (tx) => {
    await tx.execute(sql`select set_config('request.jwt.claims', '{"role":"anon"}', true)`);
    await tx.execute(sql`set local role anon`);
    return fn(tx);
  });
}

/** Som databasägaren (postgres), det starkaste systemkontot. */
export function asPostgres<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db().transaction(fn);
}

/** Kör fn och rullar alltid tillbaka (för tester som ändrar delade data). */
export async function rollback<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  let result: T | undefined;
  const marker = new Error("rollback");
  try {
    await db().transaction(async (tx) => {
      result = await fn(tx);
      throw marker;
    });
  } catch (error) {
    if (error !== marker) {
      throw error;
    }
  }
  return result as T;
}

// ---------------------------------------------------------------------------
// Användare, organisationer, medlemskap
// ---------------------------------------------------------------------------

export function uniqueSuffix(): string {
  return randomUUID().slice(0, 8);
}

export async function createUser(
  email = `user-${uniqueSuffix()}@test.binderlab.se`,
): Promise<TestUser> {
  const row = await one<{ id: string }>(
    db(),
    sql`insert into auth.users (email, raw_user_meta_data)
        values (${email}, '{}'::jsonb) returning id`,
  );
  return { id: row.id, email };
}

export async function createOrg(owner: TestUser, name = "Testorganisation"): Promise<string> {
  const slug = `org-${uniqueSuffix()}`;
  const row = await asUser(owner, (tx) =>
    one<{ id: string }>(tx, sql`select public.create_organization(${name}, ${slug}) as id`),
  );
  return row.id;
}

/** Lägger till ett medlemskap (och profil) direkt som systemet. */
export async function addMember(orgId: string, user: TestUser, role: MemberRole): Promise<void> {
  await asPostgres(async (tx) => {
    await tx.insert(s.memberships).values({ organizationId: orgId, userId: user.id, role });
    await tx
      .insert(s.profiles)
      .values({
        organizationId: orgId,
        userId: user.id,
        displayName: user.email.split("@")[0] ?? "x",
      })
      .onConflictDoNothing();
  });
}

/** Skapar en användare med rollen i organisationen. */
export async function createMember(orgId: string, role: MemberRole): Promise<TestUser> {
  const user = await createUser(`${role}-${uniqueSuffix()}@test.binderlab.se`);
  await addMember(orgId, user, role);
  return user;
}

// ---------------------------------------------------------------------------
// Katalogen
// ---------------------------------------------------------------------------

export interface ColumnInfo {
  table: string;
  column: string;
  dataType: string;
  udtName: string;
  nullable: boolean;
  generated: boolean;
  identityAlways: boolean;
}

export async function publicTables(): Promise<string[]> {
  const result = await rows<{ name: string }>(
    db(),
    sql`select c.relname as name from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind in ('r', 'p')
        order by c.relname`,
  );
  return result.map((r) => r.name);
}

export async function publicViews(): Promise<string[]> {
  const result = await rows<{ name: string }>(
    db(),
    sql`select c.relname as name from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind in ('v', 'm')
        order by c.relname`,
  );
  return result.map((r) => r.name);
}

export async function publicColumns(): Promise<ColumnInfo[]> {
  const result = await rows<{
    table_name: string;
    column_name: string;
    data_type: string;
    udt_name: string;
    is_nullable: string;
    is_generated: string;
    identity_generation: string | null;
  }>(
    db(),
    sql`select table_name, column_name, data_type, udt_name, is_nullable, is_generated, identity_generation
        from information_schema.columns
        where table_schema = 'public'
        order by table_name, ordinal_position`,
  );
  return result.map((r) => ({
    table: r.table_name,
    column: r.column_name,
    dataType: r.data_type,
    udtName: r.udt_name,
    nullable: r.is_nullable === "YES",
    generated: r.is_generated === "ALWAYS",
    identityAlways: r.identity_generation === "ALWAYS",
  }));
}

/** Tabeller som har kolumnen organization_id. */
export async function orgScopedTables(): Promise<string[]> {
  const cols = await publicColumns();
  const tables = new Set(await publicTables());
  return [
    ...new Set(
      cols.filter((c) => c.column === "organization_id" && tables.has(c.table)).map((c) => c.table),
    ),
  ].sort();
}

/** En rad (som jsonb-objekt) ur tabellen för organisationen, läst som postgres. */
export async function sampleRow(
  table: string,
  orgId: string,
  where?: SQL,
): Promise<Row | undefined> {
  const orgColumn = table === "organizations" ? sql`id` : sql`organization_id`;
  const result = await rows<{ row: Row }>(
    db(),
    sql`select to_jsonb(t) as row from ${sql.identifier("public")}.${sql.identifier(table)} t
        where t.${orgColumn} = ${orgId} ${where ? sql`and ${where}` : sql``}
        limit 1`,
  );
  return result[0]?.row;
}

/**
 * SQL som infogar en kopia av `row` i tabellen, med ändringar i `overrides`.
 * Genererade kolumner och identity-kolumner hoppas över.
 */
export async function insertCopySql(table: string, row: Row, overrides: Row): Promise<SQL> {
  const cols = (await publicColumns()).filter(
    (c) => c.table === table && !c.generated && !c.identityAlways,
  );
  const merged = { ...row, ...overrides };
  const columnList = sql.join(
    cols.map((c) => sql.identifier(c.column)),
    sql`, `,
  );
  const target = sql`${sql.identifier("public")}.${sql.identifier(table)}`;
  return sql`insert into ${target} (${columnList})
             select ${columnList} from jsonb_populate_record(null::${target}, ${JSON.stringify(merged)}::jsonb)`;
}

export function rel(table: string): SQL {
  return sql`${sql.identifier("public")}.${sql.identifier(table)}`;
}

// ---------------------------------------------------------------------------
// Fixtur: en organisation med minst en rad i VARJE tabell
// ---------------------------------------------------------------------------

export interface TenantFixture {
  orgId: string;
  owner: TestUser;
  storeId: string;
  contractId: string;
  agreementId: string;
  machineId: string;
  machineLocationId: string;
  centralLocationId: string;
  titleId: string;
  secondTitleId: string;
  priceId: string;
  dataSourceId: string;
  sourceMachineId: string;
  importId: string;
  orderIds: string[];
  invitationToken: string;
}

/**
 * Skapar en ägare (om ingen anges) och en organisation med minst en rad i
 * varje tabell, skrivet som ägaren genom RLS. Datan ligger i 2025 och
 * december 2024 är stängd.
 */
export async function seedTenantFixture(ownerArg?: TestUser): Promise<TenantFixture> {
  const owner = ownerArg ?? (await createUser(`owner-${uniqueSuffix()}@test.binderlab.se`));
  const orgId = await createOrg(owner, `Fixtur ${uniqueSuffix()}`);
  // Butiksanvändaren (fas 10) tar emot en butiksinbjudan i fixturen (memberships.store_id).
  const storeUser = await createUser(`store-${uniqueSuffix()}@test.binderlab.se`);

  return asUser(owner, async (tx) => {
    const org = { organizationId: orgId };
    const [store] = await tx
      .insert(s.stores)
      .values({
        ...org,
        name: "ICA Testbutik",
        address: "Storgatan 1",
        contactName: "Anna",
        email: "anna@example.se",
      })
      .returning();
    const [contract] = await tx
      .insert(s.contracts)
      .values({ ...org, storeId: store!.id, validFrom: "2025-01-01" })
      .returning();
    // Avtalsfilen sätts bara via servern (20261102142000_ekonomi_review_fixes.sql).
    await tx.execute(
      sql`select public.attach_contract_file(${orgId}::uuid, ${contract!.id}::uuid,
            ${`${orgId}/${contract!.id}/${"d".repeat(64)}.pdf`}, 'avtal.pdf', 'application/pdf',
            1024::bigint, ${"d".repeat(64)})`,
    );
    const [agreement] = await tx
      .insert(s.storeAgreements)
      .values({
        ...org,
        storeId: store!.id,
        contractId: contract!.id,
        validFrom: "2025-01-01",
        commissionBp: 2000,
      })
      .returning();
    const [machine] = await tx
      .insert(s.machines)
      .values({ ...org, code: "BL-001", name: "Automat 1", activeFrom: "2025-01-01" })
      .returning();
    await tx
      .insert(s.machinePlacements)
      .values({ ...org, machineId: machine!.id, storeId: store!.id, validFrom: "2025-01-01" });
    await tx.insert(s.machineInvestments).values({
      ...org,
      machineId: machine!.id,
      kind: "purchase",
      amountOre: 2_500_000,
      investedOn: "2025-01-01",
      depreciationMonths: 36,
    });

    const [title, secondTitle, duplicateTitle] = await tx
      .insert(s.titles)
      .values([
        { ...org, name: "Pokémon 151 Booster", series: "Scarlet & Violet" },
        { ...org, name: "Surging Sparks Booster", series: "Scarlet & Violet" },
        { ...org, name: "Pokemon 151 booster pack", series: "Scarlet & Violet" },
      ])
      .returning();
    // En dubblett som slås ihop med den första (titles.merged_into_id blir satt).
    await tx.execute(
      sql`select public.merge_titles(${orgId}, ${duplicateTitle!.id}, ${title!.id})`,
    );
    await tx.insert(s.titleAliases).values({ ...org, titleId: title!.id, alias: "Pokemon 151" });
    const [price] = await tx
      .insert(s.purchasePrices)
      .values([
        { ...org, titleId: title!.id, unitCostOre: 4500, validFrom: "2025-01-01" },
        { ...org, titleId: secondTitle!.id, unitCostOre: 5200, validFrom: "2025-01-01" },
      ])
      .returning();

    const [source] = await tx
      .insert(s.dataSources)
      .values({ ...org, provider: "awish_csv", name: "Awish CSV" })
      .returning();
    const [sourceMachine] = await tx
      .insert(s.sourceMachines)
      .values({
        ...org,
        dataSourceId: source!.id,
        externalId: "AW-1",
        externalName: "Order Machine 1",
        machineId: machine!.id,
      })
      .returning();
    const [imp] = await tx
      .insert(s.imports)
      .values({
        ...org,
        dataSourceId: source!.id,
        trigger: "upload",
        fileName: "orders.csv",
        fileSha256: "a".repeat(64),
        storagePath: `${orgId}/imports/orders.csv`,
        parserVersion: "awish-csv@1",
        rowsTotal: 2,
        rowsNew: 2,
        status: "succeeded",
      })
      .returning();
    const insertedOrders = await tx
      .insert(s.orders)
      .values([
        {
          ...org,
          dataSourceId: source!.id,
          externalId: "42001",
          rawTitle: "Pokemon 151",
          titleId: title!.id,
          orderedAt: new Date("2025-03-10T10:00:00Z"),
          amountOre: 7900,
          paymentMethod: "card",
          sourceMachineId: sourceMachine!.id,
          machineId: machine!.id,
          importId: imp!.id,
          sourceHash: "h1",
        },
        {
          ...org,
          dataSourceId: source!.id,
          externalId: "42002",
          rawTitle: "Surging Sparks",
          titleId: secondTitle!.id,
          orderedAt: new Date("2025-03-11T10:00:00Z"),
          amountOre: 8900,
          paymentMethod: "swish",
          sourceMachineId: sourceMachine!.id,
          machineId: machine!.id,
          importId: imp!.id,
          sourceHash: "h2",
        },
      ])
      .returning();
    await tx.insert(s.importRows).values({
      ...org,
      importId: imp!.id,
      rowNumber: 1,
      raw: { "Order No.": "42001" },
      status: "new",
      orderId: insertedOrders[0]!.id,
    });

    const locations = await tx.select().from(s.stockLocations);
    const central = locations.find((l) => l.organizationId === orgId && l.isCentral);
    const machineLocation = locations.find(
      (l) => l.organizationId === orgId && l.machineId === machine!.id,
    );
    const transferGroupId = randomUUID();
    await tx.insert(s.stockEvents).values([
      {
        ...org,
        locationId: machineLocation!.id,
        titleId: title!.id,
        kind: "refill",
        quantity: 10,
        occurredAt: new Date("2025-03-01T08:00:00Z"),
      },
      {
        ...org,
        locationId: machineLocation!.id,
        titleId: title!.id,
        kind: "count",
        quantity: 10,
        occurredAt: new Date("2025-03-05T08:00:00Z"),
      },
      {
        ...org,
        locationId: central!.id,
        titleId: secondTitle!.id,
        kind: "transfer_out",
        quantity: -5,
        transferGroupId,
        occurredAt: new Date("2025-03-02T08:00:00Z"),
      },
      {
        ...org,
        locationId: machineLocation!.id,
        titleId: secondTitle!.id,
        kind: "transfer_in",
        quantity: 5,
        transferGroupId,
        occurredAt: new Date("2025-03-02T08:00:00Z"),
      },
    ]);

    const [supplier] = await tx
      .insert(s.suppliers)
      .values({ ...org, name: "Kortgrossisten AB", defaultLeadTimeDays: 7 })
      .returning();
    await tx.insert(s.supplierItems).values({
      ...org,
      supplierId: supplier!.id,
      titleId: title!.id,
      packSize: 36,
      minOrderQty: 1,
      unitCostOre: 4300,
    });
    const [po] = await tx
      .insert(s.purchaseOrders)
      .values({ ...org, supplierId: supplier!.id, status: "ordered", orderedOn: "2025-02-20" })
      .returning();
    const [line] = await tx
      .insert(s.purchaseOrderLines)
      .values({
        ...org,
        purchaseOrderId: po!.id,
        titleId: title!.id,
        quantity: 36,
        unitCostOre: 4300,
      })
      .returning();
    await tx
      .update(s.purchaseOrderLines)
      .set({ receivedQuantity: 36 })
      .where(sql`${s.purchaseOrderLines.id} = ${line!.id}`);

    await tx.insert(s.goals).values([
      { ...org, scope: "organization", month: "2025-03-01", metric: "revenue", target: 1_000_000 },
      {
        ...org,
        scope: "store",
        storeId: store!.id,
        month: "2025-03-01",
        metric: "profit",
        target: 300_000,
      },
      {
        ...org,
        scope: "machine",
        machineId: machine!.id,
        month: "2025-03-01",
        metric: "revenue",
        target: 500_000,
      },
    ]);
    await tx.insert(s.baselines).values([
      { ...org, scope: "organization", metric: "admin_hours_month", value: 600, unit: "minutes" },
      {
        ...org,
        scope: "store",
        storeId: store!.id,
        metric: "stockout_days_month",
        value: 2,
        unit: "days",
      },
      {
        ...org,
        scope: "machine",
        machineId: machine!.id,
        metric: "profit_per_machine_month",
        value: 250_000,
        unit: "ore",
      },
    ]);
    // Expansion och effekt (20261102121500_expansion_leads.sql).
    await tx.insert(s.expansionLeads).values([
      { ...org, name: "Ny plats", stage: "lead", storeType: "livs", city: "Malmö" },
      { ...org, name: "Andra automat", stage: "meeting", storeId: store!.id },
    ]);
    await tx.insert(s.effectMeasurements).values([
      {
        ...org,
        scope: "organization",
        metric: "admin_hours_month",
        month: "2025-03-01",
        value: 300,
      },
      {
        ...org,
        scope: "store",
        storeId: store!.id,
        metric: "stockout_days_month",
        month: "2025-03-01",
        value: 1,
      },
      {
        ...org,
        scope: "machine",
        machineId: machine!.id,
        metric: "refill_hours_month",
        month: "2025-03-01",
        value: 120,
      },
    ]);
    await tx.insert(s.effectSettings).values({ ...org, hourlyCostOre: 25_000 });
    // Ekonomi (20261102121731_ekonomi_payouts_costs_contracts.sql).
    const [payoutImport] = await tx
      .insert(s.payoutImports)
      .values({
        ...org,
        dataSourceId: source!.id,
        fileName: "utbetalningar.csv",
        fileSha256: "b".repeat(64),
        storagePath: `${orgId}/payouts/${"b".repeat(64)}.csv`,
        format: "payouts",
        rowsTotal: 1,
        rowsNew: 1,
      })
      .returning();
    const [payout] = await tx
      .insert(s.payouts)
      .values({
        ...org,
        dataSourceId: source!.id,
        importId: payoutImport!.id,
        reference: "U-2025-03",
        periodStart: "2025-03-01",
        periodEnd: "2025-03-31",
        paidOn: "2025-04-05",
        amountOre: 16_800,
        feesOre: 0,
        sourceHash: "c".repeat(64),
      })
      .returning();
    await tx.insert(s.payoutLines).values({
      ...org,
      payoutId: payout!.id,
      importId: payoutImport!.id,
      externalId: "42001",
      amountOre: 7900,
    });
    await tx.insert(s.deviationReviews).values({
      ...org,
      deviationKey: "U-2025-03:fee",
      fingerprint: "fee:0:0",
      action: "investigated",
      note: "Kontrollerad mot Awish.",
    });
    await tx.insert(s.voucherDeliveries).values({
      ...org,
      month: "2025-03-01",
      provider: "local",
      series: "BL",
      firstNumber: 1,
      lastNumber: 31,
      verificationCount: 31,
      fileSha256: "e".repeat(64),
    });
    // Bokföring (20261103210000_bokforing.sql): kontoplan, skickad månad och ett kvitto.
    await tx.execute(
      sql`insert into public.bookkeeping_settings (organization_id, account_plan) values (${orgId}::uuid, '{}'::jsonb)`,
    );
    await tx.execute(
      sql`insert into public.bookkeeping_months (organization_id, month, sent_at, snapshot) values (${orgId}::uuid, '2025-03-01', now(), '{}'::jsonb)`,
    );
    await tx.execute(
      sql`insert into public.bookkeeping_receipts (organization_id, month, storage_path, file_name, content_type, size_bytes, file_sha256)
          values (${orgId}::uuid, '2025-03-01', ${`${orgId}/2025-03/${"d".repeat(64)}.pdf`}, 'kvitto.pdf', 'application/pdf', 100, ${"d".repeat(64)})`,
    );
    await tx.insert(s.fixedCosts).values({
      ...org,
      name: "Försäkring",
      category: "insurance",
      amountOre: 120_000,
      interval: "year",
      startsOn: "2025-01-01",
      machineId: machine!.id,
    });

    const [recipient] = await tx
      .insert(s.reportRecipients)
      .values({
        ...org,
        name: "Butikschef",
        email: "chef@example.se",
        kind: "store",
        storeId: store!.id,
      })
      .returning();
    const [report] = await tx
      .insert(s.reports)
      .values({
        ...org,
        kind: "store_statement",
        periodStart: "2025-03-01",
        periodEnd: "2025-03-31",
        storeId: store!.id,
        storagePath: `${orgId}/reports/2025-03.pdf`,
        dataSnapshot: { revenueOre: 16_800 },
        calcVersion: "calc@1",
      })
      .returning();
    // PDF:en är sparad (report_files) och rapporten godkänd; ett utskick kräver ett
    // godkännande (20261102145500_rapporter_review_fixes.sql).
    await tx.insert(s.reportFiles).values({
      ...org,
      reportId: report!.id,
      kind: "pdf",
      storagePath: `${orgId}/reports/2025-03.pdf`,
      byteSize: 1024,
    });
    await tx
      .insert(s.reportApprovals)
      .values({ ...org, reportId: report!.id, approvedBy: owner.id });
    await tx.insert(s.reportDeliveries).values({
      ...org,
      reportId: report!.id,
      recipientId: recipient!.id,
      email: "chef@example.se",
      status: "sent",
      sentAt: new Date("2025-04-01T07:00:00Z"),
    });

    await tx.insert(s.ownerShares).values({
      ...org,
      memberUserId: owner.id,
      holderName: "Ägaren",
      shareBp: 10_000,
      validFrom: "2025-01-01",
    });
    await tx
      .insert(s.ledgerAccounts)
      .values({ ...org, key: "sales", basAccount: "3001", name: "Försäljning" });
    // Larm skrivs bara av larmjobbet (systemrollen) sedan fas 8
    // (20261102122143_drift_larm_arenden.sql): raden läggs in som postgres i samma transaktion.
    await tx.execute(sql`set local role postgres`);
    await tx.insert(s.alerts).values({
      ...org,
      kind: "low_stock",
      severity: "warning",
      machineId: machine!.id,
      storeId: store!.id,
      titleId: title!.id,
      message: "Lågt lager",
    });
    // Drift: ägarens larminställningar, en push-enhet, ett skickat utskick, en körning av
    // larmjobbet och en påfyllning från fältet (skrivs i appen via RPC eller av jobbet).
    await tx.insert(s.alertSubscriptions).values({ ...org, userId: owner.id, channels: ["email"] });
    await tx.insert(s.pushSubscriptions).values({
      ...org,
      userId: owner.id,
      endpoint: `https://fcm.googleapis.com/fcm/send/${randomUUID()}`,
      p256dh: "p".repeat(40),
      authSecret: "a".repeat(16),
    });
    await tx.insert(s.alertDeliveries).values({
      ...org,
      userId: owner.id,
      sendAt: new Date("2025-03-12T09:00:00Z"),
      status: "sent",
      subject: "Lågt lager",
      items: [],
      sentAt: new Date("2025-03-12T09:00:00Z"),
    });
    await tx
      .insert(s.alertRuns)
      .values({ ...org, ranAt: new Date("2025-03-12T09:00:00Z"), status: "ok" });
    const [refill] = await rows<{ id: string }>(
      tx,
      sql`select id from public.stock_events where organization_id = ${orgId}::uuid and kind = 'refill' limit 1`,
    );
    await tx.insert(s.fieldSubmissions).values({
      ...org,
      clientId: randomUUID(),
      machineId: machine!.id,
      titleId: title!.id,
      quantity: 10,
      fromWarehouse: false,
      occurredAt: new Date("2025-03-01T08:00:00Z"),
      stockEventId: refill!.id,
      submittedBy: owner.id,
    });
    // Flera lager (20261104210000_flera_lager.sql): en påfyllning från standardlagret och
    // automatens "Fylls på från".
    const [home] = await rows<{ id: string }>(
      tx,
      sql`select id from public.stock_locations
          where organization_id = ${orgId}::uuid and kind = 'warehouse' and is_central limit 1`,
    );
    await tx.insert(s.fieldSubmissions).values({
      ...org,
      clientId: randomUUID(),
      machineId: machine!.id,
      titleId: title!.id,
      quantity: 1,
      fromWarehouse: true,
      occurredAt: new Date("2025-03-01T08:05:00Z"),
      stockEventId: refill!.id,
      submittedBy: owner.id,
      fromLocationId: home!.id,
    });
    await tx.execute(sql`
      update public.stock_locations set refill_source_id = ${home!.id}::uuid
      where organization_id = ${orgId}::uuid and kind = 'machine' and machine_id = ${machine!.id}::uuid`);
    await tx.execute(sql`set local role authenticated`);
    // Ärendet gäller en order och titel från automaten (incidents.order_id/title_id).
    await tx.insert(s.incidents).values({
      ...org,
      machineId: machine!.id,
      kind: "jam",
      startedAt: new Date("2025-03-12T09:00:00Z"),
      orderId: insertedOrders[0]!.id,
      titleId: title!.id,
    });
    // Assistent (20261102124000_assistent_assistant_logs.sql): ägarens fråga. Raden skrivs
    // bara via private.insert_assistant_log (20261102134800_…_hardening.sql), inte med INSERT.
    await tx.execute(sql`
      select private.insert_assistant_log(
        ${orgId}::uuid, ${randomUUID()}::uuid, 'owner'::public.member_role,
        'Vilken automat tjänade mest i mars?', 'Automat 1 (BL-001).', 'answered',
        'local', 'lokal-testmodell', '[]'::jsonb, '{}'::jsonb, '{}'::jsonb, null, 0
      )`);
    // Marknad (20261102122500_marknad_market_intelligence.sql): ett släpp med fastställd
    // fördelning, ett leverantörspris, fackfördelning, en genomförd sortimentsändring och
    // ett pristest.
    const [release] = await tx
      .insert(s.releases)
      .values({
        ...org,
        name: "Surging Sparks",
        series: "Scarlet & Violet",
        releaseDate: "2025-03-20",
        titleId: secondTitle!.id,
        supplierId: supplier!.id,
        planLockedAt: new Date("2025-03-15T10:00:00Z"),
        planPurchaseUnits: 36,
        planCurveBp: [5000, 10_000],
        planSnapshot: { text: "Förslag" },
      })
      .returning();
    await tx.insert(s.releaseAllocations).values({
      ...org,
      releaseId: release!.id,
      machineId: machine!.id,
      units: 24,
      suggestedUnits: 24,
    });
    await tx.insert(s.supplierPriceQuotes).values({
      ...org,
      supplierId: supplier!.id,
      titleId: title!.id,
      quotedOn: "2025-02-15",
      unitCostOre: 4400,
      quantity: 36,
    });
    await tx.insert(s.machineSlots).values({
      ...org,
      machineId: machine!.id,
      titleId: title!.id,
      slots: 3,
      validFrom: "2025-01-01",
    });
    // Lager (20261103160000_lager_larmgrans.sql): larmgräns för titeln i automaten.
    await tx.insert(s.slotAlerts).values({
      ...org,
      machineId: machine!.id,
      titleId: title!.id,
      alertAtUnits: 0,
    });
    // Fyllnadsgrad (20261104163000_fack_kapacitet.sql): kapacitet från Awish. Bara synken
    // (databasägaren) skriver tabellen.
    await tx.execute(sql`set local role postgres`);
    await tx.insert(s.machineSlotCapacity).values({
      ...org,
      machineId: machine!.id,
      titleId: title!.id,
      capacity: 12,
      channels: ["A1", "A2"],
      syncedAt: new Date("2025-03-01T10:00:00Z"),
    });
    await tx.execute(sql`set local role authenticated`);
    await tx.insert(s.assortmentChanges).values({
      ...org,
      machineId: machine!.id,
      implementedOn: "2025-03-01",
      recommendationKey: `assortment:${machine!.id}`,
      fingerprint: `${title!.id}:3`,
      expectedEffectPerWeekOre: 2500,
      changedTitleIds: [title!.id],
    });
    const [experiment] = await tx
      .insert(s.priceExperiments)
      .values({
        ...org,
        titleId: title!.id,
        proposalKey: `price-test:${title!.id}:up:2025-03-01`,
        direction: "up",
        fromOre: 7900,
        toOre: 8400,
        startedOn: "2025-03-01",
        testDays: 28,
      })
      .returning();
    await tx.insert(s.priceExperimentMachines).values({
      ...org,
      experimentId: experiment!.id,
      machineId: machine!.id,
      arm: "test",
    });
    // Att göra (20261102113602_att_gora_todo_dismissals.sql): en avbockad lagerpunkt (som
    // påfyllaren får se) och en avbockad prispunkt (som påfyllaren inte får se).
    // Managerpaket (20261104170000_managerpaket_ansvar.sql): en tilldelad lagerpunkt och en
    // prispunkt (som påfyllaren inte får se), och ägaren som ansvarig för automaten.
    await tx.insert(s.todoAssignments).values([
      { ...org, todoKey: `refill:${machine!.id}:${title!.id}`, assignedTo: owner.id },
      { ...org, todoKey: `missing-price:${secondTitle!.id}`, assignedTo: null },
    ]);
    await tx
      .update(s.machines)
      .set({ responsibleUserId: owner.id })
      .where(eq(s.machines.id, machine!.id));
    await tx.insert(s.todoDismissals).values([
      {
        ...org,
        todoKey: `refill:${machine!.id}:${title!.id}`,
        fingerprint: "slut:0",
        title: "Fyll på Pokémon 151 Booster i Automat 1",
      },
      {
        ...org,
        todoKey: `missing-price:${secondTitle!.id}`,
        fingerprint: "orders:2",
        title: "Lägg in inköpspris för Surging Sparks Booster",
      },
    ]);
    // Datakällor (20261102133644_datakallor_import_uploads.sql): ägarens pågående uppladdning
    // med en mottagen bit. Raderna syns bara för den som laddade upp.
    const [upload] = await tx
      .insert(s.importUploads)
      .values({ ...org, fileName: "orders.csv", sizeBytes: 3, receivedBytes: 3, nextIndex: 1 })
      .returning();
    await tx.insert(s.importUploadChunks).values({
      ...org,
      uploadId: upload!.id,
      chunkIndex: 0,
      data: Buffer.from("abc"),
    });
    // Awish Chrome-tillägget (borttaget; tabellen från 20261102235600_tillagg_sync_tokens.sql
    // ligger kvar och skyddas fortfarande av RLS): en datakälla av typen
    // awish_extension med en synk-token (bara hashen sparas). Källan arkiveras efteråt, så att
    // den inte räknas som en källa eller ger larm om utebliven hämtning i andra tester.
    const [extensionSource] = await tx
      .insert(s.dataSources)
      .values({
        ...org,
        provider: "awish_extension",
        name: "Awish via Chrome-tillägg",
        sourceTimezone: "Asia/Shanghai",
      })
      .returning();
    await tx.insert(s.syncTokens).values({
      ...org,
      dataSourceId: extensionSource!.id,
      name: "Kontorsdatorn",
      tokenHash: randomUUID().replace(/-/g, "").repeat(2),
      tokenPrefix: "blsync_Test",
    });
    await tx.execute(
      sql`update public.data_sources set archived_at = now() where id = ${extensionSource!.id}::uuid`,
    );
    // Butiksportalen (20261102130100_portal_store_access.sql): butiksanvändaren tar emot en
    // butiksinbjudan med samtycke (accept_invitation som butiksanvändaren i samma transaktion).
    const storeInvitation = await one<{ token: string }>(
      tx,
      sql`select public.create_store_invitation(${orgId}::uuid, ${store!.id}::uuid, ${storeUser.email}) as token`,
    );
    const claimsFor = (user: TestUser) =>
      JSON.stringify({
        sub: user.id,
        email: user.email,
        role: "authenticated",
        aud: "authenticated",
      });
    await tx.execute(sql`select set_config('request.jwt.claims', ${claimsFor(storeUser)}, true)`);
    await tx.execute(sql`select public.accept_invitation(${storeInvitation.token})`);
    await tx.execute(sql`select set_config('request.jwt.claims', ${claimsFor(owner)}, true)`);

    const invitation = await one<{ token: string }>(
      tx,
      sql`select public.create_invitation(${orgId}, ${`invited-${uniqueSuffix()}@test.binderlab.se`}, 'viewer') as token`,
    );
    await tx.execute(sql`select public.close_period(${orgId}, '2024-12-01'::date)`);
    // Mystery packs (20261115000000_mystery_packs.sql): en egen produkt med innehåll (en
    // version) och en packning. Egna titlar, så att fixturens övriga saldon inte ändras.
    const [mystery, mysteryPart] = await tx
      .insert(s.titles)
      .values([
        { ...org, name: "Fixtur Mystery Pack", ownProduct: true },
        { ...org, name: "Fixtur Booster" },
      ])
      .returning();
    await tx.insert(s.purchasePrices).values([
      { ...org, titleId: mystery!.id, unitCostOre: 4500, validFrom: "2025-01-01" },
      { ...org, titleId: mysteryPart!.id, unitCostOre: 4500, validFrom: "2025-01-01" },
    ]);
    await tx.insert(s.stockEvents).values({
      ...org,
      locationId: central!.id,
      titleId: mysteryPart!.id,
      kind: "receipt",
      quantity: 1,
    });
    const recipe = await one<{ id: string }>(
      tx,
      sql`select public.save_mystery_recipe(${orgId}::uuid, ${mystery!.id}::uuid, 1,
            ${JSON.stringify([{ titleId: mysteryPart!.id, quantity: 1, hit: true }])}::jsonb) as id`,
    );
    await tx.execute(
      sql`select * from public.pack_mystery(${orgId}::uuid, gen_random_uuid(), ${mystery!.id}::uuid,
            ${central!.id}::uuid, 1, ${recipe.id}::uuid)`,
    );
    // Inventering (20261121000000_inventering.sql): en sparad inventering av standardlagret.
    // Fixturens egen titel räknas till det saldo den redan har (0), så inget saldo ändras.
    await tx.execute(
      sql`select * from public.save_stock_count(${orgId}::uuid, gen_random_uuid(),
            ${central!.id}::uuid,
            ${JSON.stringify([{ titleId: mysteryPart!.id, counted: 0 }])}::jsonb)`,
    );
    // AI-rådgivaren (20261104090000_ai_radgivare.sql): bara servern skriver körningar och
    // förslag, så raderna skrivs som databasägaren i samma transaktion.
    await tx.execute(sql`reset role`);
    const aiRun = await one<{ id: string }>(
      tx,
      sql`insert into public.ai_runs (organization_id, trigger, status, model, accepted)
          values (${orgId}, 'cron', 'ok', 'claude-sonnet-5-5', 1) returning id`,
    );
    await tx.execute(
      sql`insert into public.ai_suggestions
            (organization_id, run_id, rank, title, why, action, effect_sek_month, confidence)
          values (${orgId}, ${aiRun.id}, 1, 'Fyll på', 'Titeln har 2 pack kvar.', 'Fyll på i dag.', 100, 'high')`,
    );
    // Morgonbriefen (20261104180000_morgonbrief.sql): bara servern skriver.
    await tx.execute(
      sql`insert into public.ai_briefs
            (organization_id, brief_date, trigger, status, model, line_yesterday, line_problem, line_today)
          values (${orgId}, '2025-03-12', 'cron', 'ok', 'claude-sonnet-5-5',
                  '1 240 kr på 31 köp.', 'Inget akut.', 'Fyll på BL-002.')`,
    );
    // Bokföring (20261104130000_bokforing_paket.sql): bara servern sparar månadspaketet.
    await tx.execute(
      sql`insert into public.bookkeeping_packages
            (organization_id, month, version, status, fingerprint, storage_path, file_name,
             size_bytes, file_sha256)
          values (${orgId}, '2025-03-01', 1, 'final', ${"a".repeat(64)},
                  ${`${orgId}/2025-03/v1-${"b".repeat(64)}.zip`}, 'bokforing-2025-03.zip', 100,
                  ${"b".repeat(64)})`,
    );
    // Kampanjer och gratis-pack (20261104233100_kampanjer_gratis_pack.sql): bara servern skriver.
    const campaign = await one<{ id: string }>(
      tx,
      sql`insert into public.campaigns
            (organization_id, title, title_id, image_path, image_url, image_type, image_bytes, starts_at, ends_at)
          values (${orgId}, 'Nytt', ${title!.id}, ${`${orgId}/${"c".repeat(64)}.png`}, 'https://example.test/k.png',
                  'image/png', 100, '2025-03-01T00:00:00Z', '2025-03-15T00:00:00Z')
          returning id`,
    );
    await tx.execute(
      sql`insert into public.campaign_machines
            (organization_id, campaign_id, machine_id, awish_machine_id, awish_banner_id, status)
          values (${orgId}, ${campaign.id}, ${machine!.id}, '2', '7', 'shown')`,
    );
    const freePack = await one<{ id: string }>(
      tx,
      sql`insert into public.free_pack_batches
            (organization_id, machine_id, title_id, good_name, awish_machine_id, awish_product_id,
             quantity, reason, unit_cost_ore, cost_ore, business_date, expires_at, status)
          values (${orgId}, ${machine!.id}, ${title!.id}, 'Testtitel', '2', '1', 1, 'giveaway',
                  4500, 4500, '2025-03-02', '2025-03-16T00:00:00Z', 'created')
          returning id`,
    );
    await tx.execute(
      sql`insert into public.free_pack_codes (organization_id, batch_id, code, awish_code_id)
          values (${orgId}, ${freePack.id}, 'K7Q2M9XA', '901')`,
    );
    // Signering på plats (20261104233200_avtal_signering.sql): bara servern skriver. Ett eget
    // avtal, så att huvudavtalet går att ändra (ett signerat avtal byter inte fil).
    const [signedContract] = await tx
      .insert(s.contracts)
      .values({ ...org, storeId: store!.id, validFrom: "2025-01-01", title: "Signerat" })
      .returning();
    const signingLink = await one<{ id: string }>(
      tx,
      sql`insert into public.contract_signing_links
            (organization_id, contract_id, token_hash, document_sha256, expires_at, used_at)
          values (${orgId}, ${signedContract!.id}, ${randomUUID().replace(/-/g, "").repeat(2)},
                  ${"d".repeat(64)}, now() + interval '7 days', now())
          returning id`,
    );
    await tx.execute(
      sql`insert into public.contract_signatures
            (organization_id, contract_id, link_id, signer_name, signature_png, document_sha256,
             ip, user_agent)
          values (${orgId}, ${signedContract!.id}, ${signingLink.id}, 'Anna Testsson',
                  decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'),
                  ${"d".repeat(64)}, '127.0.0.1', 'vitest')`,
    );
    // Månadsavräkning per butik (20261104233400_butik_avrakning.sql).
    await tx.execute(
      sql`insert into public.store_settlements
            (organization_id, store_id, month, amount_ore, statement, calc_version)
          values (${orgId}, ${store!.id}, '2025-03-01', 3360,
                  '{"version":1,"storeName":"Testbutik","month":"2025-03","modelText":"Provision","steps":[],"salesInclVatOre":16800,"orders":2,"totalOre":3360}'::jsonb,
                  'calc@1')`,
    );
    // Plan för fler automater (20261104233300_tillvaxt_plan.sql).
    await tx.execute(
      sql`insert into public.growth_plans
            (organization_id, target_machines, machine_price_ore, people, hours_per_person_week)
          values (${orgId}, 20, 3000000, 2, 10)`,
    );
    // Värde: logg över automatiskt arbete (20261111000000_varde.sql), skrivs bara av servern.
    await tx.execute(
      sql`insert into public.automation_log (organization_id, kind, machine_id, units)
          values (${orgId}, 'awish_push', ${machine!.id}, 3)`,
    );
    // Logg över "Exportera all data" (20261111020100_granskning_dataexport.sql).
    await tx.execute(sql`insert into public.data_exports (organization_id) values (${orgId})`);
    // Daglig kontroll (20261114000000_daglig_kontroll.sql), skrivs bara av servern.
    await tx.execute(
      sql`insert into public.self_check_runs (organization_id, trigger, status, checks)
          values (${orgId}, 'schedule', 'ok', '[]'::jsonb)`,
    );
    // Veckosammanfattning (20261123000000_veckosammanfattning.sql), skrivs bara av servern.
    await tx.execute(
      sql`insert into public.weekly_summaries
            (organization_id, user_id, week_start, status, locale, title, body, url)
          values (${orgId}, ${owner.id}, '2025-03-03', 'sent', 'sv',
                  'Förra veckan: 2 pack, 68 kr vinst', 'Veckan innan: inget sålt.',
                  '/veckan?v=2025-03-03')`,
    );
    await tx.execute(sql`set local role authenticated`);

    return {
      orgId,
      owner,
      storeId: store!.id,
      contractId: contract!.id,
      agreementId: agreement!.id,
      machineId: machine!.id,
      machineLocationId: machineLocation!.id,
      centralLocationId: central!.id,
      titleId: title!.id,
      secondTitleId: secondTitle!.id,
      priceId: price!.id,
      dataSourceId: source!.id,
      sourceMachineId: sourceMachine!.id,
      importId: imp!.id,
      orderIds: insertedOrders.map((o) => o.id),
      invitationToken: invitation.token,
    };
  });
}

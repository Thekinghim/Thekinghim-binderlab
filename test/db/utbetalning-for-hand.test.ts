/**
 * T5-3, Ekonomi utan fil, mot testdatabasen: "Vad betalade Awish?". Frågan gäller nästa
 * period utan utbetalning, svaret sparas som en rad i payouts (manual = true), räknas som
 * källa för utbetalningar (payoutsTracked) och avstämningen visar väntat minus utbetalt.
 * Bara ägare och admin, dagar som redan har en utbetalning nekas, och raden går inte att
 * ändra, bara arkivera.
 */

import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import * as s from "@/db/schema";
import { AuthorizationError, listOrganizationsFor } from "@/server/access";
import {
  AccountingError,
  addManualPayoutFor,
  archivePayoutFor,
  loadCashflowFor,
  loadPayoutQuestionFor,
  loadReconciliationFor,
  payoutExpectationFor,
} from "@/server/accounting/service";
import type { Viewer } from "@/server/data/core/loaders";

import {
  asUser,
  attempt,
  createMember,
  createOrg,
  createUser,
  db,
  rows,
  uniqueSuffix,
  type TestUser,
} from "./helpers";

const APRIL = { start: "2025-04-01", end: "2025-04-30" };
const TODAY = "2025-05-05";

let orgId: string;
let ownerUser: TestUser;
let owner: Viewer;
let admin: Viewer;
let reader: Viewer;
let refiller: Viewer;
let orderBase: Omit<typeof s.orders.$inferInsert, "externalId" | "orderedAt" | "sourceHash">;

async function viewerFor(u: TestUser): Promise<Viewer> {
  const user = { userId: u.id, email: u.email };
  const organization = (await listOrganizationsFor(user)).find((o) => o.id === orgId);
  if (!organization) throw new Error("Saknar medlemskap");
  return { user, organization };
}

const payoutRows = () =>
  rows<{
    reference: string;
    amount_ore: string;
    fees_ore: string;
    refunds_ore: string | null;
    manual: boolean;
    paid_on: string;
    source_hash: string;
    archived: boolean;
    import_id: string | null;
  }>(
    db(),
    sql`select reference, amount_ore::text, fees_ore::text, refunds_ore::text, manual,
               paid_on::text, source_hash, archived_at is not null as archived, import_id
        from public.payouts where organization_id = ${orgId}::uuid order by created_at`,
  );

beforeAll(async () => {
  ownerUser = await createUser(`hand-agare-${uniqueSuffix()}@test.binderlab.se`);
  orgId = await createOrg(ownerUser, `För hand ${uniqueSuffix()}`);
  owner = await viewerFor(ownerUser);
  admin = await viewerFor(await createMember(orgId, "admin"));
  reader = await viewerFor(await createMember(orgId, "viewer"));
  refiller = await viewerFor(await createMember(orgId, "refiller"));
  await asUser(ownerUser, async (tx) => {
    const org = { organizationId: orgId };
    const [machine] = await tx
      .insert(s.machines)
      .values({ ...org, code: "BL-001", name: "Automat 1", activeFrom: "2025-01-01" })
      .returning();
    const [title] = await tx
      .insert(s.titles)
      .values({ ...org, name: "Pokémon 151" })
      .returning();
    await tx
      .insert(s.purchasePrices)
      .values({ ...org, titleId: title!.id, unitCostOre: 2000, validFrom: "2025-01-01" });
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
        fileSha256: "b".repeat(64),
        storagePath: `${orgId}/imports/orders.csv`,
        parserVersion: "awish-csv@1",
        status: "succeeded",
      })
      .returning();
    orderBase = {
      ...org,
      dataSourceId: source!.id,
      rawTitle: "Pokemon 151",
      titleId: title!.id,
      amountOre: 4900,
      sourceMachineId: sourceMachine!.id,
      machineId: machine!.id,
      importId: imp!.id,
    };
    // Tio order à 49,00 kr 1–10 april, mitt på dagen.
    await tx.insert(s.orders).values(
      Array.from({ length: 10 }, (_, i) => ({
        ...orderBase,
        externalId: String(70001 + i),
        orderedAt: new Date(`2025-04-${String(i + 1).padStart(2, "0")}T10:00:00Z`),
        sourceHash: `hand-${i}`,
      })),
    );
  });
});

describe("frågan", () => {
  it("utan utbetalningar: förra månaden, med det försäljningen ger", async () => {
    const q = await loadPayoutQuestionFor(owner, TODAY);
    expect(q?.period).toEqual(APRIL);
    expect(q?.expected).toMatchObject({ orders: 10, salesOre: 49_000 });
    expect(q!.expected.payoutOre).toBe(
      q!.expected.salesOre - q!.expected.feesOre - q!.expected.refundsOre,
    );
    expect((await loadCashflowFor(owner, TODAY)).payoutsTracked).toBe(false);
  });

  it("ingen fråga för en månad utan försäljning", async () => {
    // I april är förra månaden mars, och där såldes inget.
    expect(await loadPayoutQuestionFor(owner, "2025-04-20")).toBeNull();
  });

  it("läsaren och påfyllaren får varken frågan eller spara ett svar", async () => {
    for (const v of [reader, refiller]) {
      await expect(loadPayoutQuestionFor(v, TODAY)).rejects.toBeInstanceOf(AuthorizationError);
      await expect(
        addManualPayoutFor(v, { period: APRIL, amountOre: 49_000, paidOn: "2025-05-02" }, TODAY),
      ).rejects.toBeInstanceOf(AuthorizationError);
      await expect(payoutExpectationFor(v, APRIL, TODAY)).rejects.toBeInstanceOf(
        AuthorizationError,
      );
    }
    const insert = await asUser({ id: reader.user.userId, email: reader.user.email }, (tx) =>
      attempt(tx, (sp) =>
        sp.execute(sql`insert into public.payouts
            (organization_id, reference, period_start, period_end, amount_ore, source_hash, manual)
          values (${orgId}::uuid, 'Egen', '2025-04-01', '2025-04-30', 1, ${"c".repeat(64)}, true)`),
      ),
    );
    expect(insert.ok).toBe(false);
    expect(await payoutRows()).toEqual([]);
  });

  it("en egen period räknas om; en period som inte är slut nekas", async () => {
    const q = await payoutExpectationFor(owner, { start: "2025-04-01", end: "2025-04-05" }, TODAY);
    expect(q.expected).toMatchObject({ orders: 5, salesOre: 24_500 });
    await expect(
      payoutExpectationFor(owner, { start: "2025-05-01", end: TODAY }, TODAY),
    ).rejects.toBeInstanceOf(AccountingError);
  });
});

describe("svaret", () => {
  let expectedOre: number;

  it("ogiltiga svar sparar ingenting", async () => {
    const bad = [
      { period: APRIL, amountOre: 0, paidOn: "2025-05-02" },
      { period: APRIL, amountOre: -100, paidOn: "2025-05-02" },
      { period: APRIL, amountOre: 49_000.5, paidOn: "2025-05-02" },
      { period: APRIL, amountOre: 49_000, paidOn: "2025-05-06" },
      { period: APRIL, amountOre: 49_000, paidOn: "2025-03-31" },
      { period: { start: "2025-04-30", end: "2025-04-01" }, amountOre: 49_000, paidOn: TODAY },
      { period: { start: "2025-05-01", end: TODAY }, amountOre: 49_000, paidOn: TODAY },
    ];
    for (const input of bad) {
      await expect(addManualPayoutFor(owner, input, TODAY)).rejects.toBeInstanceOf(AccountingError);
    }
    expect(await payoutRows()).toEqual([]);
  });

  it("61,20 kr för lite: raden sparas och avstämningen visar skillnaden som en avvikelse", async () => {
    expectedOre = (await loadPayoutQuestionFor(owner, TODAY))!.expected.payoutOre;
    const saved = await addManualPayoutFor(
      admin,
      { period: APRIL, amountOre: expectedOre - 6_120, paidOn: "2025-05-02" },
      TODAY,
    );
    expect(saved).toMatchObject({
      reference: "Inskriven 2025-04",
      expectedOre,
      differenceOre: -6_120,
      matches: false,
    });
    const [row] = await payoutRows();
    expect(row).toMatchObject({
      reference: "Inskriven 2025-04",
      amount_ore: String(expectedOre - 6_120),
      fees_ore: "0",
      refunds_ore: null,
      manual: true,
      paid_on: "2025-05-02",
      archived: false,
      import_id: null,
    });
    expect(row!.source_hash).toMatch(/^[0-9a-f]{64}$/);

    // Raden räknas som källa för utbetalningar, och avstämningen visar väntat minus utbetalt.
    expect((await loadCashflowFor(owner, TODAY)).payoutsTracked).toBe(true);
    const rec = await loadReconciliationFor(reader, APRIL);
    expect(rec.payouts.map((p) => [p.reference, p.manual])).toEqual([["Inskriven 2025-04", true]]);
    expect(rec.result?.totals).toMatchObject({
      expectedOre,
      actualOre: expectedOre - 6_120,
      differenceOre: -6_120,
    });
    expect(rec.result!.totals.openDeviations).toBeGreaterThan(0);
    const kinds = rec.result!.payouts[0]!.deviations.map((d) => d.kind);
    expect(kinds).not.toContain("fee");
    expect(rec.result!.payouts[0]!.deviations.reduce((sum, d) => sum + d.impactOre, 0)).toBe(
      -6_120,
    );
  });

  it("samma dagar en gång till nekas, också för en del av perioden", async () => {
    for (const period of [APRIL, { start: "2025-04-30", end: "2025-05-03" }]) {
      await expect(
        addManualPayoutFor(owner, { period, amountOre: 1_000, paidOn: TODAY }, TODAY),
      ).rejects.toThrow(/finns redan en utbetalning .*Inskriven 2025-04/);
    }
    expect(await payoutRows()).toHaveLength(1);
  });

  it("raden går inte att ändra, bara arkivera; sedan kommer frågan tillbaka", async () => {
    const change = await asUser(ownerUser, (tx) =>
      attempt(tx, (sp) =>
        sp.execute(sql`update public.payouts set amount_ore = 1, manual = false
                       where organization_id = ${orgId}::uuid returning id`),
      ),
    );
    expect(change.ok && Array.from(change.value as Iterable<unknown>).length > 0).toBe(false);
    expect((await loadPayoutQuestionFor(owner, TODAY)) ?? null).toBeNull();

    const rec = await loadReconciliationFor(owner, APRIL);
    await archivePayoutFor(owner, {
      id: rec.payouts[0]!.id,
      note: "Fel belopp, 61,20 kr för lite.",
    });
    expect((await loadPayoutQuestionFor(owner, TODAY))?.period).toEqual(APRIL);
  });

  it("Samma belopp, avrundat till hela kronor: stämmer, inget att utreda", async () => {
    const saved = await addManualPayoutFor(
      owner,
      { period: APRIL, amountOre: expectedOre + 40, paidOn: "2025-05-03" },
      TODAY,
    );
    // Den arkiverade radens referens är ledig igen.
    expect(saved).toMatchObject({ reference: "Inskriven 2025-04", matches: true });
    expect((await payoutRows()).map((r) => [r.reference, r.archived])).toEqual([
      ["Inskriven 2025-04", true],
      ["Inskriven 2025-04", false],
    ]);
    const rec = await loadReconciliationFor(owner, APRIL);
    expect(rec.result?.totals.openDeviations).toBe(0);
    expect(rec.result?.payouts[0]?.deviations).toEqual([]);
  });

  it("nästa fråga är maj, först när maj är slut och något har sålts", async () => {
    expect(await loadPayoutQuestionFor(owner, TODAY)).toBeNull();
    expect(await loadPayoutQuestionFor(owner, "2025-06-01")).toBeNull();
    await asUser(ownerUser, (tx) =>
      tx.insert(s.orders).values({
        ...orderBase,
        externalId: "70100",
        orderedAt: new Date("2025-05-12T10:00:00Z"),
        sourceHash: "hand-maj",
      }),
    );
    const q = await loadPayoutQuestionFor(owner, "2025-06-01");
    expect(q?.period).toEqual({ start: "2025-05-01", end: "2025-05-31" });
    expect(q?.expected).toMatchObject({ orders: 1, salesOre: 4_900 });
    expect(await loadPayoutQuestionFor(owner, "2025-05-31")).toBeNull();
  });

  it("med kortavgift 1,5 %: frågan drar avgiften, och svaret ger ingen avgiftsavvikelse", async () => {
    await db().execute(
      sql`update public.organization_settings set card_fee_bp = 150
          where organization_id = ${orgId}::uuid`,
    );
    const q = (await loadPayoutQuestionFor(owner, "2025-06-01"))!;
    expect(q.expected.feesOre).toBeGreaterThan(0);
    expect(q.expected.payoutOre).toBe(4_900 - q.expected.feesOre);
    const saved = await addManualPayoutFor(
      owner,
      { period: q.period, amountOre: q.expected.payoutOre, paidOn: "2025-06-01" },
      "2025-06-01",
    );
    expect(saved).toMatchObject({
      reference: "Inskriven 2025-05",
      differenceOre: 0,
      matches: true,
    });
    const rec = await loadReconciliationFor(owner, q.period);
    expect(rec.result?.payouts[0]?.deviations).toEqual([]);
    expect(rec.result?.totals.differenceOre).toBe(0);
  });
  it("flera datakällor: svaret jämförs med all försäljning; samma svar två gånger ger en rad", async () => {
    // En äldre datakälla utan order: raden får inte knytas till den (då jämförs den bara
    // med den källans order och "Samma belopp" ger en avvikelse).
    await asUser(ownerUser, (tx) =>
      tx
        .insert(s.dataSources)
        .values({ organizationId: orgId, provider: "awish_csv", name: "Äldre källa" }),
    );
    await db().execute(sql`update public.data_sources set created_at = '2020-01-01T00:00:00Z'
      where organization_id = ${orgId}::uuid and name = 'Äldre källa'`);
    await asUser(ownerUser, (tx) =>
      tx.insert(s.orders).values({
        ...orderBase,
        externalId: "70200",
        orderedAt: new Date("2025-06-12T10:00:00Z"),
        sourceHash: "hand-juni",
      }),
    );
    const q = (await loadPayoutQuestionFor(owner, "2025-07-01"))!;
    expect(q.period).toEqual({ start: "2025-06-01", end: "2025-06-30" });
    const input = { period: q.period, amountOre: q.expected.payoutOre, paidOn: "2025-07-01" };
    const first = await addManualPayoutFor(owner, input, "2025-07-01");
    expect(first).toMatchObject({ differenceOre: 0, matches: true });
    const [{ source } = { source: "?" }] = await rows<{ source: string | null }>(
      db(),
      sql`select data_source_id::text as source from public.payouts where id = ${first.id}::uuid`,
    );
    expect(source).toBeNull();

    // Svaret kom aldrig fram och ägaren trycker Spara igen: samma kvitto, ingen ny rad.
    const before = (await payoutRows()).length;
    const [again, twice] = await Promise.all([
      addManualPayoutFor(owner, input, "2025-07-01"),
      addManualPayoutFor(admin, input, "2025-07-01"),
    ]);
    expect(again).toEqual(first);
    expect(twice).toEqual(first);
    expect(await payoutRows()).toHaveLength(before);
    // Ett annat belopp för samma dagar nekas som förut.
    await expect(
      addManualPayoutFor(owner, { ...input, amountOre: input.amountOre + 100 }, "2025-07-01"),
    ).rejects.toThrow(/finns redan en utbetalning/);
  });
});

/**
 * Betalt mot rapporten mot dagens uträkning (testdatabasen, egen fixtur).
 *
 * Butiken Vinsten (50 % av vinsten): oktober ger 60 kr med dagens underlag.
 *
 * A. Rapporten butiken fick säger 50 kr: "markera som betald" frågar vilket belopp som
 *    betalades. Ägaren betalade rapportens 50 kr: skillnaden 10 kr visas, och läggs med ett
 *    klick som en egen rad på novemberavräkningen. Den kan tas bort igen.
 * B. Sega gubben-fallet: betald med 60 kr, sedan rättas ett inköpspris i oktober. Det
 *    betalda beloppet står kvar, dagens uträkning blir 70 kr och skillnaden syns i Att göra.
 */

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("next/headers", () => ({
  headers: async () => new Headers(),
  cookies: async () => ({ get: () => undefined, getAll: () => [], set: () => {} }),
}));
vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
  updateTag: vi.fn(),
  unstable_noStore: vi.fn(),
  unstable_cache: <T>(fn: T) => fn,
}));

import { withUserDbFor } from "@/server/access";
import { queryPaidDrift } from "@/server/settlements/queries";
import {
  carryDifferenceFor,
  createMonthlySettlements,
  ensureSettlementsFor,
  loadSettlementPageFor,
  markSettlementPaidFor,
  PaidAmountQuestion,
  removeCorrectionFor,
  settlementDocumentFor,
  undoSettlementPaidFor,
} from "@/server/settlements/service";

import { asPostgres, asUser, attempt, db, one } from "./helpers";
import { seedMoneyFixture, settlementId, type MoneyFixture } from "./pengar-fixture";

const NOV = new Date("2026-11-19T10:00:00Z");
const DEC = new Date("2026-12-02T10:00:00Z");

/** En godkänd butiksrapport för hela månaden med beloppet `totalOre`. */
async function approvedReport(f: MoneyFixture, storeId: string, month: string, totalOre: number) {
  await asPostgres(async (tx) => {
    const r = await one<{ id: string }>(
      tx,
      sql`insert into public.reports (organization_id, kind, period_start, period_end, store_id,
                                      data_snapshot, calc_version)
          values (${f.orgId}, 'store_statement', ${`${month}-01`}::date,
                  (${`${month}-01`}::date + interval '1 month' - interval '1 day')::date, ${storeId},
                  ${JSON.stringify({ type: "butik", report: { compensation: { totalOre } } })}::jsonb,
                  'test')
          returning id`,
    );
    await tx.execute(
      sql`insert into public.report_approvals (organization_id, report_id, approved_by)
          values (${f.orgId}, ${r.id}, ${f.ownerUser.id})`,
    );
  });
}

const drift = (f: MoneyFixture) => withUserDbFor(f.owner.user, (tx) => queryPaidDrift(tx, f.orgId));

const rowOf = async (f: MoneyFixture, id: string, now: Date) =>
  (await loadSettlementPageFor(f.owner, now)).rows.find((r) => r.id === id)!;

afterAll(() => {
  vi.useRealTimers();
});

describe("A. rapporten butiken fick säger ett annat belopp", () => {
  let f: MoneyFixture;
  let oct: string;
  let nov: string;

  beforeAll(async () => {
    f = await seedMoneyFixture("Betald mot rapport");
    vi.useFakeTimers({ toFake: ["Date"], now: NOV });
    await ensureSettlementsFor(f.owner, NOV);
    oct = await settlementId(f.orgId, f.stores.vinsten, "2026-10");
    await approvedReport(f, f.stores.vinsten, "2026-10", 5_000);
  }, 120_000);

  it("den obetalda raden visar rapportens belopp bredvid dagens", async () => {
    const row = await rowOf(f, oct, NOV);
    expect(row).toMatchObject({ amountOre: 6_000, reportOre: 5_000, paidOn: null });
  });

  it("markera som betald utan val: frågan ställs och inget betalas", async () => {
    const err = await markSettlementPaidFor(f.owner, oct, "2026-11-19", 6_000, NOV).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(PaidAmountQuestion);
    expect(err).toMatchObject({ reportOre: 5_000, liveOre: 6_000 });
    expect((err as Error).message.replace(/ | /g, " ")).toBe(
      "Rapporten butiken fick säger 50 kr. Dagens uträkning säger 60 kr. Vilket belopp har du betalat?",
    );
    expect((await rowOf(f, oct, NOV)).paidOn).toBeNull();
  });

  it("ägaren betalade rapportens belopp: skillnaden 10 kr står kvar och syns i Att göra", async () => {
    const paid = await markSettlementPaidFor(f.owner, oct, "2026-11-19", 6_000, NOV, "report");
    expect(paid).toMatchObject({ paidOre: 5_000, amountOre: 6_000, differenceOre: 1_000 });
    const row = await rowOf(f, oct, NOV);
    expect(row).toMatchObject({
      state: "paid",
      paidOre: 5_000,
      reportOre: 5_000,
      liveOre: 6_000,
      differenceOre: 1_000,
      // Ingen obetald avräkning för butiken än: november skapas den 1 december.
      carryTarget: null,
    });
    expect(await drift(f)).toMatchObject([
      { id: oct, paidOre: 5_000, liveOre: 6_000, differenceOre: 1_000 },
    ]);
    await expect(carryDifferenceFor(f.owner, oct, 1_000, NOV)).rejects.toThrow(
      "Butiken har ingen obetald avräkning än. Nästa skapas den 1:a. Lägg till skillnaden då.",
    );
  });

  it("i december: skillnaden läggs som en egen rad på novemberavräkningen", async () => {
    vi.setSystemTime(DEC);
    // November: 100 kr sålt, 40 kr inköp → 30 kr till butiken.
    await f.order("m1", "2026-11-05", 10_000);
    await ensureSettlementsFor(f.owner, DEC);
    nov = await settlementId(f.orgId, f.stores.vinsten, "2026-11");
    expect((await rowOf(f, oct, DEC)).carryTarget).toEqual({ id: nov, month: "2026-11" });

    // Fel belopp (skillnaden har ändrats sedan ägaren såg den): inget görs.
    await expect(carryDifferenceFor(f.owner, oct, 900, DEC)).rejects.toThrow(
      /Skillnaden har ändrats/,
    );

    const carried = await carryDifferenceFor(f.owner, oct, 1_000, DEC);
    expect(carried).toMatchObject({ amountOre: 1_000, targetMonth: "2026-11" });

    const target = await rowOf(f, nov, DEC);
    expect(target.amountOre).toBe(4_000);
    expect(target.storedAmountOre).toBe(4_000);
    expect(target.corrections).toMatchObject([
      { sourceId: oct, month: "2026-10", amountOre: 1_000, paidOre: 5_000, liveOre: 6_000 },
    ]);
    expect(target.statement!.steps.at(-1)).toMatchObject({
      label: "Rättelse för oktober 2026",
      amountOre: 1_000,
    });
    // Raden står i avräkningens dokument (det butiken får).
    const doc = await settlementDocumentFor(f.owner, nov, DEC);
    expect(doc.html).toContain("Rättelse för oktober 2026");

    const source = await rowOf(f, oct, DEC);
    expect(source).toMatchObject({ paidOre: 5_000, correctedOre: 1_000, differenceOre: 0 });
    expect(await drift(f)).toEqual([]);
    // Två gånger går inte.
    await expect(carryDifferenceFor(f.owner, oct, 1_000, DEC)).rejects.toThrow(
      "Det finns ingen skillnad att lägga till.",
    );
  });

  it("den betalda kan inte ångras medan rättelsen ligger på en senare avräkning", async () => {
    await expect(undoSettlementPaidFor(f.owner, oct)).rejects.toThrow(
      "Skillnaden ligger som rättelse på en senare avräkning. Ta bort rättelsen först.",
    );
  });

  it("nattens omräkning behåller rättelsen på den obetalda", async () => {
    await createMonthlySettlements(db(), DEC, { organizationIds: [f.orgId] });
    expect((await rowOf(f, nov, DEC)).amountOre).toBe(4_000);
    expect((await rowOf(f, nov, DEC)).storedAmountOre).toBe(4_000);
  });

  it("rättelsen kan tas bort: beloppet går tillbaka och skillnaden står kvar", async () => {
    expect(await removeCorrectionFor(f.owner, nov, oct, DEC)).toEqual({ removedOre: 1_000 });
    expect((await rowOf(f, nov, DEC)).amountOre).toBe(3_000);
    expect(await rowOf(f, oct, DEC)).toMatchObject({ correctedOre: 0, differenceOre: 1_000 });
  });

  it("med rättelsen betald är båda låsta i databasen", async () => {
    await carryDifferenceFor(f.owner, oct, 1_000, DEC);
    await markSettlementPaidFor(f.owner, nov, "2026-12-02", 4_000, DEC);
    for (const change of [
      sql`update public.store_settlements set corrections = '[]'::jsonb where id = ${nov}`,
      sql`update public.store_settlements set paid_amount_ore = 1 where id = ${oct}`,
    ]) {
      const r = await asUser(f.ownerUser, (tx) => attempt(tx, (sp) => sp.execute(change)));
      expect(r.code).toBe("BL081");
    }
  });
});

describe("B. ett inköpspris rättas efter betalningen (Sega gubben-fallet)", () => {
  let f: MoneyFixture;
  let oct: string;

  beforeAll(async () => {
    f = await seedMoneyFixture("Betald mot i dag");
    vi.setSystemTime(NOV);
    await ensureSettlementsFor(f.owner, NOV);
    oct = await settlementId(f.orgId, f.stores.vinsten, "2026-10");
  }, 120_000);

  it("betald med dagens belopp: ingen fråga utan rapport, ingen skillnad", async () => {
    const paid = await markSettlementPaidFor(f.owner, oct, "2026-11-19", 6_000, NOV);
    expect(paid).toMatchObject({ paidOre: 6_000, differenceOre: 0, monthClosed: false });
    expect(await rowOf(f, oct, NOV)).toMatchObject({ liveOre: 6_000, differenceOre: 0 });
    expect(await drift(f)).toEqual([]);
  });

  it("priset rättas i oktober: betalt står kvar, dagens uträkning och skillnaden visas", async () => {
    // Inköpspriset 40 kr → 30 kr: oktober blir (200 − 60) / 2 = 70 kr.
    await asPostgres((tx) =>
      tx.execute(
        sql`update public.purchase_prices set unit_cost_ore = 3000
            where organization_id = ${f.orgId} and title_id = ${f.titleId}`,
      ),
    );
    const row = await rowOf(f, oct, NOV);
    expect(row).toMatchObject({
      state: "paid",
      paidOre: 6_000,
      amountOre: 6_000,
      liveOre: 7_000,
      differenceOre: 1_000,
    });
    // Att göra läser det sparade: först efter nattens jobb.
    expect(await drift(f)).toEqual([]);
    const [run] = await createMonthlySettlements(db(), NOV, { organizationIds: [f.orgId] });
    expect(run!.paidDiffering).toBe(1);
    expect(await drift(f)).toMatchObject([
      { id: oct, paidOre: 6_000, liveOre: 7_000, differenceOre: 1_000 },
    ]);
    // Det betalda beloppet är orört i databasen.
    const stored = await asPostgres((tx) =>
      one<{ amount_ore: string; live_amount_ore: string }>(
        tx,
        sql`select amount_ore, live_amount_ore from public.store_settlements where id = ${oct}`,
      ),
    );
    expect(Number(stored.amount_ore)).toBe(6_000);
    expect(Number(stored.live_amount_ore)).toBe(7_000);
  });
});

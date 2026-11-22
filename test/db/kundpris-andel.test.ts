/**
 * Butikens andel vid vinstdelning räknas på pris mot kund från 1 nov. 2026
 * (CUSTOMER_PRICE_SHARE_FROM, src/domain/profit-split.ts; 20261226000000_kundpris_andel.sql),
 * mot testdatabasen med appens egna tjänster:
 *
 *   - avräkningen räknad nu och den som skapas för november, och oktober oförändrad,
 *   - betalning för en egen period (store_payments): delen räknas på samma regel och dras av,
 *   - bokföringen: butikens andel på pris mot kund, vårt inköp på vårt pris,
 *   - röda laget: butikens portal, avräkningens PDF och butiksrapporten lämnar aldrig ut vårt
 *     inköpspris, vårt inköp eller vår del för november,
 *   - stängd månad: pris mot kund är låst från datumet, inte före,
 *   - databasens datum är detsamma som kodens.
 *
 * Fixturen (pengar-fixture): "Vinsten" har 50 % av vinsten efter kostnader. Titeln kostar oss
 * 40,13 kr och har pris mot kund 50,00 kr från 1 jan. 2026. Ingen kortavgift.
 *
 *   Oktober  2 × 100 kr: andelen (20 000 − 2 × 4 013) / 2 = 5 987 (vårt pris, före datumet)
 *   November 3 × 100 kr: andelen (30 000 − 3 × 5 000) / 2 = 7 500 (pris mot kund)
 *            vårt inköp 3 × 4 013 = 12 039, vår del 30 000 − 12 039 − 7 500 = 10 461
 *            (utan pris mot kund vore andelen round(17 961 / 2) = 8 981)
 */

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { CUSTOMER_PRICE_SHARE_FROM } from "@/domain";
import { withUserDbFor } from "@/server/access";
import { queryPortalStores } from "@/server/portal/queries";
import { loadPortalSettlementDocument, queryPortalSettlements } from "@/server/portal/settlements";
import { buildSnapshot } from "@/server/reports/snapshot";
import { loadSnapshotInput } from "@/server/reports/sources";
import { computeSettlementsTx } from "@/server/settlements/live";
import { previewPaymentFor, registerPaymentFor } from "@/server/settlements/payments";
import {
  createMonthlySettlements,
  loadSettlementPageFor,
  settlementDocumentFor,
} from "@/server/settlements/service";

import { asPostgres, asUser, attempt, db, one, type TestUser } from "./helpers";
import { inviteStoreUser } from "./portal-fixture";
import { seedMoneyFixture, settlementId, type MoneyFixture } from "./pengar-fixture";

const NOV = new Date("2026-11-19T10:00:00Z");
const DEC = new Date("2026-12-02T10:00:00Z");

const OUR_UNIT = 4_013;
const CUSTOMER = 5_000;
const OCT_SHARE = 5_987;
const NOV_SHARE = 7_500;
const NOV_SHARE_OLD_RULE = 8_981;
const NOV_OUR_COST = 3 * OUR_UNIT;
const NOV_OUR_PART = 30_000 - NOV_OUR_COST - NOV_SHARE;

/** Talen som avslöjar vårt pris för november: får aldrig finnas i något butiken ser. */
const FORBIDDEN_NUMBERS = [
  OUR_UNIT,
  NOV_OUR_COST,
  NOV_OUR_PART,
  30_000 - NOV_OUR_COST, // vår vinst före andelen
  NOV_SHARE_OLD_RULE,
];
const FORBIDDEN_TEXT = /40[,.]13|120[,.]39|104[,.]61|179[,.]61|89[,.]81/;

/** Alla tal i ett JSON-värde (rekursivt). */
function numbersIn(value: unknown, out: number[] = []): number[] {
  if (typeof value === "number") out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => numbersIn(v, out));
  else if (value && typeof value === "object")
    Object.values(value).forEach((v) => numbersIn(v, out));
  return out;
}

const plain = (t: string) => t.replace(/[  ]/g, " ");

function expectNoOwnCost(what: string, value: unknown): void {
  const nums = numbersIn(value);
  for (const n of FORBIDDEN_NUMBERS) expect(nums, `${what}: ${n}`).not.toContain(n);
  const text = plain(typeof value === "string" ? value : JSON.stringify(value));
  expect(text, what).not.toMatch(FORBIDDEN_TEXT);
  expect(text, what).not.toMatch(/unit_?cost|ourPurchases|shareCost|customer_?price/i);
}

let f: MoneyFixture;
let storeUser: TestUser;

beforeAll(async () => {
  f = await seedMoneyFixture("Kundpris andel");
  await asPostgres(async (tx) => {
    await tx.execute(
      sql`update public.purchase_prices set unit_cost_ore = ${OUR_UNIT},
            customer_price_ore = ${CUSTOMER}
          where organization_id = ${f.orgId}`,
    );
    await tx.execute(
      sql`update public.organization_settings set card_fee_bp = 0, card_fee_history = '[]'::jsonb
          where organization_id = ${f.orgId}`,
    );
  });
  await f.order("m1", "2026-11-05", 10_000);
  await f.order("m1", "2026-11-12", 10_000);
  await f.order("m1", "2026-11-25", 10_000);
  storeUser = await inviteStoreUser(f.ownerUser, f.orgId, f.stores.vinsten);
  vi.useFakeTimers({ toFake: ["Date"], now: NOV });
}, 120_000);

afterAll(() => {
  vi.useRealTimers();
});

async function liveShare(month: string, now: Date): Promise<number> {
  const live = await withUserDbFor(f.owner.user, (tx) =>
    computeSettlementsTx(tx, {
      organizationId: f.orgId,
      month,
      storeIds: [f.stores.vinsten],
      now,
    }),
  );
  const r = live.get(f.stores.vinsten);
  if (!r?.ok) throw new Error(`Ingen avräkning: ${r && !r.ok ? r.message : "saknas"}`);
  return r.computed.amountOre;
}

describe("datumet", () => {
  it("databasens spärr har samma datum som koden", async () => {
    const row = await one<{ d: string }>(
      db(),
      sql`select private.customer_price_share_from()::text as d`,
    );
    expect(row.d).toBe(CUSTOMER_PRICE_SHARE_FROM);
    expect(CUSTOMER_PRICE_SHARE_FROM).toBe("2026-11-01");
  });
});

describe("avräkningen", () => {
  it("oktober (före datumet) räknas på vårt pris, november på pris mot kund", async () => {
    expect(await liveShare("2026-10", DEC)).toBe(OCT_SHARE);
    expect(await liveShare("2026-11", DEC)).toBe(NOV_SHARE);
  });

  it("utan pris mot kund på perioden: andelen på vårt pris (som förut)", async () => {
    await asPostgres((tx) =>
      tx.execute(
        sql`update public.purchase_prices set customer_price_ore = null
            where organization_id = ${f.orgId}`,
      ),
    );
    try {
      expect(await liveShare("2026-11", DEC)).toBe(NOV_SHARE_OLD_RULE);
      expect(await liveShare("2026-10", DEC)).toBe(OCT_SHARE);
    } finally {
      await asPostgres((tx) =>
        tx.execute(
          sql`update public.purchase_prices set customer_price_ore = ${CUSTOMER}
              where organization_id = ${f.orgId}`,
        ),
      );
    }
    expect(await liveShare("2026-11", DEC)).toBe(NOV_SHARE);
  });

  it("bokföringen: butikens andel på pris mot kund, vårt inköp på vårt pris", async () => {
    const snap = await asPostgres(async (tx) =>
      buildSnapshot(
        await loadSnapshotInput(tx, {
          organizationId: f.orgId,
          type: "bokforing",
          month: "2026-11",
          now: DEC.toISOString(),
        }),
      ),
    );
    if (snap.type !== "bokforing") throw new Error("fel typ");
    const row = snap.report.stores.find((x) => x.storeId === f.stores.vinsten)!;
    expect(row.compensationOre).toBe(NOV_SHARE);
    expect(row.costOre).toBe(NOV_OUR_COST);
  });
});

describe("betalning för en egen period och novemberavräkningen", () => {
  it("förhandsvisningen: oktoberdelen på vårt pris, novemberdelen får resten", async () => {
    vi.setSystemTime(NOV);
    // 15 okt.–14 nov.: oktobers dagar (20 okt., 100 kr) = round((10 000 − 4 013) / 2) = 2 994.
    const preview = await previewPaymentFor(
      f.owner,
      {
        storeId: f.stores.vinsten,
        paidOn: "2026-11-16",
        amountOre: 2_994 + 5_000,
        periodStart: "2026-10-15",
        periodEnd: "2026-11-14",
      },
      NOV,
    );
    expect(preview.parts.map((p) => [p.month, p.amountOre])).toEqual([
      ["2026-10", 2_994],
      ["2026-11", 5_000],
    ]);
  });

  it("förskottet för 1–14 nov. dras av på novemberavräkningen, som räknas på pris mot kund", async () => {
    vi.setSystemTime(NOV);
    // 1–14 nov.: två order à 100 kr, andelen (20 000 − 2 × 5 000) / 2 = 5 000.
    await registerPaymentFor(
      f.owner,
      {
        storeId: f.stores.vinsten,
        paidOn: "2026-11-16",
        amountOre: 5_000,
        periodStart: "2026-11-01",
        periodEnd: "2026-11-14",
      },
      [5_000],
      NOV,
    );
    vi.setSystemTime(DEC);
    await createMonthlySettlements(db(), DEC, { organizationIds: [f.orgId] });
    const nov = await settlementId(f.orgId, f.stores.vinsten, "2026-11");
    const stored = await asPostgres((tx) =>
      one<{ amount_ore: string; paid_on: string | null }>(
        tx,
        sql`select amount_ore, paid_on::text as paid_on from public.store_settlements where id = ${nov}`,
      ),
    );
    expect(Number(stored.amount_ore)).toBe(NOV_SHARE);
    expect(stored.paid_on).toBeNull();
    const row = (await loadSettlementPageFor(f.owner, DEC)).rows.find((r) => r.id === nov)!;
    expect(row.amountOre).toBe(NOV_SHARE);
    expect(row.leftOre).toBe(NOV_SHARE - 5_000);
  });

  it("ägarens PDF av avräkningen visar underlaget på pris mot kund, inte vårt pris", async () => {
    vi.setSystemTime(DEC);
    const nov = await settlementId(f.orgId, f.stores.vinsten, "2026-11");
    const doc = plain((await settlementDocumentFor(f.owner, nov, DEC)).html);
    expect(doc).toContain("150,00");
    expectNoOwnCost("ägarens PDF", doc);
  });
});

describe("röda laget: butiken ser aldrig vårt inköpspris", () => {
  it("portalens avräkningar och avräkningens PDF i portalen", async () => {
    vi.setSystemTime(DEC);
    const list = await asUser(storeUser, (tx) => queryPortalSettlements(tx, f.stores.vinsten));
    const nov = list.find((x) => x.month === "2026-11")!;
    expect(nov.amountOre).toBe(NOV_SHARE);
    expectNoOwnCost("portal_settlements", list);

    const stores = await asUser(storeUser, (tx) => queryPortalStores(tx));
    const doc = await loadPortalSettlementDocument(
      {
        user: { userId: storeUser.id, email: storeUser.email },
        store: stores.find((x) => x.storeId === f.stores.vinsten)!,
        stores,
      },
      nov.id,
    );
    expect(doc).not.toBeNull();
    expect(plain(doc!.html)).toContain("150,00");
    expectNoOwnCost("portalens PDF", doc!.html);
  });

  it("butiksrapporten för november: inköp och vinst på pris mot kund, inget av vårt", async () => {
    const snap = await asPostgres(async (tx) =>
      buildSnapshot(
        await loadSnapshotInput(tx, {
          organizationId: f.orgId,
          type: "butik",
          month: "2026-11",
          storeId: f.stores.vinsten,
          now: DEC.toISOString(),
        }),
      ),
    );
    if (snap.type !== "butik") throw new Error("fel typ");
    const [split] = snap.report.compensation.splits;
    expect(split).toMatchObject({
      salesInclVatOre: 30_000,
      purchasesOre: 3 * CUSTOMER,
      profitOre: 15_000,
      storeShareOre: NOV_SHARE,
    });
    expectNoOwnCost("butiksrapporten", snap);
    // Databasens egen kontroll av det portalen lämnar ut godkänner rapporten.
    const ok = await one<{ ok: boolean }>(
      db(),
      sql`select private.portal_snapshot_safe(${JSON.stringify(snap.report)}::jsonb,
                                              ${f.stores.vinsten}::uuid) as ok`,
    );
    expect(ok.ok).toBe(true);
  });

  it("butiksanvändaren når varken prisraderna eller vyn med perioderna", async () => {
    await asUser(storeUser, async (tx) => {
      expect(Array.from(await tx.execute(sql`select * from public.purchase_prices`))).toEqual([]);
      expect(
        Array.from(await tx.execute(sql`select * from public.purchase_price_periods`)),
      ).toEqual([]);
    });
  });
});

describe("stängd månad", () => {
  it("pris mot kund är låst för dagar från datumet i en stängd månad, inte före", async () => {
    const update = (ore: number) =>
      asUser(f.ownerUser, (tx) =>
        attempt(tx, (sp) =>
          sp.execute(
            sql`update public.purchase_prices set customer_price_ore = ${ore}
                where organization_id = ${f.orgId}`,
          ),
        ),
      );
    // September stängd: priset (från 1 jan.) gäller i september, men pris mot kund räknas
    // inte där, så ändringen är tillåten.
    const close = (month: string) =>
      asUser(f.ownerUser, (tx) =>
        tx.execute(sql`select public.close_period(${f.orgId}, ${month}::date)`),
      );
    await close("2026-09-01");
    expect(await update(5_100)).toMatchObject({ ok: true });
    // November stängd: ändringen skulle ändra novembers andel och nekas.
    // November: databasens klocka står på i dag, så stängningen läggs in direkt (som när
    // appen stänger månaden efter sista betalningen).
    await close("2026-10-01");
    await asPostgres((tx) =>
      tx.execute(
        sql`insert into public.period_closes (organization_id, month)
            values (${f.orgId}, '2026-11-01'::date)`,
      ),
    );
    expect(await update(5_200)).toMatchObject({ ok: false, code: "BL004" });
    const now = await one<{ c: string }>(
      db(),
      sql`select customer_price_ore::text as c from public.purchase_prices
          where organization_id = ${f.orgId}`,
    );
    expect(Number(now.c)).toBe(5_100);
  });
});

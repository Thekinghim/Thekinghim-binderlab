/**
 * En rättelse som betalas på en senare avräkning räknas som betald för sin egen månad i
 * butiksrapporten (testdatabasen, egen fixtur).
 *
 * Butiken Vinsten (50 % av vinsten): oktober betalas med 60 kr. Inköpspriset rättas så att
 * oktober blir 70 kr, och de 10 kr läggs på novemberavräkningen (485 kr för november), som
 * betalas med 495 kr. Novemberrapporten räknar bara av 485 kr; oktoberrapporten räknar av
 * 60 kr och rättelsen på 10 kr.
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

import { invoiceRows, paymentNotes, type StoreBasis, type StoreReport } from "@/reports";
import { createReportFor, getReportFor } from "@/server/reports/service";
import {
  carryDifferenceFor,
  ensureSettlementsFor,
  markSettlementPaidFor,
} from "@/server/settlements/service";

import { asPostgres } from "./helpers";
import { seedMoneyFixture, settlementId, type MoneyFixture } from "./pengar-fixture";

const NOV = new Date("2026-11-19T10:00:00Z");
const DEC = new Date("2026-12-02T10:00:00Z");

async function blockOf(f: MoneyFixture, month: string) {
  const id = await createReportFor(
    f.owner,
    { type: "butik", month: month as `${number}-${number}`, storeId: f.stores.vinsten },
    DEC,
  );
  const snap = (await getReportFor(f.owner, id)).snapshot as unknown as {
    report: StoreReport & { basis: StoreBasis };
  };
  const report = snap.report;
  return {
    rows: invoiceRows(report.basis, report).map((r) => [r.label, r.amountOre]),
    notes: paymentNotes(report.basis, report),
  };
}

afterAll(() => {
  vi.useRealTimers();
});

describe("rättelse betald på novemberavräkningen", () => {
  let f: MoneyFixture;

  beforeAll(async () => {
    f = await seedMoneyFixture("Rättelse i rapporten");
    vi.useFakeTimers({ toFake: ["Date"], now: NOV });
    await ensureSettlementsFor(f.owner, NOV);
    const oct = await settlementId(f.orgId, f.stores.vinsten, "2026-10");
    await markSettlementPaidFor(f.owner, oct, "2026-11-19", 6_000, NOV);

    vi.setSystemTime(DEC);
    await f.order("m1", "2026-11-05", 100_000);
    // Provision säljer också i november och förblir obetald, så att månaden inte stängs.
    await f.order("m2", "2026-11-06", 10_000);
    // Inköpspriset för oktober rättas: 30 kr från 1 oktober, så oktober blir 70 kr.
    await asPostgres((tx) =>
      tx.execute(
        sql`insert into public.purchase_prices (organization_id, title_id, unit_cost_ore, valid_from)
            values (${f.orgId}, ${f.titleId}, 3000, '2026-10-01')`,
      ),
    );
    await ensureSettlementsFor(f.owner, DEC);
    await carryDifferenceFor(f.owner, oct, 1_000, DEC);
    const nov = await settlementId(f.orgId, f.stores.vinsten, "2026-11");
    await markSettlementPaidFor(f.owner, nov, "2026-11-19", 49_500, DEC);
  }, 120_000);

  it("novemberrapporten räknar bara av novembers del", async () => {
    const { rows, notes } = await blockOf(f, "2026-11");
    expect(rows).toEqual([
      ["Ersättning exkl. moms", 48_500],
      ["Moms 25 %", 12_125],
      ["Att fakturera", 60_625],
      ["Redan betalt 19 nov. 2026 (avräkning november 2026)", 48_500],
      ["Kvar att betala", 12_125],
    ]);
    expect(notes.join(" ")).not.toMatch(/betalades/);
  });

  it("oktoberrapporten räknar av rättelsen som betald för oktober", async () => {
    const { rows, notes } = await blockOf(f, "2026-10");
    expect(rows).toEqual([
      ["Ersättning exkl. moms", 7_000],
      ["Moms 25 %", 1_750],
      ["Att fakturera", 8_750],
      ["Redan betalt 19 nov. 2026 (avräkning oktober 2026)", 6_000],
      [
        "Redan betalt 19 nov. 2026 (rättelse för oktober 2026 på avräkningen för november 2026)",
        1_000,
      ],
      ["Kvar att betala", 1_750],
    ]);
    expect(notes.join(" ")).not.toMatch(/betalades|med rättelser/);
  });
});

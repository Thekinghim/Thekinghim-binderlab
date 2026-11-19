/**
 * Månaden stängs av appen (testdatabasen, egen fixtur, "i dag" 19 nov. 2026):
 *
 * - sista betalda avräkningen stänger månaden, en ensam betald gör det inte
 * - i den stängda månaden stoppar databasen pris, avtal, placering, lager, återbetalning,
 *   fast kostnad och testköp (BL004), med ett besked på enkel svenska
 * - en sen order sparas ändå och flaggas
 * - ångra betald: ägaren öppnar månaden, admin gör det inte
 * - bokföringen markerad som skickad stänger månaden, ångra öppnar den
 * - "Öppna månaden igen": bara ägaren, med anledning, loggas
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
  unstable_noStore: vi.fn(),
  unstable_cache: <T>(fn: T) => fn,
}));

import * as s from "@/db/schema";
import { dbErrorMessage } from "@/server/errors";
import { closedMonthMessage } from "@/server/periods/model";
import { markMonthSentFor, unmarkMonthSentFor } from "@/server/bokforing/service";
import {
  closeMonthFor,
  loadPeriodOverviewFor,
  PeriodError,
  reopenMonthFor,
} from "@/server/periods/service";
import {
  ensureSettlementsFor,
  markSettlementPaidFor,
  undoSettlementPaidFor,
} from "@/server/settlements/service";

import { asPostgres, asUser, attempt, one, rows } from "./helpers";
import { seedMoneyFixture, settlementId, type MoneyFixture } from "./pengar-fixture";

const NOW = new Date("2026-11-19T10:00:00Z");
const TODAY = "2026-11-19";

let f: MoneyFixture;
let octVinsten: string;
let octProvision: string;

const closedMonths = async () =>
  (
    await asPostgres((tx) =>
      rows<{ month: string }>(
        tx,
        sql`select to_char(month, 'YYYY-MM') as month from public.period_closes
            where organization_id = ${f.orgId} and reopened_at is null order by month`,
      ),
    )
  ).map((r) => r.month);

beforeAll(async () => {
  f = await seedMoneyFixture("Månadsstängning");
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
  const run = await ensureSettlementsFor(f.owner, NOW);
  expect(run?.created).toBe(2);
  octVinsten = await settlementId(f.orgId, f.stores.vinsten, "2026-10");
  octProvision = await settlementId(f.orgId, f.stores.provision, "2026-10");
}, 120_000);

afterAll(() => {
  vi.useRealTimers();
});

describe("sista betalda avräkningen stänger månaden", () => {
  it("en betald av två stänger inte", async () => {
    const paid = await markSettlementPaidFor(f.owner, octVinsten, TODAY, null, NOW);
    expect(paid.monthClosed).toBe(false);
    expect(await closedMonths()).toEqual([]);
  });

  it("den sista stänger oktober, med vad som stängde den", async () => {
    const paid = await markSettlementPaidFor(f.admin, octProvision, TODAY, null, NOW);
    expect(paid).toMatchObject({ month: "2026-10", monthClosed: true });
    expect(await closedMonths()).toEqual(["2026-10"]);
    const overview = await loadPeriodOverviewFor(f.owner);
    expect(overview.closed).toMatchObject([{ month: "2026-10", trigger: "settlement_paid" }]);
    expect(overview.canReopen).toBe(true);
    expect((await loadPeriodOverviewFor(f.admin)).canReopen).toBe(false);
  });
});

describe("i den stängda månaden stoppar databasen ändringar (BL004)", () => {
  const org = () => ({ organizationId: f.orgId });
  const denied = async (
    fn: (tx: Parameters<Parameters<typeof asUser>[1]>[0]) => Promise<unknown>,
  ) => {
    const outcome = await asUser(f.ownerUser, (tx) => attempt(tx, fn));
    return outcome.ok ? "ok" : outcome.code;
  };

  it("inköpspris, också ett som skulle gälla in i månaden", async () => {
    expect(
      await denied((tx) =>
        tx
          .insert(s.purchasePrices)
          .values({ ...org(), titleId: f.titleId, unitCostOre: 3000, validFrom: "2026-10-10" }),
      ),
    ).toBe("BL004");
    expect(
      await denied((tx) =>
        tx.execute(
          sql`update public.purchase_prices set unit_cost_ore = 3000
              where organization_id = ${f.orgId} and title_id = ${f.titleId}`,
        ),
      ),
    ).toBe("BL004");
    // Från första öppna månaden går det bra.
    expect(
      await denied((tx) =>
        tx
          .insert(s.purchasePrices)
          .values({ ...org(), titleId: f.titleId, unitCostOre: 3900, validFrom: "2026-11-01" }),
      ),
    ).toBe("ok");
  });

  it("avtal", async () => {
    expect(
      await denied((tx) =>
        tx.execute(
          sql`update public.store_agreements set commission_bp = 4000
              where organization_id = ${f.orgId} and store_id = ${f.stores.vinsten}`,
        ),
      ),
    ).toBe("BL004");
  });

  it("placering", async () => {
    expect(
      await denied((tx) =>
        tx.execute(
          sql`update public.machine_placements set valid_to = '2026-10-15'
              where organization_id = ${f.orgId} and machine_id = ${f.machines.m1}`,
        ),
      ),
    ).toBe("BL004");
  });

  it("lager", async () => {
    const loc = await asPostgres((tx) =>
      one<{ id: string }>(
        tx,
        sql`select id from public.stock_locations
            where organization_id = ${f.orgId} and machine_id = ${f.machines.m1}`,
      ),
    );
    expect(
      await denied((tx) =>
        tx.insert(s.stockEvents).values({
          ...org(),
          locationId: loc.id,
          titleId: f.titleId,
          kind: "refill",
          quantity: 3,
          occurredAt: new Date("2026-10-20T10:00:00Z"),
        }),
      ),
    ).toBe("BL004");
  });

  it("återbetalning", async () => {
    expect(
      await denied((tx) =>
        tx.insert(s.incidents).values({
          ...org(),
          machineId: f.machines.m1,
          kind: "refund_request",
          startedAt: new Date("2026-10-15T10:00:00Z"),
          refundedOre: 4900,
          refundedOn: "2026-10-15",
        }),
      ),
    ).toBe("BL004");
  });

  it("fast kostnad", async () => {
    expect(
      await denied((tx) =>
        tx.execute(
          sql`insert into public.fixed_costs (organization_id, name, amount_ore, interval, starts_on)
              values (${f.orgId}, 'Försäkring', 50000, 'month', '2026-10-01')`,
        ),
      ),
    ).toBe("BL004");
  });

  it("testköp, med ett besked på enkel svenska", async () => {
    const order = await asPostgres((tx) =>
      one<{ id: string }>(
        tx,
        sql`select id from public.orders where organization_id = ${f.orgId}
            and business_date = '2026-10-05'`,
      ),
    );
    let message = "";
    try {
      await asUser(f.ownerUser, (tx) =>
        tx.execute(sql`select public.set_test_purchase(${f.orgId}, ${order.id}, true)`),
      );
    } catch (error) {
      message = dbErrorMessage(error);
    }
    expect(message).toBe(
      "Månaden är stängd. Testköp kan inte ändras där. Ägaren kan öppna månaden igen under Butiker → Utbetalning.",
    );
    // Och databasens besked för pris, avtal, lager med mera: månaden vid namn.
    expect(closedMonthMessage("Inköpspriset påverkar en stängd månad (2026-10).")).toBe(
      "Oktober 2026 är stängd. Inköpspriset kan inte ändras där. Ägaren kan öppna månaden igen under Butiker → Utbetalning.",
    );
  });

  it("en sen order sparas ändå och flaggas", async () => {
    const id = await f.order("m1", "2026-10-28", 10_000);
    const row = await asPostgres((tx) =>
      one<{ late: boolean }>(
        tx,
        sql`select late_in_closed_period as late from public.orders where id = ${id}`,
      ),
    );
    expect(row.late).toBe(true);
  });
});

describe("ångra betald", () => {
  it("admin: avräkningen blir obetald men månaden ligger kvar stängd", async () => {
    const undo = await undoSettlementPaidFor(f.admin, octProvision);
    expect(undo).toEqual({ month: "2026-10", period: "owner-needed" });
    expect(await closedMonths()).toEqual(["2026-10"]);
    // Betalas den igen händer inget nytt (månaden är redan stängd).
    const again = await markSettlementPaidFor(f.admin, octProvision, TODAY, null, NOW);
    expect(again.monthClosed).toBe(false);
    expect(await closedMonths()).toEqual(["2026-10"]);
  });

  it("ägaren: månaden öppnas och det loggas med anledning", async () => {
    const undo = await undoSettlementPaidFor(f.owner, octProvision);
    expect(undo.period).toBe("reopened");
    expect(await closedMonths()).toEqual([]);
    const log = await asPostgres((tx) =>
      one<{ reason: string; actor: string | null; logged: number }>(
        tx,
        sql`select pc.reopened_reason as reason, pc.reopened_by::text as actor,
                   (select count(*)::int from public.audit_log a
                     where a.table_name = 'period_closes' and a.row_id = pc.id) as logged
            from public.period_closes pc
            where pc.organization_id = ${f.orgId} and pc.month = '2026-10-01'`,
      ),
    );
    expect(log.reason).toBe("Ångrade betald avräkning");
    expect(log.actor).toBe(f.ownerUser.id);
    expect(log.logged).toBeGreaterThanOrEqual(2);
  });
});

describe("bokföringen markerad som skickad", () => {
  it("stänger månaden, och ångra öppnar den (ägaren)", async () => {
    const sent = await markMonthSentFor(f.owner, "2026-09", TODAY);
    expect(sent.monthClosed).toBe(true);
    expect(await closedMonths()).toEqual(["2026-09"]);
    expect(await unmarkMonthSentFor(f.admin, "2026-09")).toBe("owner-needed");
    await markMonthSentFor(f.admin, "2026-09", TODAY);
    expect(await unmarkMonthSentFor(f.owner, "2026-09")).toBe("reopened");
    expect(await closedMonths()).toEqual([]);
  });

  it("betalda avräkningar håller månaden stängd när skickad ångras", async () => {
    await markSettlementPaidFor(f.owner, octProvision, TODAY, null, NOW);
    expect(await closedMonths()).toEqual(["2026-10"]);
    await markMonthSentFor(f.owner, "2026-10", TODAY);
    expect(await unmarkMonthSentFor(f.owner, "2026-10")).toBe("kept");
    expect(await closedMonths()).toEqual(["2026-10"]);
  });
});

describe("Öppna månaden igen", () => {
  it("bara ägaren, och bara med en anledning", async () => {
    await expect(reopenMonthFor(f.admin, "2026-10", "Fel pris")).rejects.toThrow(
      "Bara ägaren kan öppna en stängd månad.",
    );
    await expect(reopenMonthFor(f.owner, "2026-10", " ")).rejects.toThrow(
      "Skriv varför månaden öppnas.",
    );
    expect(await closedMonths()).toEqual(["2026-10"]);
  });

  it("ägaren öppnar med anledning, ändringen går igenom, och admin kan stänga igen", async () => {
    await reopenMonthFor(f.owner, "2026-10", "Fel inköpspris i oktober");
    expect(await closedMonths()).toEqual([]);
    const overview = await loadPeriodOverviewFor(f.owner);
    expect(overview.reopened[0]).toMatchObject({
      month: "2026-10",
      reason: "Fel inköpspris i oktober",
    });
    const price = await asUser(f.ownerUser, (tx) =>
      attempt(tx, (sp) =>
        sp.insert(s.purchasePrices).values({
          organizationId: f.orgId,
          titleId: f.titleId,
          unitCostOre: 3500,
          validFrom: "2026-10-10",
        }),
      ),
    );
    expect(price.ok).toBe(true);
    await closeMonthFor(f.admin, "2026-10", NOW);
    expect(await closedMonths()).toEqual(["2026-10"]);
    expect(
      (await loadPeriodOverviewFor(f.owner)).reopened.some((r) => r.month === "2026-10"),
    ).toBe(false);
    await expect(reopenMonthFor(f.owner, "2026-08", "Test")).rejects.toThrow(PeriodError);
  });

  it("den innevarande månaden stängs aldrig", async () => {
    await expect(closeMonthFor(f.owner, "2026-11", NOW)).rejects.toThrow(
      "November 2026 är inte slut.",
    );
  });
});

import { describe, expect, it } from "vitest";

import { eachDay, profitability } from "@/domain";

import { buildPartnerReport, samePeriodLastYear } from "./partner-report";
import { octoberExample, ord, sources } from "./testing/fixtures";

const plain = (s: string) => s.replace(/ /g, " ");
const OWNERS = [
  { id: "a", name: "Anna", shareBp: 6000 },
  { id: "b", name: "Bo", shareBp: 4000 },
];

describe("delägarrapport med eget datum", () => {
  it("en hel månad som period ger exakt samma rapport som månaden", () => {
    const src = octoberExample();
    const byMonth = buildPartnerReport(src, "2026-10", { owners: OWNERS });
    const byPeriod = buildPartnerReport(
      src,
      { start: "2026-10-01", end: "2026-10-31" },
      { owners: OWNERS },
    );
    expect(byPeriod).toEqual(byMonth);
    expect(byMonth.trend.lastMonthThrough).toBeUndefined();
  });

  it("siffrorna är summan av intervallets dagar, vinsten som Lönsamhet för samma datum", () => {
    const src = octoberExample();
    const period = { start: "2026-10-05", end: "2026-10-20" };
    const r = buildPartnerReport(src, period, { owners: OWNERS });
    expect(r.period).toEqual(period);
    expect(r.month).toBe("2026-10");

    const days = eachDay(period.start, period.end).map(
      (d) => buildPartnerReport(src, { start: d, end: d }).result,
    );
    const sum = (pick: (x: (typeof days)[number]) => number) =>
      days.reduce((n, x) => n + pick(x), 0);
    expect(r.result.orders).toBe(5);
    expect(r.result.orders).toBe(sum((x) => x.orders));
    expect(r.result.totalRevenueOre).toBe(sum((x) => x.totalRevenueOre));
    expect(r.result.totalRevenueOre).toBe(5 * 4900);
    expect(r.result.costOre).toBe(sum((x) => x.costOre));
    expect(r.result.commissionOre).toBe(sum((x) => x.commissionOre));
    // Hyran per dag: 62 kr × 16 / 31 dagar = 32 kr.
    expect(r.result.rentOre).toBe(3200);

    // Samma uträkning som Lönsamhet (liggaren) för samma datum.
    const p = profitability({ ...src, period }, "title");
    expect(r.result.profitOre).toBe(p.totals.profitOre);
    expect(r.result.marginBp).toBe(p.totals.marginBp);

    // Vinstfördelningen: samma regel, exakt på öret.
    expect(r.profitSplit!.profitOre).toBe(r.result.profitOre);
    expect(r.profitSplit!.owners.reduce((n, o) => n + o.amountOre, 0)).toBe(r.result.profitOre);
    expect(r.profitSplit!.owners.map((o) => o.shareBp)).toEqual([6000, 4000]);
  });

  it("jämför med lika många dagar före och samma datum i fjol, i texterna", () => {
    const base = octoberExample();
    const src = {
      ...base,
      orders: [
        ...base.orders,
        ord("2026-09-25", { amountOre: 4900 }),
        ord("2025-10-07", { amountOre: 4900 }),
      ],
    };
    const r = buildPartnerReport(src, { start: "2026-10-05", end: "2026-10-20" });
    expect(r.previousMonth).toMatchObject({
      month: "2026-09",
      period: { start: "2026-09-19", end: "2026-10-04" },
      orders: 1,
      totalRevenueOre: 4900,
    });
    expect(plain(r.previousMonth!.text)).toMatch(/^Perioden före \(19 sep\.–4 okt\. 2026\): /);
    expect(r.sameMonthLastYear).toMatchObject({
      period: { start: "2025-10-05", end: "2025-10-20" },
      orders: 1,
    });
    expect(plain(r.sameMonthLastYear!.text)).toMatch(/^Samma period i fjol \(5–20 okt\. 2025\)/);
    expect(plain(r.conclusion.text)).toMatch(/mot perioden före\.$/);
  });

  it("utvecklingen slutar med månaden där perioden slutar, och säger till vilken dag", () => {
    const src = sources({
      orders: [ord("2026-10-20"), ord("2026-11-02"), ord("2026-11-04")],
    });
    const r = buildPartnerReport(src, { start: "2026-10-15", end: "2026-11-03" });
    expect(r.month).toBe("2026-10");
    expect(r.result.orders).toBe(2);
    const months = r.trend.months;
    expect(months).toHaveLength(12);
    expect(months[11]!).toMatchObject({ month: "2026-11", orders: 1 });
    expect(r.trend.lastMonthThrough).toBe("2026-11-03");
    expect(r.events.some((e) => e.kind === "record_high" || e.kind === "record_low")).toBe(false);
  });

  it("slutsatsen och händelserna namnger perioden", () => {
    const empty = buildPartnerReport(sources(), { start: "2026-10-01", end: "2026-10-15" });
    expect(plain(empty.conclusion.text)).toBe("Ingen försäljning under 1–15 okt. 2026.");
    const idle = empty.events.find((e) => e.kind === "idle_machine");
    expect(idle && plain(idle.text)).toBe(
      "Nordstan entré (BL-001) i Nordstan sålde inget under 1–15 okt. 2026.",
    );
  });

  it("stoppar perioder över ett år", () => {
    expect(() => buildPartnerReport(sources(), { start: "2025-10-01", end: "2026-10-02" })).toThrow(
      /högst ett år/,
    );
    expect(() =>
      buildPartnerReport(sources(), { start: "2026-10-20", end: "2026-10-10" }),
    ).toThrow();
  });
});

describe("samePeriodLastYear", () => {
  it("samma datum ett år tidigare, månadsslut och skottdag", () => {
    expect(samePeriodLastYear({ start: "2026-10-05", end: "2026-10-20" })).toEqual({
      start: "2025-10-05",
      end: "2025-10-20",
    });
    expect(samePeriodLastYear({ start: "2024-02-29", end: "2024-03-10" })).toEqual({
      start: "2023-02-28",
      end: "2023-03-10",
    });
    expect(samePeriodLastYear({ start: "2025-02-15", end: "2025-02-28" })).toEqual({
      start: "2024-02-15",
      end: "2024-02-29",
    });
  });
});

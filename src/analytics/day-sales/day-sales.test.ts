/**
 * "Vad sålde vi i går": per titel, automat och timme ur liggaren, och bara antal för
 * påfyllaren. Summan av raderna = totalen; vinsten stämmer med profitability utan hyra.
 */
import { describe, expect, it } from "vitest";

import { profitability, type ProfitabilityInput } from "@/domain";
import { NO_TAX, agreement, order, placement, price } from "@/domain/testing/fixtures";

import { daySalesCsv, orderHour, salesFromCounts, salesFromLedger } from ".";

const DAY = "2026-11-21";
const names = {
  title: (id: string) => ({ "t-a": "Pokémon 151", "t-b": "Prismatic" })[id] ?? id,
  machine: (id: string) => ({ name: `Automat ${id}`, code: id.toUpperCase() }),
};

function input(deductStoreShare: boolean): ProfitabilityInput {
  const at = (h: number, m = 0) =>
    // Stockholm är UTC+1 i november.
    new Date(Date.UTC(2026, 10, 21, h - 1, m)).toISOString();
  const o = (titleId: string, machineId: string | null, h: number, amountOre = 10_000) => ({
    ...order({ businessDate: DAY, titleId, machineId, amountOre }),
    orderedAt: at(h),
  });
  return {
    period: { start: DAY, end: DAY },
    orders: [
      o("t-a", "m-1", 9),
      o("t-a", "m-1", 9),
      o("t-a", "m-2", 14),
      o("t-b", "m-2", 23),
      o("t-b", null, 0),
    ],
    prices: [price("t-a", 4_000, "2026-01-01")],
    agreements: [agreement("s-1", "2026-01-01", null, { commissionBp: 1000 })],
    placements: [
      placement("m-1", "s-1", "2026-01-01", null),
      placement("m-2", "s-1", "2026-01-01", null),
    ],
    settings: { ...NO_TAX, deductStoreShare },
  };
}

describe("salesFromLedger", () => {
  it("per titel och automat, störst först, och totalen går ihop", () => {
    const s = salesFromLedger(input(false), names, "Europe/Stockholm");
    expect(s.economy).toBe(true);
    expect(s.units).toBe(5);
    expect(s.titles.map((t) => [t.name, t.units])).toEqual([
      ["Pokémon 151", 3],
      ["Prismatic", 2],
    ]);
    expect(s.machines.map((m) => [m.name, m.units])).toEqual([
      ["Automat m-1", 2],
      ["Automat m-2", 2],
      ["Okänd automat", 1],
    ]);
    expect(s.titles.reduce((a, t) => a + (t.revenueOre ?? 0), 0)).toBe(s.revenueOre);
    expect(s.machines.reduce((a, t) => a + (t.revenueOre ?? 0), 0)).toBe(s.revenueOre);
  });
  it("titel utan inköpspris har ingen vinst; vinsten = Lönsamhets vinst (utan hyra)", () => {
    const inp = input(false);
    const s = salesFromLedger(inp, names, "Europe/Stockholm");
    expect(s.titles.find((t) => t.id === "t-b")?.profitOre).toBeNull();
    expect(s.profitOre).toBe(profitability(inp, "title").totals.profitOre);
    expect(s.titles.find((t) => t.id === "t-a")?.profitOre).toBe(3 * (10_000 - 4_000));
  });
  it("med butikernas andel dras provisionen per order", () => {
    const inp = input(true);
    const s = salesFromLedger(inp, names, "Europe/Stockholm");
    expect(s.profitOre).toBe(3 * (10_000 - 4_000 - 1_000));
    expect(s.profitOre).toBe(profitability(inp, "title").totals.profitOre);
  });
  it("per timme i organisationens tidszon", () => {
    const s = salesFromLedger(input(false), names, "Europe/Stockholm");
    expect(s.hours).toHaveLength(24);
    expect(s.hours[9]?.units).toBe(2);
    expect(s.hours[14]?.units).toBe(1);
    expect(s.hours[23]?.units).toBe(1);
    expect(s.hours[0]?.units).toBe(1);
    expect(s.hours.reduce((a, h) => a + h.units, 0)).toBe(5);
  });
  it("flera dagar: inga timmar", () => {
    const inp = { ...input(false), period: { start: "2026-11-20", end: DAY } };
    expect(salesFromLedger(inp, names, "Europe/Stockholm").hours).toEqual([]);
  });
});

describe("orderHour", () => {
  it("sommartid och betaltid på en annan dag", () => {
    // 29 mars 2026 kl. 03:30 CEST = 01:30 UTC (timmen 02 finns inte den dagen).
    expect(
      orderHour(
        { businessDate: "2026-03-29", orderedAt: "2026-03-29T01:30:00Z" },
        "Europe/Stockholm",
      ),
    ).toBe(3);
    expect(
      orderHour(
        { businessDate: "2026-11-21", orderedAt: "2026-11-22T00:10:00Z" },
        "Europe/Stockholm",
      ),
    ).toBe(23);
    expect(
      orderHour({ businessDate: "2026-11-21", orderedAt: null }, "Europe/Stockholm"),
    ).toBeNull();
    expect(
      orderHour({ businessDate: "2026-11-21", orderedAt: "skräp" }, "Europe/Stockholm"),
    ).toBeNull();
  });
});

describe("salesFromCounts (påfyllaren)", () => {
  it("bara antal, aldrig kronor", () => {
    const s = salesFromCounts(
      [
        { titleId: "t-a", machineId: "m-1", units: 3 },
        { titleId: "t-b", machineId: "m-1", units: 1 },
        { titleId: "t-a", machineId: null, units: 2 },
        { titleId: "t-b", machineId: "m-2", units: 0 },
      ],
      names,
    );
    expect(s.economy).toBe(false);
    expect(s.units).toBe(6);
    expect(s.revenueOre).toBeNull();
    expect(s.profitOre).toBeNull();
    expect(s.hours).toEqual([]);
    for (const r of [...s.titles, ...s.machines]) {
      expect(r.revenueOre).toBeNull();
      expect(r.profitOre).toBeNull();
    }
    expect(s.titles.map((t) => t.units)).toEqual([5, 1]);
    expect(s.machines.map((m) => [m.name, m.units])).toEqual([
      ["Automat m-1", 4],
      ["Okänd automat", 2],
    ]);
  });
});

describe("daySalesCsv", () => {
  it("titlar, automater och total med svenska decimaler", () => {
    const s = salesFromLedger(input(false), names, "Europe/Stockholm");
    const csv = daySalesCsv(s, { start: DAY, end: DAY });
    const lines = csv.replace(/^﻿/, "").trim().split("\r\n");
    expect(lines[0]).toBe("Period;2026-11-21");
    expect(lines).toContain("Titel;Pokémon 151;;3;300,00;180,00");
    expect(lines).toContain("Titel;Prismatic;;2;200,00;");
    expect(lines.at(-1)).toBe("Totalt;;;5;500,00;180,00");
  });
});

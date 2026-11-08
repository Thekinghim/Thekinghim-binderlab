/**
 * Mystery packs i Att göra/Hem: facket fylls bara på när det är tomt, med en hel omgång.
 * Ingen "snart slut", "fyll på" eller larmgräns före 0.
 */
import { describe, expect, it } from "vitest";

import { computeTodos } from "./index";
import { prioritizeByLostSales } from "./lost-sales";
import { mysteryBatches, withSlotAlerts } from "./refill";
import { daily, input, machine, NOW, order, title, TODAY } from "./test-helpers";
import type { TodoInput } from "./types";

const MP = title("mp", "Mystery Pack Plus", { mysteryBatchSize: 14 });

// Säljer 2 per dag: en vanlig titel med 3 pack vore "snart slut".
const base = (onHand: number, p: Partial<TodoInput> = {}) =>
  input({
    titles: [MP],
    orders: daily("mp", "m1", "2026-10-19", 14, 2),
    stock: [{ machineId: "m1", titleId: "mp", onHand }],
    ...p,
  });

const refills = (i: TodoInput) => computeTodos(i, NOW).filter((t) => t.kind === "refill");

describe("mystery packs i Att göra", () => {
  it("ingen punkt medan facket har pack, även när det räcker under en dag", () => {
    expect(refills(base(3))).toEqual([]);
    expect(refills(base(1))).toEqual([]);
  });

  it("samma läge för en vanlig titel ger en punkt (kontroll)", () => {
    const plain = base(1, { titles: [title("mp", "Mystery Pack Plus")] });
    expect(refills(plain)).toHaveLength(1);
  });

  it("tomt fack: fyll på en hel omgång, nivå 'now'", () => {
    const [t, ...rest] = refills(base(0));
    expect(rest).toEqual([]);
    expect(t).toMatchObject({
      key: "refill:m1:mp",
      level: "now",
      daysLeft: 0,
      title: "Mystery Pack Plus är slut i Automat 1 – fyll på en hel omgång (14 st)",
      action: { kind: "register-refill" },
    });
    expect(t?.atStakeOre).toBeGreaterThan(0);
    expect(t?.detail).toMatch(/^Mystery-facket är tomt\./);
    expect(t?.evidence.figures.find((f) => f.key === "batchSize")?.value).toBe(14);
  });

  it("tomt fack som sålt här förut (inget i fönstret) ger också punkten", () => {
    const i = base(0, {
      orders: [order({ titleId: "mp", machineId: "m1", businessDate: "2026-09-01" })],
    });
    expect(refills(i).map((t) => t.title)).toEqual([
      "Mystery Pack Plus är slut i Automat 1 – fyll på en hel omgång (14 st)",
    ]);
  });

  it("larmgränsen slår inte till före 0", () => {
    const alerts = [{ machineId: "m1", titleId: "mp", alertAtUnits: 5 }];
    expect(refills(base(3, { orders: [], slotAlerts: alerts }))).toEqual([]);
    const [empty] = refills(base(0, { orders: [], slotAlerts: alerts }));
    expect(empty?.title).toContain("fyll på en hel omgång");
  });

  it("withSlotAlerts lägger inte till larmgränsen för ett mystery-fack med pack", () => {
    const args = {
      alerts: [{ machineId: "m1", titleId: "mp", alertAtUnits: 5 }],
      machines: [machine("m1", "Automat 1")],
      titles: [MP],
      today: TODAY,
    };
    expect(
      withSlotAlerts([], { ...args, stock: [{ machineId: "m1", titleId: "mp", onHand: 3 }] }),
    ).toEqual([]);
    const [t] = withSlotAlerts([], {
      ...args,
      stock: [{ machineId: "m1", titleId: "mp", onHand: 0 }],
    });
    expect(t?.title).toBe("Mystery Pack Plus är slut i Automat 1 – fyll på en hel omgång (14 st)");
    expect(t?.detail).toContain("Saldo 0, larmgräns 5.");
  });

  it("förlorad försäljning räknas för ett tomt fack men ger ingen punkt före 0", () => {
    const lost = [{ key: "refill:m1:mp", lostRevenueOre: 50_000 }];
    expect(prioritizeByLostSales(refills(base(3)), lost)).toEqual([]);
    const [t] = prioritizeByLostSales(refills(base(0)), lost);
    expect(t?.evidence.figures.find((f) => f.key === "lostRevenueOre")?.value).toBe(50_000);
  });

  it("mysteryBatches: bara titlar med giltig omgång", () => {
    expect([
      ...mysteryBatches([MP, title("a", "A"), title("b", "B", { mysteryBatchSize: 0 })]),
    ]).toEqual([["mp", 14]]);
  });
});

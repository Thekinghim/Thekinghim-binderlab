import { describe, expect, it } from "vitest";

import {
  applyAdjustments,
  doneMessage,
  fillMachines,
  machineOrder,
  maxFill,
  pairKey,
  splitRefill,
  suggestFill,
  type FillInput,
  type FillMachineInput,
} from "./model";

const T1 = "t1";
const T2 = "t2";
const T3 = "t3";

function machine(
  id: string,
  code: string,
  fill: FillMachineInput["fill"],
  storeName: string | null = null,
): FillMachineInput {
  return { id, code, name: `Automat ${code}`, storeName, syncedAt: "2026-11-03T10:00:00Z", fill };
}

function input(partial: Partial<FillInput> & Pick<FillInput, "machines">): FillInput {
  return {
    titles: new Map([
      [T1, "Surging Sparks"],
      [T2, "Black Bolt"],
      [T3, "Perfect Order"],
    ]),
    machineStock: new Map(),
    home: new Map(),
    current: new Set(),
    retired: new Set(),
    ...partial,
  };
}

describe("suggestFill", () => {
  it("kapacitet − nu", () => {
    expect(suggestFill(3, 12, 100)).toBe(9);
  });
  it("aldrig fler än packen hemma", () => {
    expect(suggestFill(3, 12, 4)).toBe(4);
  });
  it("aldrig under 0: full automat, tomt hemma, negativt hemma", () => {
    expect(suggestFill(12, 12, 50)).toBe(0);
    expect(suggestFill(14, 12, 50)).toBe(0);
    expect(suggestFill(0, 12, 0)).toBe(0);
    expect(suggestFill(0, 12, -3)).toBe(0);
  });
  it("negativt saldo i automaten räknas som 0", () => {
    expect(suggestFill(-2, 12, 50)).toBe(12);
  });
  it("okänd kapacitet: inget förslag", () => {
    expect(suggestFill(0, null, 50)).toBe(0);
  });
});

describe("splitRefill", () => {
  it("tar från vårt lager så långt det räcker, resten utan uttag", () => {
    expect(splitRefill(9, 20)).toEqual({ fromWarehouse: 9, direct: 0 });
    expect(splitRefill(9, 4)).toEqual({ fromWarehouse: 4, direct: 5 });
    expect(splitRefill(9, 0)).toEqual({ fromWarehouse: 0, direct: 9 });
    expect(splitRefill(9, -5)).toEqual({ fromWarehouse: 0, direct: 9 });
  });
});

describe("maxFill", () => {
  it("upp till kapaciteten, minst 1; utan kapacitet 500", () => {
    expect(maxFill({ now: 3, capacity: 12 })).toBe(9);
    expect(maxFill({ now: 12, capacity: 12 })).toBe(1);
    expect(maxFill({ now: 0, capacity: null })).toBe(500);
  });
});

describe("fillMachines", () => {
  it("rader med nu/kapacitet, förslag, hemma och tomma fack", () => {
    const [m] = fillMachines(
      input({
        machines: [
          machine(
            "A",
            "BL-001",
            [
              { title_id: T1, units: 3, capacity: 12, channels: 2, empty: 1 },
              { title_id: T2, units: 8, capacity: 8, channels: 1, empty: 0 },
            ],
            "Sega gubben",
          ),
        ],
        machineStock: new Map([
          [pairKey("A", T1), 3],
          [pairKey("A", T2), 8],
        ]),
        home: new Map([
          [T1, 61],
          [T2, 4],
        ]),
      }),
    );
    expect(m).toMatchObject({
      place: "Sega gubben",
      emptySlots: 1,
      fillPct: 55, // 11 / 20
      suggested: 9,
    });
    expect(m!.rows).toEqual([
      {
        titleId: T1,
        name: "Surging Sparks",
        now: 3,
        capacity: 12,
        home: 61,
        suggested: 9,
        emptySlots: 1,
      },
      {
        titleId: T2,
        name: "Black Bolt",
        now: 8,
        capacity: 8,
        home: 4,
        suggested: 0,
        emptySlots: 0,
      },
    ]);
  });

  it("påfylld sedan Awish-läsningen: de tomma facken räknas som fyllda", () => {
    const [m] = fillMachines(
      input({
        machines: [
          machine("A", "BL-001", [{ title_id: T1, units: 0, capacity: 12, channels: 2, empty: 2 }]),
        ],
        machineStock: new Map([[pairKey("A", T1), 12]]),
        home: new Map([[T1, 10]]),
      }),
    );
    expect(m).toMatchObject({ emptySlots: 0, fillPct: 100, suggested: 0 });
  });

  it("titlar utan Awish: sortimentet och saldo > 0, men inte utgångna titlar utan pack", () => {
    const [m] = fillMachines(
      input({
        machines: [machine("A", "BL-001", null)],
        machineStock: new Map([
          [pairKey("A", T2), 4],
          [pairKey("A", T3), 0],
        ]),
        current: new Set([pairKey("A", T1)]),
        retired: new Set([pairKey("A", T3)]),
      }),
    );
    expect(m!.rows.map((r) => [r.name, r.now, r.capacity])).toEqual([
      ["Surging Sparks", 0, null],
      ["Black Bolt", 4, null],
    ]);
    expect(m).toMatchObject({ fillPct: null, emptySlots: 0, suggested: 0 });
  });

  it("ordning: tomma fack först (flest först), sedan lägst fyllnadsgrad, utan data sist", () => {
    const full = { title_id: T1, units: 10, capacity: 10, channels: 1, empty: 0 };
    const machines = fillMachines(
      input({
        machines: [
          machine("N", "BL-005", null),
          machine("F", "BL-004", [full]),
          machine("H", "BL-003", [{ ...full, units: 5 }]),
          machine("E1", "BL-002", [{ ...full, units: 9, channels: 2, empty: 1 }]),
          machine("E2", "BL-001", [{ ...full, units: 9, channels: 3, empty: 2 }]),
        ],
        machineStock: new Map([
          [pairKey("F", T1), 10],
          [pairKey("H", T1), 5],
          [pairKey("E1", T1), 9],
          [pairKey("E2", T1), 9],
        ]),
      }),
    );
    expect(machines.map((m) => m.id)).toEqual(["E2", "E1", "H", "F", "N"]);
  });

  it("lika behov ordnas efter kod (numeriskt)", () => {
    const a = { emptySlots: 0, fillPct: 50, code: "BL-10" };
    const b = { emptySlots: 0, fillPct: 50, code: "BL-9" };
    expect([a, b].sort(machineOrder).map((m) => m.code)).toEqual(["BL-9", "BL-10"]);
  });
});

describe("doneMessage", () => {
  it("antal påfyllda och kvar hemma", () => {
    expect(doneMessage(24, 61)).toBe("24 pack påfyllda, 61 kvar hemma");
    expect(doneMessage(3, -2)).toBe("3 pack påfyllda, 0 kvar hemma");
  });
});

describe("applyAdjustments", () => {
  const base = () =>
    fillMachines(
      input({
        machines: [
          machine("A", "BL-001", [{ title_id: T1, units: 0, capacity: 12, channels: 2, empty: 2 }]),
          machine("B", "BL-002", [{ title_id: T1, units: 6, capacity: 12, channels: 2, empty: 0 }]),
        ],
        machineStock: new Map([
          [pairKey("A", T1), 0],
          [pairKey("B", T1), 6],
        ]),
        home: new Map([[T1, 20]]),
      }),
    );

  it("påfyllning från vårt lager: automaten upp, hemma ner, ny ordning", () => {
    const machines = base();
    expect(machines.map((m) => m.id)).toEqual(["A", "B"]);
    const next = applyAdjustments(machines, { [T1]: 20 }, [
      { machineId: "A", titleId: T1, quantity: 12, fromWarehouse: true },
    ]);
    expect(next.home[T1]).toBe(8);
    expect(next.machines.map((m) => m.id)).toEqual(["B", "A"]);
    const a = next.machines.find((m) => m.id === "A")!;
    expect(a).toMatchObject({ fillPct: 100, emptySlots: 0, suggested: 0 });
    const b = next.machines.find((m) => m.id === "B")!;
    // Förslaget i B begränsas av det som är kvar hemma.
    expect(b.rows[0]).toMatchObject({ now: 6, home: 8, suggested: 6 });
  });

  it("utan uttag: hemma oförändrat", () => {
    const next = applyAdjustments(base(), { [T1]: 20 }, [
      { machineId: "B", titleId: T1, quantity: 2, fromWarehouse: false },
    ]);
    expect(next.home[T1]).toBe(20);
    expect(next.machines.find((m) => m.id === "B")!.rows[0]).toMatchObject({ now: 8 });
  });

  it("Räkna om ersätter saldot i automaten", () => {
    const next = applyAdjustments(base(), { [T1]: 20 }, [], new Map([[pairKey("B", T1), 2]]));
    expect(next.machines.find((m) => m.id === "B")!.rows[0]).toMatchObject({
      now: 2,
      suggested: 10,
    });
  });
});

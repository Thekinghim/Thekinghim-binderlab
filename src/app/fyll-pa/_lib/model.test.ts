import { describe, expect, it } from "vitest";

import {
  applyAdjustments,
  bringList,
  chooseSource,
  coverage,
  defaultBringSelection,
  doneMessage,
  fillHeadline,
  fillMachines,
  fullFastNote,
  machineOrder,
  maxFill,
  needLabel,
  packsWanted,
  pairKey,
  rowStatus,
  splitRefill,
  suggestFill,
  toggleBring,
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
        sold: 0,
        status: null,
      },
      {
        titleId: T2,
        name: "Black Bolt",
        now: 8,
        capacity: 8,
        home: 4,
        suggested: 0,
        emptySlots: 0,
        sold: 0,
        status: null,
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
    expect(doneMessage(5, 7, "Kontoret")).toBe("5 pack påfyllda, 7 kvar i Kontoret");
    expect(doneMessage(5, 7, "Hemma")).toBe("5 pack påfyllda, 7 kvar hemma");
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

  const H = () => "H";

  it("påfyllning från vårt lager: automaten upp, hemma ner, ny ordning", () => {
    const machines = base();
    expect(machines.map((m) => m.id)).toEqual(["A", "B"]);
    const next = applyAdjustments(
      machines,
      { H: { [T1]: 20 } },
      [{ machineId: "A", titleId: T1, quantity: 12, fromWarehouse: true }],
      new Map(),
      H,
    );
    expect(next.stock.H![T1]).toBe(8);
    expect(next.machines.map((m) => m.id)).toEqual(["B", "A"]);
    const a = next.machines.find((m) => m.id === "A")!;
    expect(a).toMatchObject({ fillPct: 100, emptySlots: 0, suggested: 0 });
    const b = next.machines.find((m) => m.id === "B")!;
    // Förslaget i B begränsas av det som är kvar hemma.
    expect(b.rows[0]).toMatchObject({ now: 6, home: 8, suggested: 6 });
  });

  it("utan uttag: hemma oförändrat", () => {
    const next = applyAdjustments(
      base(),
      { H: { [T1]: 20 } },
      [{ machineId: "B", titleId: T1, quantity: 2, fromWarehouse: false }],
      new Map(),
      H,
    );
    expect(next.stock.H![T1]).toBe(20);
    expect(next.machines.find((m) => m.id === "B")!.rows[0]).toMatchObject({ now: 8 });
  });

  it("Räkna om ersätter saldot i automaten", () => {
    const next = applyAdjustments(
      base(),
      { H: { [T1]: 20 } },
      [],
      new Map([[pairKey("B", T1), 2]]),
      H,
    );
    expect(next.machines.find((m) => m.id === "B")!.rows[0]).toMatchObject({
      now: 2,
      suggested: 10,
    });
  });

  it("flera lager: raderna visar lagret automaten fylls från, uttaget dras där", () => {
    const stock = { H: { [T1]: 20 }, K: { [T1]: 3 } };
    const sourceOf = (id: string) => (id === "A" ? "K" : "H");
    const next = applyAdjustments(
      base(),
      stock,
      [
        { machineId: "A", titleId: T1, quantity: 2, fromWarehouse: true },
        { machineId: "B", titleId: T1, quantity: 5, fromWarehouse: true, fromLocationId: "K" },
      ],
      new Map(),
      sourceOf,
    );
    // A (Kontoret) −2 och B:s uttag ur Kontoret −5: Kontoret −4, Hemma orört.
    expect(next.stock).toEqual({ H: { [T1]: 20 }, K: { [T1]: -4 } });
    expect(next.machines.find((m) => m.id === "A")!.rows[0]).toMatchObject({
      now: 2,
      home: -4,
      suggested: 0,
    });
    expect(next.machines.find((m) => m.id === "B")!.rows[0]).toMatchObject({ now: 11, home: 20 });
    // Indata ändras inte.
    expect(stock.K[T1]).toBe(3);
  });
});

describe("utan kapacitet (Awish har inte läst facken): sålt och slut styr", () => {
  it("rowStatus: 0 pack = slut, räcker under 2,5 dagar = snart slut (som Att göra)", () => {
    expect(rowStatus(0, 0)).toBe("empty");
    expect(rowStatus(-1, 5)).toBe("empty");
    // 4 pack, 28 sålda på 14 dagar = 2 per dag: räcker 2 dagar.
    expect(rowStatus(4, 28)).toBe("low");
    // 5 pack vid 2 per dag = 2,5 dagar: inte under gränsen.
    expect(rowStatus(5, 28)).toBeNull();
    expect(rowStatus(3, 0)).toBeNull();
  });

  it("förslaget: en veckas försäljning − nu för slut/snart slut, högst hemma", () => {
    expect(suggestFill(4, null, 100, 28)).toBe(10); // 14 − 4
    expect(suggestFill(0, null, 100, 7)).toBe(4); // tak(3,5)
    expect(suggestFill(0, null, 2, 28)).toBe(2);
    expect(suggestFill(8, null, 100, 28)).toBe(0); // räcker 4 dagar: inget
    expect(suggestFill(0, null, 100, 0)).toBe(0); // slut men ingen takt: välj själv
    // Känd kapacitet går före takten.
    expect(suggestFill(4, 12, 100, 28)).toBe(8);
  });

  it("automaten behöver påfyllning och sägs aldrig vara full", () => {
    const machines = fillMachines(
      input({
        machines: [machine("A", "BL-001", null, "Sega gubben"), machine("B", "BL-002", null)],
        machineStock: new Map([
          [pairKey("A", T1), 4],
          [pairKey("A", T2), 9],
          [pairKey("B", T2), 9],
        ]),
        home: new Map([
          [T1, 50],
          [T2, 50],
        ]),
        sold: new Map([
          [pairKey("A", T1), 28],
          [pairKey("A", T2), 2],
          [pairKey("B", T2), 2],
        ]),
      }),
    );
    const [a, b] = machines;
    expect(a).toMatchObject({
      id: "A",
      fillPct: null,
      low: 1,
      empty: 0,
      needs: true,
      suggested: 10,
    });
    expect(a!.rows[0]).toMatchObject({ name: "Surging Sparks", status: "low", suggested: 10 });
    expect(b).toMatchObject({ id: "B", fillPct: null, needs: false, suggested: 0 });
    expect(needLabel(a!)).toBe("1 snart slut");
    expect(needLabel(b!)).toBeNull();
    expect(fillHeadline(machines)).toBe("Fyll på 1 automat.");
    expect(fillHeadline([b!])).toBe("Inget är slut just nu.");
  });

  it("rubriken: fulla bara när kapaciteten är känd", () => {
    const full = { title_id: T1, units: 10, capacity: 10, channels: 1, empty: 0 };
    const known = fillMachines(
      input({
        machines: [machine("F", "BL-004", [full]), machine("G", "BL-005", [full])],
        machineStock: new Map([
          [pairKey("F", T1), 10],
          [pairKey("G", T1), 10],
        ]),
      }),
    );
    expect(fillHeadline(known)).toBe("Alla automater är fulla.");
    expect(fillHeadline(known.slice(0, 1))).toBe("Automaten är full.");
    expect(needLabel(known[0]!)).toBe("fullt");
    expect(fillHeadline([])).toBe("Inga automater.");
  });

  it("ordning: slut först, sedan snart slut, sedan fyllnadsgrad", () => {
    const a = { emptySlots: 0, empty: 0, low: 1, fillPct: null, code: "BL-1" };
    const b = { emptySlots: 0, empty: 2, low: 0, fillPct: null, code: "BL-2" };
    const c = { emptySlots: 0, empty: 0, low: 0, fillPct: 40, code: "BL-3" };
    expect([c, a, b].sort(machineOrder).map((m) => m.code)).toEqual(["BL-2", "BL-1", "BL-3"]);
  });

  it("Mina: automaten bär sitt ansvar (utelämnat = min)", () => {
    const [m, n] = fillMachines(
      input({
        machines: [{ ...machine("A", "BL-001", null), mine: false }, machine("B", "BL-002", null)],
      }),
    );
    expect([m!.id, m!.mine, n!.id, n!.mine]).toEqual(["A", false, "B", true]);
  });

  it("såld nyligen och nu 0 pack: slut, även utan fack eller sortiment (som Att göra)", () => {
    const [a] = fillMachines(
      input({
        machines: [machine("A", "BL-001", null)],
        machineStock: new Map([
          [pairKey("A", T1), 0],
          [pairKey("A", T2), 5],
        ]),
        home: new Map([[T1, 20]]),
        sold: new Map([
          [pairKey("A", T1), 14],
          [pairKey("A", T2), 1],
        ]),
      }),
    );
    expect(a).toMatchObject({ empty: 1, needs: true });
    expect(a!.rows[0]).toMatchObject({ name: "Surging Sparks", status: "empty", suggested: 7 });
    expect(needLabel(a!)).toBe("1 slut");
  });

  it("påfyllning utan kapacitet: läget räknas om", () => {
    const machines = fillMachines(
      input({
        machines: [machine("A", "BL-001", null)],
        machineStock: new Map([[pairKey("A", T1), 0]]),
        current: new Set([pairKey("A", T1)]),
        home: new Map([[T1, 20]]),
        sold: new Map([[pairKey("A", T1), 14]]),
      }),
    );
    expect(machines[0]).toMatchObject({ empty: 1, suggested: 7, needs: true });
    const out = applyAdjustments(machines, {}, [
      { machineId: "A", titleId: T1, quantity: 7, fromWarehouse: false },
    ]);
    expect(out.machines[0]).toMatchObject({ empty: 0, low: 0, suggested: 0, needs: false });
    expect(out.machines[0]!.rows[0]).toMatchObject({ now: 7, status: null });
  });
});

describe("fullt fack som säljer fort (inte snart slut)", () => {
  it("rowStatus: nu ≥ kapacitet är aldrig slut eller snart slut", () => {
    // 14 pack, 100 sålda på 14 dagar: räcker ~2 dagar men facket är fullt.
    expect(rowStatus(14, 100, 14)).toBeNull();
    expect(rowStatus(15, 100, 14)).toBeNull();
    // Inte fullt: som förut.
    expect(rowStatus(13, 100, 14)).toBe("low");
    expect(rowStatus(0, 5, 14)).toBe("empty");
    // Okänd kapacitet: som förut.
    expect(rowStatus(4, 28, null)).toBe("low");
  });

  it("fullFastNote: lugn rad för fullt fack som annars vore snart slut", () => {
    expect(fullFastNote({ now: 14, capacity: 14, sold: 100 })).toBe("Fullt · räcker ~2 d");
    expect(fullFastNote({ now: 14, capacity: 14, sold: 300 })).toBe("Fullt · räcker ~1 d");
    expect(fullFastNote({ now: 14, capacity: 14, sold: 10 })).toBeNull();
    expect(fullFastNote({ now: 13, capacity: 14, sold: 100 })).toBeNull();
    expect(fullFastNote({ now: 4, capacity: null, sold: 28 })).toBeNull();
  });

  it("automaten: fullt fack räknas inte som snart slut och kräver inget", () => {
    const [m] = fillMachines(
      input({
        machines: [
          machine("m1", "BL-001", [
            { title_id: T1, units: 14, capacity: 14, channels: 1, empty: 0 },
          ]),
        ],
        machineStock: new Map([[pairKey("m1", T1), 14]]),
        sold: new Map([[pairKey("m1", T1), 100]]),
        home: new Map([[T1, 169]]),
      }),
    );
    expect(m!.rows[0]!.status).toBeNull();
    expect(m!.low).toBe(0);
    expect(m!.needs).toBe(false);
    expect(needLabel(m!)).toBe("fullt");
    expect(fillHeadline([m!])).toBe("Automaten är full.");
  });

  it("applyAdjustments: påfyllt till fullt slutar vara snart slut", () => {
    const machines = fillMachines(
      input({
        machines: [
          machine("m1", "BL-001", [
            { title_id: T1, units: 2, capacity: 14, channels: 1, empty: 0 },
          ]),
        ],
        machineStock: new Map([[pairKey("m1", T1), 2]]),
        sold: new Map([[pairKey("m1", T1), 100]]),
      }),
    );
    expect(machines[0]!.low).toBe(1);
    const out = applyAdjustments(machines, {}, [
      { machineId: "m1", titleId: T1, quantity: 12, fromWarehouse: false },
    ]);
    expect(out.machines[0]!.rows[0]!.status).toBeNull();
    expect(out.machines[0]!.low).toBe(0);
  });
});

describe("chooseSource: lagret som har packen", () => {
  const places = [
    { id: "kontoret", name: "Kontoret" },
    { id: "hemma", name: "Hemma" },
  ];
  // Två titlar som vill ha 10 + 7 pack.
  const rows = [
    { titleId: T1, now: 4, capacity: 14, sold: 10 },
    { titleId: T2, now: 7, capacity: 14, sold: 2 },
  ];

  it("packsWanted och coverage", () => {
    expect(packsWanted(rows[0]!)).toBe(10);
    expect(coverage(rows, { [T1]: 3, [T2]: 50 })).toBe(10);
    expect(coverage(rows, undefined)).toBe(0);
    expect(coverage(rows, { [T1]: -4 })).toBe(0);
  });

  it("automatens lager saknar packen: lagret med flest väljs, skälet sägs", () => {
    const c = chooseSource({
      places,
      stock: { kontoret: { [T1]: 0 }, hemma: { [T1]: 169, [T2]: 3 } },
      rows,
      preferred: ["kontoret", null, "kontoret"],
    });
    expect(c).toEqual({ id: "hemma", reason: "Kontoret saknar pack" });
  });

  it("automatens lager räcker: det används, inget skäl", () => {
    const c = chooseSource({
      places,
      stock: { kontoret: { [T1]: 10, [T2]: 7 }, hemma: { [T1]: 169, [T2]: 30 } },
      rows,
      preferred: ["kontoret"],
    });
    expect(c).toEqual({ id: "kontoret", reason: null });
  });

  it("klart sämre (högst hälften): byts, med antalet", () => {
    const c = chooseSource({
      places,
      stock: { kontoret: { [T1]: 3 }, hemma: { [T1]: 10, [T2]: 7 } },
      rows,
      preferred: ["kontoret"],
    });
    expect(c).toEqual({ id: "hemma", reason: "Kontoret har bara 3" });
    // Lite sämre: stannar.
    expect(
      chooseSource({
        places,
        stock: { kontoret: { [T1]: 10 }, hemma: { [T1]: 10, [T2]: 7 } },
        rows,
        preferred: ["kontoret"],
      }).id,
    ).toBe("kontoret");
  });

  it("inget lager har packen, eller inget behövs: det föreslagna lagret", () => {
    expect(chooseSource({ places, stock: {}, rows, preferred: ["kontoret"] })).toEqual({
      id: "kontoret",
      reason: null,
    });
    const full = [{ titleId: T1, now: 14, capacity: 14, sold: 100 }];
    expect(
      chooseSource({
        places,
        stock: { hemma: { [T1]: 169 } },
        rows: full,
        preferred: ["kontoret"],
      }),
    ).toEqual({ id: "kontoret", reason: null });
  });

  it("lika: det föreslagna först, sedan namn", () => {
    const three = [...places, { id: "bilen", name: "Bilen" }];
    const stock = { hemma: { [T1]: 10 }, bilen: { [T1]: 10 } };
    expect(chooseSource({ places: three, stock, rows, preferred: ["kontoret"] }).id).toBe("bilen");
    expect(chooseSource({ places: three, stock, rows, preferred: ["hemma"] }).id).toBe("hemma");
  });

  it("valt för automaten nu gäller alltid; tomt lager får en hint", () => {
    const stock = { kontoret: {}, hemma: { [T1]: 169 } };
    expect(
      chooseSource({ places, stock, rows, explicit: "kontoret", preferred: ["kontoret"] }),
    ).toEqual({ id: "kontoret", reason: "Hemma har pack" });
    expect(
      chooseSource({ places, stock, rows, explicit: "hemma", preferred: ["kontoret"] }),
    ).toEqual({
      id: "hemma",
      reason: null,
    });
    // Ett borttaget lager som val ignoreras.
    expect(
      chooseSource({ places, stock, rows, explicit: "borta", preferred: ["kontoret"] }).id,
    ).toBe("hemma");
  });

  it("senast valda (minnet) som saknar pack styr inte när ett annat har dem", () => {
    const c = chooseSource({
      places,
      stock: { kontoret: {}, hemma: { [T1]: 20 } },
      rows,
      preferred: [undefined, "kontoret", "hemma"],
    });
    expect(c).toEqual({ id: "hemma", reason: "Kontoret saknar pack" });
  });

  it("inga lager: null", () => {
    expect(chooseSource({ places: [], stock: {}, rows, preferred: [] })).toEqual({
      id: null,
      reason: null,
    });
  });
});

describe("Ta med-listan (bringList)", () => {
  const MYSTERY = "t3";
  const machines = () =>
    fillMachines(
      input({
        machines: [
          machine(
            "m1",
            "BL-001",
            [
              { title_id: T1, units: 2, capacity: 12, channels: 2, empty: 1 },
              { title_id: T2, units: 6, capacity: 6, channels: 1, empty: 0 },
            ],
            "ICA Lund",
          ),
          machine(
            "m2",
            "BL-002",
            [
              { title_id: T1, units: 0, capacity: 8, channels: 1, empty: 1 },
              { title_id: MYSTERY, units: 0, capacity: 14, channels: 1, empty: 1 },
            ],
            "Coop Malmö",
          ),
          machine("m3", "BL-003", null, "Willys"),
        ],
        machineStock: new Map([
          [pairKey("m1", T1), 2],
          [pairKey("m1", T2), 6],
          [pairKey("m2", T1), 0],
          [pairKey("m2", MYSTERY), 0],
        ]),
        home: new Map([
          [T1, 100],
          [MYSTERY, 100],
        ]),
        mystery: new Map([[MYSTERY, 14]]),
      }),
    );

  it("per automat och totalt: det som får plats, oberoende av lagret", () => {
    const list = bringList(machines(), new Set(["m1", "m2"]), { [T1]: 50, [MYSTERY]: 28 });
    const m1 = list.machines.find((m) => m.id === "m1")!;
    const m2 = list.machines.find((m) => m.id === "m2")!;
    // m1: 10 Surging Sparks (12 − 2); Black Bolt är full och står inte med.
    expect(m1.lines).toEqual([{ titleId: T1, name: "Surging Sparks", want: 10 }]);
    expect(m1.want).toBe(10);
    // m2: en hel mystery-omgång (14) och 8 Surging Sparks, flest först.
    expect(m2.lines.map((l) => [l.titleId, l.want])).toEqual([
      [MYSTERY, 14],
      [T1, 8],
    ]);
    expect(list.totals).toEqual([
      { titleId: T1, name: "Surging Sparks", want: 18, have: 50, bring: 18, missing: 0 },
      { titleId: MYSTERY, name: "Perfect Order", want: 14, have: 28, bring: 14, missing: 0 },
    ]);
    expect(list).toMatchObject({ want: 32, bring: 32, missing: 0 });
  });

  it("varnar när lagret inte räcker: det som saknas står först", () => {
    const list = bringList(machines(), new Set(["m1", "m2"]), { [T1]: 11, [MYSTERY]: 28 });
    expect(list.totals[0]).toEqual({
      titleId: T1,
      name: "Surging Sparks",
      want: 18,
      have: 11,
      bring: 11,
      missing: 7,
    });
    expect(list).toMatchObject({ want: 32, bring: 25, missing: 7 });
  });

  it("mystery pack: bara hela omgångar ur lagret, och ett negativt saldo är 0", () => {
    const list = bringList(machines(), new Set(["m2"]), { [T1]: -3, [MYSTERY]: 13 });
    const byId = new Map(list.totals.map((t) => [t.titleId, t]));
    expect(byId.get(MYSTERY)).toMatchObject({ want: 14, have: 13, bring: 0, missing: 14 });
    expect(byId.get(T1)).toMatchObject({ want: 8, have: 0, bring: 0, missing: 8 });
    expect(list.bring).toBe(0);
  });

  it("bara de valda automaterna räknas", () => {
    const list = bringList(machines(), new Set(["m1"]), { [T1]: 50 });
    expect(list.machines.map((m) => m.id)).toEqual(["m1"]);
    expect(list.totals).toHaveLength(1);
    expect(list.want).toBe(10);
    expect(bringList(machines(), new Set(), { [T1]: 50 })).toMatchObject({
      machines: [],
      totals: [],
      want: 0,
      bring: 0,
      missing: 0,
    });
  });

  it("utan eget lager: allt tas med och inget räknas som saknat", () => {
    const list = bringList(machines(), new Set(["m1", "m2"]), null);
    expect(list.totals.every((t) => t.have === null && t.missing === 0)).toBe(true);
    expect(list.bring).toBe(32);
  });

  it("en full automat och en utan Awish-läsning: inget att ta med, med rätt skäl", () => {
    const full = fillMachines(
      input({
        machines: [
          machine("m1", "BL-001", [{ title_id: T2, units: 6, capacity: 6, channels: 1, empty: 0 }]),
          machine("m3", "BL-003", null),
        ],
        machineStock: new Map([[pairKey("m1", T2), 6]]),
      }),
    );
    const list = bringList(full, new Set(["m1", "m3"]), {});
    expect(list.want).toBe(0);
    expect(list.machines.find((m) => m.id === "m1")).toMatchObject({ known: true, lines: [] });
    expect(list.machines.find((m) => m.id === "m3")).toMatchObject({ known: false, lines: [] });
  });

  it("från början är automaterna som behöver pack valda, annars alla", () => {
    expect(defaultBringSelection(machines()).sort()).toEqual(["m1", "m2"]);
    const full = fillMachines(
      input({
        machines: [
          machine("m1", "BL-001", [{ title_id: T2, units: 6, capacity: 6, channels: 1, empty: 0 }]),
        ],
        machineStock: new Map([[pairKey("m1", T2), 6]]),
      }),
    );
    expect(defaultBringSelection(full)).toEqual(["m1"]);
  });

  it("ett tryck lägger till eller tar bort en automat, från förvalet eller från valet", () => {
    // Förvalet (null): m1 och m2 behöver pack. Ett tryck på m2 tar bort den.
    expect(toggleBring(null, machines(), "m2")).toEqual(["m1"]);
    expect(toggleBring(null, machines(), "m3").sort()).toEqual(["m1", "m2", "m3"]);
    // Två tryck i följd räknas båda (det andra utgår från det första).
    const afterFirst = toggleBring(null, machines(), "m1");
    expect(toggleBring(afterFirst, machines(), "m2")).toEqual([]);
    expect(toggleBring([], machines(), "m3")).toEqual(["m3"]);
  });

  it("påfyllningar i kön (utan nät) minskar behovet och lagret", () => {
    const out = applyAdjustments(
      machines(),
      { home: { [T1]: 20 } },
      [{ machineId: "m1", titleId: T1, quantity: 6, fromWarehouse: true, fromLocationId: "home" }],
      new Map(),
      () => "home",
    );
    const list = bringList(out.machines, new Set(["m1", "m2"]), out.stock.home ?? {});
    // m1 vill nu ha 4 (12 − 8), m2 fortfarande 8; lagret har 14 kvar.
    expect(list.totals.find((t) => t.titleId === T1)).toMatchObject({
      want: 12,
      have: 14,
      bring: 12,
      missing: 0,
    });
  });
});

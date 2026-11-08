/**
 * Mystery packs på Fyll på: facket fylls bara på när det är tomt, med exakt en hel omgång.
 */
import { describe, expect, it } from "vitest";

import { MYSTERY_TOP_UP_WARNING } from "@/domain";

import {
  applyAdjustments,
  coverage,
  fillAllQty,
  fillMachines,
  maxFill,
  mysteryNote,
  pairKey,
  qtyAfterCount,
  rowStatus,
  suggestFill,
  type FillInput,
} from "./model";

const M = "m1";
const MP = "mp";
const T = "t1";

function input(units: number, opts: { capacity?: number; home?: number } = {}): FillInput {
  const capacity = opts.capacity ?? 20;
  return {
    machines: [
      {
        id: M,
        code: "BL-001",
        name: "Automat 1",
        storeName: "ICA",
        syncedAt: "2026-11-08T08:00:00Z",
        fill: [
          { title_id: MP, units, capacity, channels: 2, empty: units === 0 ? 2 : 1 },
          { title_id: T, units: 5, capacity: 10, channels: 1, empty: 0 },
        ],
      },
    ],
    titles: new Map([
      [MP, "Mystery Pack Plus"],
      [T, "Surging Sparks"],
    ]),
    machineStock: new Map([
      [pairKey(M, MP), units],
      [pairKey(M, T), 5],
    ]),
    home: new Map([
      [MP, opts.home ?? 28],
      [T, 50],
    ]),
    current: new Set(),
    retired: new Set(),
    // Säljer fort: skulle vara "snart slut" för en vanlig titel.
    sold: new Map([[pairKey(M, MP), 140]]),
    mystery: new Map([[MP, 14]]),
  };
}

const rowOf = (i: FillInput) => fillMachines(i)[0]!.rows.find((r) => r.titleId === MP)!;

describe("Fyll på: mystery packs", () => {
  it("förslaget är 0 medan facket har pack, och aldrig snart slut eller tom plats", () => {
    const r = rowOf(input(3));
    expect(r.suggested).toBe(0);
    expect(r.status).toBeNull();
    expect(r.emptySlots).toBe(0);
    expect(r.batchSize).toBe(14);
    // Den vanliga titeln bredvid fylls som vanligt.
    const m = fillMachines(input(3))[0]!;
    expect(m.rows.find((x) => x.titleId === T)!.suggested).toBe(5);
    expect(m.low).toBe(0);
  });

  it("tomt fack: slut och förslaget är exakt en omgång (inte kapaciteten)", () => {
    const r = rowOf(input(0, { capacity: 20 }));
    expect(r.status).toBe("empty");
    expect(r.suggested).toBe(14);
    expect(r.emptySlots).toBe(2);
  });

  it("lagret har inte en hel omgång: inget förslag (en del av en omgång fylls inte)", () => {
    expect(rowOf(input(0, { home: 10 })).suggested).toBe(0);
    expect(suggestFill(0, 20, 13, 0, 14)).toBe(0);
    expect(suggestFill(0, 20, 14, 0, 14)).toBe(14);
  });

  it("rowStatus: bara slut för mystery packs", () => {
    expect(rowStatus(1, 1000, 20, 14)).toBeNull();
    expect(rowStatus(0, 0, 20, 14)).toBe("empty");
    // Utan omgång: vanlig regel (snart slut).
    expect(rowStatus(1, 1000, 20)).toBe("low");
  });

  it("Fyll allt: en omgång i ett tomt fack, 0 i ett som har pack", () => {
    expect(fillAllQty({ now: 0, capacity: 20, batchSize: 14 }, 0)).toBe(14);
    expect(fillAllQty({ now: 3, capacity: 20, batchSize: 14 }, 5)).toBe(0);
    expect(fillAllQty({ now: 3, capacity: 20 }, 0)).toBe(17);
    expect(fillAllQty({ now: 3, capacity: null }, 4)).toBe(4);
  });

  it("stegaren: en hel omgång går alltid att välja, även när facket rymmer färre", () => {
    expect(maxFill({ now: 0, capacity: 10, batchSize: 14 })).toBe(14);
    expect(maxFill({ now: 0, capacity: 20, batchSize: 14 })).toBe(20);
    expect(maxFill({ now: 0, capacity: 10 })).toBe(10);
  });

  it("varnar lugnt när man fyller i ett antal för ett fack som inte är tomt", () => {
    expect(mysteryNote({ now: 3, capacity: 20, batchSize: 14 }, 5)).toBe(MYSTERY_TOP_UP_WARNING);
    expect(mysteryNote({ now: 3, capacity: 20, batchSize: 14 }, 0)).toBeNull();
    expect(mysteryNote({ now: 0, capacity: 20, batchSize: 14 }, 14)).toBeNull();
    expect(mysteryNote({ now: 3, capacity: 20 }, 5)).toBeNull();
  });

  it("varnar när en hel omgång inte får plats i facket", () => {
    expect(mysteryNote({ now: 0, capacity: 10, batchSize: 14 }, 14)).toBe(
      "Facket rymmer 10, en omgång är 14 st",
    );
  });

  it("Räkna om stoppas aldrig: efter räkningen räknas förslaget om", () => {
    const row = { capacity: 20, home: 28, batchSize: 14 };
    expect(qtyAfterCount(row, 0)).toBe(14);
    expect(qtyAfterCount(row, 2)).toBe(0);
    expect(qtyAfterCount({ capacity: 20, home: 28 }, 2)).toBe(18);
    expect(qtyAfterCount({ capacity: null, home: 28 }, 2)).toBeNull();
  });

  it("påfyllning eller räkning i webbläsaren räknar om med samma regel", () => {
    const machines = fillMachines(input(0));
    const stock = { home: { [MP]: 28, [T]: 50 } };
    const counted = applyAdjustments(
      machines,
      stock,
      [],
      new Map([[pairKey(M, MP), 2]]),
      () => "home",
    ).machines[0]!.rows.find((r) => r.titleId === MP)!;
    expect(counted.suggested).toBe(0);
    expect(counted.status).toBeNull();
    expect(counted.emptySlots).toBe(0);
    const refilled = applyAdjustments(
      machines,
      stock,
      [{ machineId: M, titleId: MP, quantity: 14, fromWarehouse: true }],
      new Map(),
      () => "home",
    ).machines[0]!.rows.find((r) => r.titleId === MP)!;
    expect(refilled.now).toBe(14);
    expect(refilled.suggested).toBe(0);
  });

  it("lagret som täcker mest räknar bara hela omgångar", () => {
    const rows = [{ titleId: MP, now: 0, capacity: 20, sold: 0, batchSize: 14 }];
    expect(coverage(rows, { [MP]: 13 })).toBe(0);
    expect(coverage(rows, { [MP]: 30 })).toBe(14);
  });
});

import { describe, expect, it } from "vitest";

import {
  bringStrip,
  cardChip,
  fillAction,
  fillPacks,
  glyphSlotsOf,
  glyphStatusFor,
  listGroups,
  minutesAt,
  nextMachineId,
  receiptItems,
} from "./list";
import { fillMachines, pairKey, type AwishFillEntry, type FillInput } from "./model";

type Fill = AwishFillEntry;
const f = (title_id: string, units: number, capacity: number, empty = 0): Fill => ({
  title_id,
  units,
  capacity,
  channels: 1,
  empty,
});

function machines(
  list: { id: string; fill: Fill[] | null; channels?: Record<string, string> }[],
  home = 50,
) {
  const all = list.flatMap((m) => m.fill ?? []);
  const input: FillInput = {
    machines: list.map((m, i) => ({
      id: m.id,
      code: `NA-0${i + 1}`,
      name: `Automat 0${i + 1}`,
      storeName: `Butik ${m.id}`,
      syncedAt: m.fill ? "2026-11-20T10:00:00Z" : null,
      fill: m.fill,
      channels: m.channels ?? null,
    })),
    titles: new Map(all.map((x) => [x.title_id, `Titel ${x.title_id}`])),
    machineStock: new Map(
      list.flatMap((m) => (m.fill ?? []).map((x) => [pairKey(m.id, x.title_id), x.units] as const)),
    ),
    home: new Map(all.map((x) => [x.title_id, home])),
    current: new Set(),
    retired: new Set(),
  };
  return fillMachines(input);
}

describe("listans grupper", () => {
  it("behöver påfyllning först, sedan okänd nivå, sedan fulla", () => {
    const ms = machines([
      { id: "full", fill: [f("a", 10, 10)] },
      { id: "tom", fill: [f("a", 0, 10, 1)] },
      { id: "okand", fill: null },
    ]);
    const g = listGroups(ms);
    expect(g.need.map((m) => m.id)).toEqual(["tom"]);
    expect(g.unknown.map((m) => m.id)).toEqual(["okand"]);
    expect(g.full.map((m) => m.id)).toEqual(["full"]);
  });
});

describe("skärmen på bilden", () => {
  it("ett fack per titel i fackordningen, tomt och fyllnad, okänd utan kapacitet", () => {
    const [m] = machines([
      { id: "A", fill: [f("a", 5, 10), f("b", 0, 8, 1)], channels: { A1: "b", A2: "a" } },
    ]);
    expect(glyphSlotsOf(m!)).toEqual([
      { title: "Titel b", fill: 0, empty: true },
      { title: "Titel a", fill: 0.5, empty: false },
    ]);
    expect(glyphStatusFor(m!, null)).toBe("empty");
    expect(glyphStatusFor(m!, "offline")).toBe("offline");
  });

  it("läget: fyll på när något ska fyllas, ok när allt är fullt", () => {
    const [need, full] = machines([
      { id: "A", fill: [f("a", 5, 10)] },
      { id: "B", fill: [f("a", 10, 10)] },
    ]);
    expect(glyphStatusFor(need!, null)).toBe("refill");
    expect(glyphStatusFor(full!, "power_off")).toBe("ok");
  });
});

describe("kortets pack och knapp", () => {
  it("slut först med +N, sedan flest pack; fulla titlar syns inte", () => {
    const [m] = machines([{ id: "A", fill: [f("a", 8, 10), f("b", 0, 6, 1), f("c", 10, 10)] }]);
    expect(fillPacks(m!)).toEqual([
      { titleId: "b", name: "Titel b", want: 6, empty: true },
      { titleId: "a", name: "Titel a", want: 2, empty: false },
    ]);
    expect(fillAction(fillPacks(m!))).toEqual({ label: "Fyll 2 titlar", packs: "8 pack" });
  });

  it("en titel i singular, och inget antal när det är okänt", () => {
    expect(fillAction([{ titleId: "x", name: "X", want: 0, empty: true }])).toEqual({
      label: "Fyll 1 titel",
      packs: null,
    });
  });

  it("märket: offline, slut, tomma platser, snart slut, strömmen av", () => {
    const base = { empty: 0, emptySlots: 0, low: 0 };
    expect(cardChip({ ...base, empty: 2 }, "offline")?.text).toBe("Offline");
    expect(cardChip({ ...base, empty: 2 }, null)).toEqual({ tone: "critical", text: "2 slut" });
    expect(cardChip({ ...base, emptySlots: 1 }, null)?.text).toBe("1 tom plats");
    expect(cardChip({ ...base, low: 3 }, null)).toEqual({
      tone: "warning",
      text: "3 snart slut",
    });
    expect(cardChip(base, "power_off")?.text).toBe("Strömmen av");
    expect(cardChip(base, null)).toBeNull();
  });
});

describe("Ta med", () => {
  it("summerar det automaterna vill ha per titel, flest först", () => {
    const ms = machines([
      { id: "A", fill: [f("a", 0, 10, 1), f("b", 4, 6)] },
      { id: "B", fill: [f("a", 5, 10)] },
    ]);
    expect(bringStrip(ms)).toEqual({
      items: [
        { titleId: "a", name: "Titel a", want: 15 },
        { titleId: "b", name: "Titel b", want: 2 },
      ],
      total: 17,
    });
  });
});

describe("kvittot", () => {
  it("minuter vid automaten: minst 1, null när orimligt eller okänt", () => {
    const t0 = Date.parse("2026-11-23T09:00:00Z");
    expect(minutesAt(t0, t0 + 6 * 60_000 + 10_000)).toBe(6);
    expect(minutesAt(t0, t0 + 5_000)).toBe(1);
    expect(minutesAt(t0, t0 + 4 * 3_600_000)).toBeNull();
    expect(minutesAt(null, t0)).toBeNull();
    expect(minutesAt(t0, t0 - 1)).toBeNull();
  });

  it("packen per titel, flest först, utan nollor", () => {
    expect(
      receiptItems([
        { row: { titleId: "a", name: "A" }, quantity: 2 },
        { row: { titleId: "b", name: "B" }, quantity: 10 },
        { row: { titleId: "c", name: "C" }, quantity: 0 },
      ]),
    ).toEqual([
      { titleId: "b", name: "B", qty: 10 },
      { titleId: "a", name: "A", qty: 2 },
    ]);
  });

  it("nästa: ruttens nästa stopp, annars nästa som behöver påfyllning", () => {
    const ms = [
      { id: "A", needs: true },
      { id: "B", needs: false },
      { id: "C", needs: true },
    ];
    expect(nextMachineId({ justFilled: "A", routeNext: "B", machines: ms })).toBe("B");
    expect(nextMachineId({ justFilled: "A", machines: ms })).toBe("C");
    expect(nextMachineId({ justFilled: "C", machines: [{ id: "C", needs: true }] })).toBeNull();
  });
});

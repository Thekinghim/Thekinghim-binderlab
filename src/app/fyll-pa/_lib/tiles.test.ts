import { describe, expect, it } from "vitest";

import { fillMachines, pairKey, slotTitleOrder, type FillInput, type FillRow } from "./model";
import {
  bringCount,
  initialSelection,
  inSlotOrder,
  listChip,
  setQty,
  stepperBounds,
  tapQty,
  tapTile,
  tileView,
  urgentPacks,
} from "./tiles";

function row(partial: Partial<FillRow> & Pick<FillRow, "titleId">): FillRow {
  return {
    name: partial.titleId,
    now: 0,
    capacity: 10,
    home: 50,
    suggested: 0,
    emptySlots: 0,
    sold: 0,
    status: null,
    ...partial,
  };
}

function machineWith(fill: NonNullable<FillInput["machines"][number]["fill"]>, home: number) {
  const input: FillInput = {
    machines: [
      {
        id: "A",
        code: "BL-001",
        name: "Automat 01",
        storeName: "Sega gubben",
        syncedAt: "2026-11-03T10:00:00Z",
        fill,
      },
    ],
    titles: new Map(fill.map((f) => [f.title_id, `Titel ${f.title_id}`])),
    machineStock: new Map(fill.map((f) => [pairKey("A", f.title_id), f.units])),
    home: new Map(fill.map((f) => [f.title_id, home])),
    current: new Set(),
    retired: new Set(),
  };
  return fillMachines(input)[0]!;
}

describe("valet när automaten öppnas", () => {
  it("är tomt: inget är förifyllt, inte ens när förslaget är större än 0", () => {
    const m = machineWith([{ title_id: "t1", units: 4, capacity: 10, channels: 1, empty: 0 }], 50);
    expect(m.rows[0]!.suggested).toBe(6);
    const sel = initialSelection();
    expect(sel).toEqual({});
    expect(m.rows.reduce((n, r) => n + (sel[r.titleId] ?? 0), 0)).toBe(0);
  });
});

describe("tryck på en ruta", () => {
  it("fyller facket till fullt (kapacitet − nu) när lagret räcker", () => {
    const m = machineWith([{ title_id: "t1", units: 4, capacity: 10, channels: 1, empty: 0 }], 50);
    const r = m.rows[0]!;
    expect(tapQty(r, true)).toBe(6);
    expect(tapTile(initialSelection(), r, true)).toEqual({ selection: { t1: 6 }, sheet: false });
  });

  it("högst packen i lagret man fyller från", () => {
    const m = machineWith([{ title_id: "t1", units: 4, capacity: 10, channels: 1, empty: 0 }], 2);
    expect(tapTile({}, m.rows[0]!, true)).toEqual({ selection: { t1: 2 }, sheet: false });
  });

  it("inget i lagret: inget väljs, arket öppnas (där går det att fylla ändå)", () => {
    const m = machineWith([{ title_id: "t1", units: 4, capacity: 10, channels: 1, empty: 0 }], 0);
    expect(tapTile({}, m.rows[0]!, true)).toEqual({ selection: {}, sheet: true });
  });

  it("utan eget lager: kapacitet − nu utan tak", () => {
    const r = row({ titleId: "t1", now: 3, capacity: 10, home: 0, suggested: 0 });
    expect(tapQty(r, false)).toBe(7);
  });

  it("fullt fack: arket öppnas (Fel antal i automaten?)", () => {
    const r = row({ titleId: "t1", now: 10, capacity: 10, suggested: 0 });
    expect(tapTile({}, r, true)).toEqual({ selection: {}, sheet: true });
  });

  it("vald ruta: arket öppnas och antalet står kvar", () => {
    const r = row({ titleId: "t1", now: 4, suggested: 6 });
    const sel = { t1: 6 };
    expect(tapTile(sel, r, true)).toEqual({ selection: sel, sheet: true });
  });

  it("mystery pack: en hel omgång när facket är tomt och lagret har en, annars arket", () => {
    const empty = row({ titleId: "m", now: 0, capacity: 20, batchSize: 14, suggested: 14 });
    expect(tapTile({}, empty, true)).toEqual({ selection: { m: 14 }, sheet: false });
    const short = row({ titleId: "m", now: 0, capacity: 20, batchSize: 14, home: 3, suggested: 0 });
    expect(tapTile({}, short, true).sheet).toBe(true);
    const left = row({ titleId: "m", now: 5, capacity: 20, batchSize: 14, suggested: 0 });
    expect(tapTile({}, left, true).sheet).toBe(true);
  });
});

describe("stegaren i arket", () => {
  it("går från 0 till taket (kapacitet − nu, minst 1; mystery minst en omgång)", () => {
    expect(stepperBounds({ now: 4, capacity: 10 })).toEqual({ min: 0, max: 6 });
    expect(stepperBounds({ now: 10, capacity: 10 })).toEqual({ min: 0, max: 1 });
    expect(stepperBounds({ now: 0, capacity: 10, batchSize: 14 })).toEqual({ min: 0, max: 14 });
    expect(stepperBounds({ now: 0, capacity: null })).toEqual({ min: 0, max: 500 });
  });

  it("antalet hålls inom gränserna, och Töm ger 0", () => {
    const r = row({ titleId: "t1", now: 4, capacity: 10 });
    expect(setQty({}, r, 99)).toEqual({ t1: 6 });
    expect(setQty({ t1: 3 }, r, -2)).toEqual({ t1: 0 });
    expect(setQty({ t1: 3, t2: 1 }, r, 0)).toEqual({ t1: 0, t2: 1 });
    expect(setQty({}, r, 2.7)).toEqual({ t1: 2 });
  });
});

describe("rutans visning", () => {
  it("nytt antal av kapaciteten, grönt när fullt, Slut när tomt och inget valt", () => {
    expect(tileView({ now: 0, capacity: 10 }, 0)).toMatchObject({
      shown: 0,
      full: false,
      out: true,
    });
    expect(tileView({ now: 0, capacity: 10 }, 10)).toMatchObject({
      shown: 10,
      full: true,
      out: false,
      shownShare: 1,
    });
    expect(tileView({ now: 6, capacity: 10 }, 0)).toMatchObject({ nowShare: 0.6, full: false });
    expect(tileView({ now: 3, capacity: null }, 4)).toMatchObject({ shown: 7, full: false });
  });
});

describe("fackordningen", () => {
  it("kanalerna i naturlig ordning, sedan Awish-läsningen", () => {
    expect(
      slotTitleOrder({ B1: "c", A10: "b", A2: "a", A3: "a" }, [
        { title_id: "d" },
        { title_id: "a" },
      ]),
    ).toEqual(["a", "b", "c", "d"]);
    expect(slotTitleOrder(null, [{ title_id: "x" }, { title_id: "y" }])).toEqual(["x", "y"]);
  });

  it("rutorna följer facken; titlar utan fack sist", () => {
    const rows = [row({ titleId: "z" }), row({ titleId: "b" }), row({ titleId: "a" })];
    expect(inSlotOrder(rows, ["a", "b"]).map((r) => r.titleId)).toEqual(["a", "b", "z"]);
    expect(inSlotOrder(rows, undefined).map((r) => r.titleId)).toEqual(["z", "b", "a"]);
  });

  it("automaten får facken ur Awish-läsningen", () => {
    const m = machineWith(
      [
        { title_id: "t2", units: 4, capacity: 10, channels: 1, empty: 0 },
        { title_id: "t1", units: 0, capacity: 10, channels: 1, empty: 1 },
      ],
      5,
    );
    expect(m.slots).toEqual(["t2", "t1"]);
    // Raderna ordnas efter behov, rutorna efter facken.
    expect(m.rows.map((r) => r.titleId)).toEqual(["t1", "t2"]);
    expect(inSlotOrder(m.rows, m.slots).map((r) => r.titleId)).toEqual(["t2", "t1"]);
  });
});

describe("listan", () => {
  it("Ta med = det automaten vill ha, utan tak från lagret", () => {
    const m = machineWith(
      [
        { title_id: "t1", units: 4, capacity: 10, channels: 1, empty: 0 },
        { title_id: "t2", units: 0, capacity: 8, channels: 1, empty: 1 },
      ],
      1,
    );
    expect(m.suggested).toBe(2);
    expect(bringCount(m)).toBe(14);
  });

  it("packbilderna: slut först, sedan snart slut, högst sex", () => {
    const rows = [
      row({ titleId: "low", now: 1, status: "low" }),
      row({ titleId: "out", now: 0, status: "empty" }),
      row({ titleId: "ok", now: 9 }),
      ...["a", "b", "c", "d", "e"].map((id) => row({ titleId: id, status: "empty" })),
    ];
    const packs = urgentPacks({ rows });
    expect(packs).toHaveLength(6);
    expect(packs[0]).toEqual({ titleId: "out", name: "out", empty: true });
    expect(packs.map((p) => p.titleId)).not.toContain("ok");
    expect(urgentPacks({ rows: rows.slice(0, 3) }).map((p) => [p.titleId, p.empty])).toEqual([
      ["out", true],
      ["low", false],
    ]);
  });

  it("märket: Offline, Slut, Fyll på i dag, Strömmen av", () => {
    const calm = { empty: 0, emptySlots: 0, low: 0, fillPct: 80 };
    expect(listChip(calm, "offline")).toEqual({ tone: "critical", text: "Offline" });
    expect(listChip({ ...calm, empty: 1 }, null)).toEqual({ tone: "critical", text: "Slut" });
    expect(listChip({ ...calm, emptySlots: 2 }, null)?.text).toBe("Slut");
    expect(listChip({ ...calm, fillPct: 25 }, null)?.text).toBe("Fyll på i dag");
    expect(listChip({ ...calm, low: 1 }, null)?.text).toBe("Fyll på i dag");
    expect(listChip(calm, "power_off")).toEqual({ tone: "neutral", text: "Strömmen av" });
    expect(listChip(calm, null)).toBeNull();
  });
});

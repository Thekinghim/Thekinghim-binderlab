import { describe, expect, it } from "vitest";

import {
  defaultBringSelection,
  fillAllQty,
  fillMachines,
  pairKey,
  slotTitleOrder,
  type FillInput,
  type FillRow,
} from "./model";
import {
  bringCount,
  initialSelection,
  inSlotOrder,
  listChip,
  needLine,
  setQty,
  shortAtHome,
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

  it("fyller till fullt även när lagret hemma inte räcker (resten utan uttag)", () => {
    const m = machineWith([{ title_id: "t1", units: 4, capacity: 10, channels: 1, empty: 0 }], 2);
    const r = m.rows[0]!;
    expect(r.suggested).toBe(2);
    expect(tapTile({}, r, true)).toEqual({ selection: { t1: 6 }, sheet: false });
    expect(shortAtHome(r, 6, true)).toBe(4);
  });

  it("inget i lagret hemma: facket fylls ändå, allt utan uttag (som Fyll fack förut)", () => {
    const m = machineWith([{ title_id: "t1", units: 4, capacity: 10, channels: 1, empty: 0 }], 0);
    const r = m.rows[0]!;
    expect(tapTile({}, r, true)).toEqual({ selection: { t1: 6 }, sheet: false });
    expect(shortAtHome(r, 6, true)).toBe(6);
    expect(shortAtHome(r, 6, false)).toBe(0);
  });

  it("ett tryck ger samma antal som Fyll alla (vanliga titlar)", () => {
    const rows = [
      row({ titleId: "a", now: 4, capacity: 10, home: 0 }),
      row({ titleId: "b", now: 0, capacity: 20, home: 3 }),
      row({ titleId: "c", now: 12, capacity: 12, home: 9 }),
    ];
    for (const r of rows) expect(tapQty(r, true)).toBe(fillAllQty(r, 0));
  });

  it("utan känd kapacitet: förslaget med eget lager", () => {
    const r = row({ titleId: "t1", now: 1, capacity: null, home: 3, suggested: 3 });
    expect(tapQty(r, true)).toBe(3);
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
    // Ingen färdig omgång i lagret: inget väljs, arket öppnas ("Har du packat?", en omgång).
    const short = row({ titleId: "m", now: 0, capacity: 20, batchSize: 14, home: 3, suggested: 0 });
    expect(tapTile({}, short, true)).toEqual({ selection: {}, sheet: true });
    // Lagret man fyller från avgör, inte ett förslag räknat på ett annat lager.
    const stale = row({
      titleId: "m",
      now: 0,
      capacity: 20,
      batchSize: 14,
      home: 0,
      suggested: 14,
    });
    expect(tapTile({}, stale, true)).toEqual({ selection: {}, sheet: true });
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

describe("kortets rad: ett tomt fack i sortimentet behöver påfyllning", () => {
  // Demon (Automat 09): ingen Awish-läsning, titeln står i sortimentet med 0 pack och har
  // inte sålt på 14 dagar (den har varit slut för länge). Rutan och märket säger Slut.
  function noAwish(partial: Partial<FillInput> = {}) {
    const input: FillInput = {
      machines: [
        {
          id: "A",
          code: "NA-09",
          name: "Automat 09",
          storeName: null,
          syncedAt: null,
          fill: null,
        },
      ],
      titles: new Map([
        ["t1", "Surging Sparks"],
        ["t2", "Black Bolt"],
      ]),
      machineStock: new Map([[pairKey("A", "t2"), 4]]),
      home: new Map(),
      current: new Set([pairKey("A", "t1"), pairKey("A", "t2")]),
      retired: new Set(),
      ...partial,
    };
    return fillMachines(input);
  }

  it("märket Slut och raden säger aldrig Inget behövs", () => {
    const [m] = noAwish();
    expect(m!.rows.find((r) => r.titleId === "t1")).toMatchObject({ now: 0, status: "empty" });
    expect(listChip(m!, null)?.text).toBe("Slut");
    expect(m!.needs).toBe(true);
    expect(bringCount(m!)).toBe(0);
    expect(needLine(m!)).toEqual({ text: "Fyll på 1 titel som är slut", none: false });
    // Ta med-listan väljer automaten från början.
    expect(defaultBringSelection(noAwish())).toEqual(["A"]);
  });

  it("med pack att ta med: båda sägs", () => {
    const [m] = noAwish({
      machineStock: new Map([[pairKey("A", "t2"), 2]]),
      sold: new Map([[pairKey("A", "t2"), 14]]),
    });
    // t2: 14 sålda på 14 dagar, 2 kvar (snart slut): en vecka = 7, ta med 5.
    expect(needLine(m!).text.replace(/\u2060|\u00a0/g, " ")).toBe(
      "Ta med 5 pack + 1 titel som är slut",
    );
  });

  it("utgången titel utan pack: ingen rad, inget Slut, Inget behövs", () => {
    const [m] = noAwish({
      current: new Set([pairKey("A", "t2")]),
      retired: new Set([pairKey("A", "t1")]),
    });
    expect(m!.rows.map((r) => r.titleId)).toEqual(["t2"]);
    expect(listChip(m!, null)).toBeNull();
    expect(needLine(m!)).toEqual({ text: "Inget behövs", none: true });
  });

  it("utgången titel som Awish fortfarande har på ett tomt fack: inget Slut", () => {
    const [m] = fillMachines({
      machines: [
        {
          id: "A",
          code: "NA-09",
          name: "Automat 09",
          storeName: null,
          syncedAt: "2026-11-03T10:00:00Z",
          fill: [
            { title_id: "t1", units: 0, capacity: 6, channels: 1, empty: 1 },
            { title_id: "t2", units: 6, capacity: 6, channels: 1, empty: 0 },
          ],
        },
      ],
      titles: new Map([
        ["t1", "Surging Sparks"],
        ["t2", "Black Bolt"],
      ]),
      machineStock: new Map([[pairKey("A", "t2"), 6]]),
      home: new Map(),
      current: new Set([pairKey("A", "t2")]),
      retired: new Set([pairKey("A", "t1")]),
    });
    expect(m!.rows.map((r) => r.titleId)).toEqual(["t2"]);
    expect(m!).toMatchObject({ emptySlots: 0, empty: 0, needs: false });
    expect(listChip(m!, null)).toBeNull();
    expect(needLine(m!).none).toBe(true);
  });
});

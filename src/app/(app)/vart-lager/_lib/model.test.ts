import { describe, expect, it } from "vitest";

import type { WarehouseRow } from "../../lager/_lib/types";
import { headingOf } from "./heading";
import {
  buildVartLagerModel,
  describeChange,
  lastsDays,
  lastsText,
  needsPurchase,
  stockTodos,
  whenText,
  type VartLagerInput,
  type WarehouseEvent,
} from "./model";

const TZ = "Europe/Stockholm";
/** Hårda mellanslag (NBSP) som vanliga, för läsbara förväntningar. */
const sp = (s: string) => s.replace(/\u00a0/g, " ");
// 3 nov. 2026 15:00 i Stockholm.
const NOW = new Date("2026-11-03T14:00:00Z");
const machines = [
  { code: "BL-002", name: "Automat 2", storeName: "Sega gubben" },
  { code: "BL-003", name: "Automat 3", storeName: null },
];

const wr = (titleId: string, onHand: number, extra: Partial<WarehouseRow> = {}): WarehouseRow => ({
  titleId,
  onHand,
  perDayTenths: 10,
  daysLeft: onHand,
  weekNeed: 0,
  shortBy: 0,
  status: "ok",
  lastCountedAt: null,
  ...extra,
});

const ev = (e: Partial<WarehouseEvent>): WarehouseEvent => ({
  titleId: "a",
  kind: "count",
  quantity: 10,
  occurredAt: "2026-11-03T13:05:00Z",
  note: null,
  source: null,
  ...e,
});

function input(over: Partial<VartLagerInput> = {}): VartLagerInput {
  return {
    now: NOW,
    timeZone: TZ,
    today: "2026-11-03",
    titles: [
      { id: "b", name: "Surging Sparks" },
      { id: "a", name: "Black Bolt" },
      { id: "c", name: "Paradox Rift" },
    ],
    warehouse: [wr("a", 40, { daysLeft: 20 }), wr("b", 3, { daysLeft: 2, status: "low" })],
    home: new Map([
      ["a", 40],
      ["b", 3],
    ]),
    inMachines: new Map([
      ["a", 12],
      ["b", -2],
    ]),
    sold7: new Map([
      ["a", 14],
      ["c", 0],
    ]),
    prices: [
      { titleId: "a", unitCostOre: 4500, validFrom: "2026-10-01" },
      { titleId: "a", unitCostOre: 5000, validFrom: "2026-11-10" },
      { titleId: "b", unitCostOre: 6000, validFrom: "2026-10-01" },
    ],
    latest: new Map([
      ["a", ev({ kind: "adjustment", quantity: -12, note: "Awish-påfyllning BL-002 Sega gubben" })],
    ]),
    machines,
    canEdit: true,
    ...over,
  };
}

describe("buildVartLagerModel", () => {
  it("en rad per aktiv titel, sorterad på namn, även med 0", () => {
    const m = buildVartLagerModel(input());
    expect(m.rows.map((r) => r.name)).toEqual(["Black Bolt", "Paradox Rift", "Surging Sparks"]);
    const c = m.rows[1]!;
    expect(c).toMatchObject({ home: 0, inMachines: 0, sold7: 0, status: "ok", runsOut: false });
  });

  it("antal, automater, sålt, dagar och värde till dagens pris", () => {
    const a = buildVartLagerModel(input()).rows[0]!;
    expect(a).toMatchObject({
      home: 40,
      inMachines: 12,
      sold7: 14,
      daysLeft: 20,
      unitCostOre: 4500,
      valueOre: 180_000,
    });
    expect(a.latest).toEqual({
      text: "−12 påfyllning Sega gubben",
      when: "i dag 14:05",
      delta: -12,
      automatic: true,
    });
  });

  it("summor: pack hemma, värde, titlar som tar slut, under 0", () => {
    const m = buildVartLagerModel(
      input({
        warehouse: [wr("a", 40), wr("b", -4, { status: "critical", daysLeft: 0 })],
        home: new Map([
          ["a", 40],
          ["b", -4],
        ]),
      }),
    );
    expect(m.totals).toEqual({
      home: 40,
      valueOre: 180_000,
      unpriced: 0,
      runsOut: 1,
      negative: 1,
      inMachines: 12,
      byPlace: {},
      idle: { titles: 0, packs: 0, valueOre: 0 },
    });
    expect(m.rows[2]).toMatchObject({ negative: true, valueOre: 0 });
    const h = headingOf(m);
    expect({ title: sp(h.title), aside: sp(h.aside) }).toEqual({
      title: "40 pack i lager.",
      aside: "1 titel under 0. Räkna om.",
    });
  });

  it("titel utan rad i lagret som säljer är slut", () => {
    const m = buildVartLagerModel(input({ sold7: new Map([["c", 5]]) }));
    expect(m.rows[1]).toMatchObject({ home: 0, status: "critical", runsOut: true });
    expect(lastsText(m.rows[1]!)).toBe("slut");
  });

  it("titel med antal hemma men utan pris räknas som utan pris", () => {
    const m = buildVartLagerModel(input({ prices: [] }));
    expect(m.totals).toMatchObject({ valueOre: 0, unpriced: 2 });
  });

  it("rubrik: titlar som tar slut, annars att det räcker", () => {
    expect(sp(headingOf(buildVartLagerModel(input())).aside)).toBe("1 titel tar slut: beställ 1.");
    expect(
      sp(
        headingOf(buildVartLagerModel(input({ warehouse: [wr("a", 40)], sold7: new Map() }))).aside,
      ),
    ).toBe("Allt räcker 7 dagar.");
  });
});

describe("egna produkter och Att göra", () => {
  it("utan inköpsplan: titlar som tar slut visas utan antal", () => {
    const m = buildVartLagerModel(input());
    const b = m.rows.find((r) => r.titleId === "b")!;
    expect(b).toMatchObject({ runsOut: true, needQty: null });
    expect(needsPurchase(b)).toBe(true);
    expect(stockTodos(m.rows)).toEqual([
      { titleId: "b", verb: "Beställ", title: "Surging Sparks", qty: null, tone: "warning" },
    ]);
  });

  it("med inköpsplanen: Inköps antal, och bara titlar där det är över 0", () => {
    // a räcker hemma men Inköp vill beställa (ledtid + nästa beställning); b tar slut men
    // är redan beställd (Inköp: 0). Samma titlar och antal som Inköp.
    const m = buildVartLagerModel(input({ purchase: new Map([["a", 36]]) }));
    expect(m.rows.find((r) => r.titleId === "a")).toMatchObject({ runsOut: false, needQty: 36 });
    expect(m.rows.find((r) => r.titleId === "b")).toMatchObject({ runsOut: true, needQty: 0 });
    expect(stockTodos(m.rows)).toEqual([
      { titleId: "a", verb: "Beställ", title: "Black Bolt", qty: 36, tone: "warning" },
    ]);
    expect(sp(headingOf(m).aside)).toBe("1 titel tar slut: beställ 1.");
    const none = buildVartLagerModel(input({ purchase: new Map() }));
    expect(stockTodos(none.rows)).toEqual([]);
    expect(sp(headingOf(none).aside)).toBe("1 titel tar slut. Inget att beställa än.");
    const nothingOut = buildVartLagerModel(
      input({ warehouse: [wr("a", 40)], sold7: new Map(), purchase: new Map([["a", 12]]) }),
    );
    expect(sp(headingOf(nothingOut).aside)).toBe("Beställ 1 titel.");
  });

  it("egen produkt packas, övriga beställs; under 0 räknas om först", () => {
    const m = buildVartLagerModel(
      input({
        titles: [
          { id: "b", name: "Mystery Pack", ownProduct: true },
          { id: "a", name: "Black Bolt" },
          { id: "c", name: "Paradox Rift" },
        ],
        warehouse: [
          wr("a", -2, { status: "critical", daysLeft: 0 }),
          wr("b", 3, { daysLeft: 2, status: "low" }),
          wr("c", 0, { daysLeft: 0, status: "critical", perDayTenths: 5 }),
        ],
        home: new Map([
          ["a", -2],
          ["b", 3],
          ["c", 0],
        ]),
        purchase: new Map([
          ["b", 11],
          ["c", 7],
          // Under 0: räknas om först, aldrig beställ.
          ["a", 30],
        ]),
      }),
    );
    const b = m.rows.find((r) => r.titleId === "b")!;
    expect(b).toMatchObject({ own: true, runsOut: true, needQty: 11 });
    expect(m.rows.find((r) => r.titleId === "c")).toMatchObject({ own: false, needQty: 7 });
    expect(stockTodos(m.rows)).toEqual([
      { titleId: "a", verb: "Räkna om", title: "Black Bolt", qty: null, tone: "critical" },
      { titleId: "c", verb: "Beställ", title: "Paradox Rift", qty: 7, tone: "critical" },
      { titleId: "b", verb: "Packa", title: "Mystery Pack", qty: 11, tone: "warning" },
    ]);
    const noNegative = buildVartLagerModel(
      input({
        titles: [
          { id: "b", name: "Mystery Pack", ownProduct: true },
          { id: "c", name: "Paradox Rift" },
        ],
        warehouse: [
          wr("b", 3, { daysLeft: 2, status: "low" }),
          wr("c", 0, { daysLeft: 0, status: "critical" }),
        ],
        purchase: new Map([
          ["b", 11],
          ["c", 7],
        ]),
      }),
    );
    expect(sp(headingOf(noNegative).aside)).toBe("2 titlar tar slut: packa 1, beställ 1.");
  });

  it("allt räcker: inget att göra", () => {
    const m = buildVartLagerModel(input({ warehouse: [wr("a", 40)], sold7: new Map() }));
    expect(stockTodos(m.rows)).toEqual([]);
  });
});

describe("flera lager", () => {
  const places = [
    { id: "H", name: "Hemma", isDefault: true },
    { id: "K", name: "Kontoret", isDefault: false },
  ];
  const multi = () =>
    buildVartLagerModel(
      input({
        places,
        byPlace: { H: { a: 30, b: 3 }, K: { a: 10, b: -1 } },
        home: new Map([
          ["a", 40],
          ["b", 2],
        ]),
        latest: new Map([
          [
            "a",
            [
              ev({
                locationId: "K",
                kind: "adjustment",
                quantity: -12,
                note: "Awish-påfyllning BL-002 Sega gubben",
                occurredAt: "2026-11-03T13:05:00Z",
              }),
              ev({
                locationId: "H",
                kind: "receipt",
                quantity: 24,
                occurredAt: "2026-11-03T08:00:00Z",
              }),
            ],
          ],
        ]),
      }),
    );

  it("summan per titel och per lager; negativt räknas som 0 i summan per lager", () => {
    const m = multi();
    expect(m.places.map((p) => p.name)).toEqual(["Hemma", "Kontoret"]);
    expect(m.rows[0]).toMatchObject({ name: "Black Bolt", home: 40, byPlace: { H: 30, K: 10 } });
    expect(m.rows[2]).toMatchObject({ name: "Surging Sparks", byPlace: { H: 3, K: -1 } });
    expect(m.rows[1]).toMatchObject({ name: "Paradox Rift", byPlace: { H: 0, K: 0 } });
    expect(m.totals.byPlace).toEqual({ H: 33, K: 10 });
  });

  it("senaste ändringen: nyast över alla lager med lagret först, och per lager", () => {
    const a = multi().rows[0]!;
    expect(a.latest).toMatchObject({
      text: "−12 från Kontoret, påfyllning Sega gubben",
      automatic: true,
      delta: -12,
    });
    expect(a.latestByPlace.K?.text).toBe("−12 påfyllning Sega gubben");
    expect(a.latestByPlace.H?.text).toBe("+24 inköp");
  });
});

describe("describeChange", () => {
  const d = (e: Partial<WarehouseEvent>) => describeChange(ev(e), machines, TZ, NOW).text;
  it("påfyllning i appen och från Awish visar butiken", () => {
    expect(d({ kind: "adjustment", quantity: -6, note: "Uttag till påfyllning av BL-002" })).toBe(
      "−6 påfyllning Sega gubben",
    );
    expect(d({ kind: "adjustment", quantity: -3, note: "Awish-påfyllning BL-003 Automat 3" })).toBe(
      "−3 påfyllning Automat 3",
    );
    expect(d({ kind: "adjustment", quantity: -3, note: "Awish-påfyllning BL-099 Gammal" })).toBe(
      "−3 påfyllning BL-099 Gammal",
    );
    expect(d({ kind: "adjustment", quantity: 4, note: "Återfört Awish-uttag BL-002" })).toBe(
      "+4 återfört Sega gubben",
    );
  });
  it("flytt mellan lager och lagret först", () => {
    expect(d({ kind: "transfer_out", quantity: -5, counterpart: "Kontoret" })).toBe(
      "−5 flytt till Kontoret",
    );
    expect(d({ kind: "transfer_in", quantity: 5, counterpart: "Hemma" })).toBe(
      "+5 flytt från Hemma",
    );
    const at = (e: Partial<WarehouseEvent>, place: string) =>
      describeChange(ev(e), machines, TZ, NOW, place).text;
    expect(at({ kind: "receipt", quantity: 24 }, "Kontoret")).toBe("+24 till Kontoret, inköp");
    expect(at({ kind: "count", quantity: 84 }, "Hemma")).toBe("räknat 84 i Hemma");
  });
  it("inköp, inventering och justering", () => {
    expect(d({ kind: "receipt", quantity: 24 })).toBe("+24 inköp");
    expect(d({ kind: "count", quantity: 84 })).toBe("räknat 84");
    expect(d({ kind: "adjustment", quantity: 2, note: "Hittade" })).toBe("+2 justering");
  });
});

describe("whenText", () => {
  it("i dag, i går och datum i organisationens tidszon", () => {
    expect(whenText("2026-11-03T13:05:00Z", TZ, NOW)).toBe("i dag 14:05");
    // 23:30 UTC 2 nov. = 00:30 3 nov. i Stockholm.
    expect(whenText("2026-11-02T23:30:00Z", TZ, NOW)).toBe("i dag 00:30");
    expect(whenText("2026-11-02T08:12:00Z", TZ, NOW)).toBe("i går 09:12");
    expect(sp(whenText("2026-10-30T08:12:00Z", TZ, NOW))).toBe("30 okt. 09:12");
  });
});

/**
 * Som produktionen 4 nov.: Black Bolt har gått ur automaten (Utgår på Lager) men 8 pack
 * ligger hemma; inget har sålts på 7 dagar. Den ska inte se ut som vanligt lager.
 */
describe("Vårt lager: utgångna titlar, Räcker och senaste händelsen", () => {
  it("utgången titel: Utgår, ingen status eller inköp, sist i listan och i Ligger still", () => {
    const m = buildVartLagerModel(
      input({
        retired: new Set(["a"]),
        warehouse: [
          wr("a", 40, { status: "low", daysLeft: 3 }),
          wr("b", 3, { daysLeft: 2, status: "low" }),
        ],
        sold7: new Map([["a", 0]]),
        // En utgången titel köps aldrig in, även om planen skulle ha ett antal.
        purchase: new Map([
          ["a", 20],
          ["b", 5],
        ]),
      }),
    );
    expect(m.rows.map((r) => r.name)).toEqual(["Paradox Rift", "Surging Sparks", "Black Bolt"]);
    const a = m.rows[2]!;
    expect(a).toMatchObject({
      retired: true,
      status: "ok",
      runsOut: false,
      needQty: 0,
      lastsDays: null,
    });
    expect(lastsText(a)).toBe("utgår");
    expect(m.totals.idle).toEqual({ titles: 1, packs: 40, valueOre: 180_000 });
    expect(m.totals.runsOut).toBe(1);
    expect(stockTodos(m.rows).map((t) => t.titleId)).toEqual(["b"]);
  });

  it("Räcker: hemma + i automaterna vid 14 dagars takt, '–' utan försäljning på 7 dagar", () => {
    const m = buildVartLagerModel(
      input({
        warehouse: [
          wr("a", 40, { perDayTenths: 26, daysLeft: 15 }),
          wr("b", 3, { daysLeft: 2, status: "low" }),
        ],
        sold7: new Map([
          ["a", 18],
          ["b", 0],
        ]),
      }),
    );
    // (40 + 12) / 2,6 = 20 hela dagar
    expect(m.rows[0]!.lastsDays).toBe(20);
    expect(sp(lastsText(m.rows[0]!))).toBe("20 d");
    // Black bolt-fallet: inget sålt på 7 dagar → "–", inte "räcker 10 d".
    expect(lastsText(m.rows[2]!)).toBe("–");
  });

  it("lastsDays är samma regel som Inköp använder", () => {
    expect(lastsDays(52, 26)).toBe(20);
    expect(lastsDays(10, null)).toBeNull();
    expect(lastsDays(10, 0)).toBeNull();
    expect(lastsDays(-3, 10)).toBe(0);
  });

  it("under Alla: 'räknat 0 i Kontoret' visas inte när titeln ligger i Hemma", () => {
    const places = [
      { id: "h", name: "Hemma", isDefault: true },
      { id: "k", name: "Kontoret", isDefault: false },
    ];
    const m = buildVartLagerModel(
      input({
        places,
        byPlace: { h: { a: 180 }, k: { a: 0 } },
        latest: new Map([
          [
            "a",
            [
              ev({
                locationId: "k",
                kind: "count",
                quantity: 0,
                occurredAt: "2026-11-03T20:09:00Z",
              }),
              ev({
                locationId: "h",
                kind: "count",
                quantity: 180,
                occurredAt: "2026-11-03T18:07:00Z",
              }),
            ],
          ],
        ]),
      }),
    );
    expect(sp(m.rows[0]!.latest!.text)).toBe("räknat 180 i Hemma");
    // Per lager finns båda kvar.
    expect(sp(m.rows[0]!.latestByPlace.k!.text)).toBe("räknat 0");
  });
});

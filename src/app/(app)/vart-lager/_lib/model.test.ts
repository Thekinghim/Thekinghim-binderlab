import { describe, expect, it } from "vitest";

import type { WarehouseRow } from "../../lager/_lib/types";
import { headingOf } from "./heading";
import {
  buildVartLagerModel,
  describeChange,
  lastsText,
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
    });
    expect(m.rows[2]).toMatchObject({ negative: true, valueOre: 0 });
    const h = headingOf(m);
    expect({ title: sp(h.title), aside: sp(h.aside) }).toEqual({
      title: "40 pack hemma.",
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
    expect(sp(headingOf(buildVartLagerModel(input())).aside)).toBe(
      "1 titel tar slut inom 7 dagar.",
    );
    expect(
      headingOf(buildVartLagerModel(input({ warehouse: [wr("a", 40)], sold7: new Map() }))).aside,
    ).toBe("Allt räcker en vecka till.");
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

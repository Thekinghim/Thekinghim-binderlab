import { describe, expect, it } from "vitest";

import type { VartLagerRow } from "./model";
import {
  buyLines,
  filterRows,
  gapText,
  machineValueOre,
  recentEvents,
  sortRows,
  type StockEventRow,
} from "./v2-model";

const row = (titleId: string, over: Partial<VartLagerRow> = {}): VartLagerRow =>
  ({
    titleId,
    name: titleId.toUpperCase(),
    home: 10,
    byPlace: {},
    latestByPlace: {},
    inMachines: 5,
    sold7: 7,
    daysLeft: 10,
    lastsDays: 15,
    retired: false,
    status: "ok",
    runsOut: false,
    negative: false,
    unitCostOre: 5_000,
    valueOre: 50_000,
    latest: null,
    own: false,
    needQty: 0,
    action: null,
    fact: "",
    toMystery: null,
    ...over,
  }) as VartLagerRow;

describe("Vårt lager V2", () => {
  it("filter: Lågt = räcker kort men finns hemma, Slut = inget hemma och behövs", () => {
    const rows = [
      row("a"),
      row("b", { runsOut: true, home: 3 }),
      row("c", { home: 0, inMachines: 4, runsOut: true }),
      row("d", { home: 0, inMachines: 0, needQty: 0 }),
      row("e", { home: 0, inMachines: 2, retired: true }),
    ];
    expect(filterRows(rows, "lagt").map((r) => r.titleId)).toEqual(["b"]);
    expect(filterRows(rows, "slut").map((r) => r.titleId)).toEqual(["c"]);
    expect(filterRows(rows, "alla")).toHaveLength(5);
  });

  it("sortering: Hemma räcker kortast först, okänd och utgångna sist", () => {
    const rows = [
      row("a", { daysLeft: null }),
      row("b", { daysLeft: 3 }),
      row("c", { daysLeft: 1, retired: true }),
      row("d", { daysLeft: 7 }),
    ];
    expect(sortRows(rows, "rakcer").map((r) => r.titleId)).toEqual(["b", "d", "a", "c"]);
    expect(sortRows(rows, "hemma").map((r) => r.titleId)[0]).toBe("a");
  });

  it("Köpa: inköpsplanens antal, ledtid och leverantör; beställ före packa, brådskande först", () => {
    const rows = [
      row("a", {
        lastsDays: 5,
        action: {
          kind: "order",
          qty: 400,
          unit: "st",
          packs: 400,
          batches: null,
          text: "",
          placeId: null,
        },
      }),
      row("b", {
        lastsDays: 0,
        action: {
          kind: "order",
          qty: 110,
          unit: "st",
          packs: 110,
          batches: null,
          text: "",
          placeId: null,
        },
      }),
      row("m", {
        lastsDays: 0,
        own: true,
        action: {
          kind: "pack",
          qty: 2,
          unit: "omgångar",
          packs: 40,
          batches: 2,
          text: "",
          placeId: null,
        },
      }),
      row("z"),
    ];
    const info = new Map([
      ["a", { leadTimeDays: 12, supplierName: "Grossisten" }],
      ["b", { leadTimeDays: 7, supplierName: null }],
    ]);
    const lines = buyLines(rows, info);
    expect(lines.map((l) => [l.titleId, l.text, l.gapDays, l.supplierName])).toEqual([
      ["a", "Beställ 400 A", -7, "Grossisten"],
      ["b", "Beställ 110 B", -7, null],
      ["m", "Packa 2 omgångar M", null, null],
    ]);
    expect(gapText(-7)).toBe("−7 d");
  });

  it("värdet i automaterna: pack × dagens inköpspris, utan pris räknas inte", () => {
    expect(
      machineValueOre([
        row("a", { inMachines: 3 }),
        row("b", { unitCostOre: null }),
        row("c", { inMachines: -2 }),
      ]),
    ).toBe(15_000);
  });

  it("senaste händelser: en påfyllning per butik och dag, inventering per lager, inköp per titel", () => {
    const e = (x: Partial<StockEventRow>): StockEventRow => ({
      kind: "adjustment",
      quantity: -1,
      occurredAt: "2026-11-20T10:00:00.000Z",
      note: null,
      titleName: "Black Bolt",
      placeName: "Hemma",
      counterpart: null,
      ...x,
    });
    const out = recentEvents(
      [
        e({ note: "Awish-påfyllning NA-03 Kortkammaren", quantity: -4 }),
        e({
          note: "Awish-påfyllning NA-03 Kortkammaren",
          quantity: -3,
          titleName: "Surging Sparks",
        }),
        e({ kind: "count", quantity: 40, occurredAt: "2026-11-18T09:00:00.000Z" }),
        e({ kind: "count", quantity: 20, occurredAt: "2026-11-18T09:01:00.000Z", titleName: "X" }),
        e({ kind: "receipt", quantity: 120, occurredAt: "2026-11-14T09:00:00.000Z" }),
        e({ kind: "transfer_in", quantity: 5, occurredAt: "2026-11-13T09:00:00.000Z" }),
      ],
      (code) => (code === "NA-03" ? "Kortkammaren" : null),
    );
    expect(out.map((x) => [x.title, x.detail.replace(/ /g, " ")])).toEqual([
      ["Fyll på Kortkammaren", "−7 pack"],
      ["Räknat Hemma", "2 titlar"],
      ["Inköp Black Bolt", "+120 pack · Hemma"],
    ]);
  });
});

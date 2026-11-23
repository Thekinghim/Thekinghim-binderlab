import { describe, expect, it } from "vitest";

import { nextSortFor, sortRows } from "./list-sort";
import { buildRefs } from "./refs";
import type { OrderRow } from "./types";

const T1 = "11111111-1111-4111-8111-111111111111";
const T2 = "22222222-2222-4222-8222-222222222222";

const refs = buildRefs({
  titles: [
    { id: T1, name: "Ödla", archived: false },
    { id: T2, name: "Apa", archived: false },
  ],
  machines: [],
  stores: [],
});

function row(id: string, at: string, titleId: string | null, amountOre: number): OrderRow {
  return {
    id,
    externalId: id,
    orderedAt: at,
    businessDate: at.slice(0, 10),
    titleId,
    rawTitle: null,
    machineId: null,
    storeId: null,
    amountOre,
    testPurchase: false,
  };
}

describe("nextSortFor", () => {
  it("namn stigande först, belopp fallande först, tredje klicket tillbaka till tid", () => {
    const start = { key: "tid", dir: "desc" } as const;
    expect(nextSortFor(start, "titel")).toEqual({ key: "titel", dir: "asc" });
    expect(nextSortFor({ key: "titel", dir: "asc" }, "titel")).toEqual({
      key: "titel",
      dir: "desc",
    });
    expect(nextSortFor({ key: "titel", dir: "desc" }, "titel")).toEqual(start);
    expect(nextSortFor(start, "belopp")).toEqual({ key: "belopp", dir: "desc" });
  });
});

describe("sortRows", () => {
  const rows = [
    row("9", "2026-11-20T10:00:00Z", T1, 100),
    row("10", "2026-11-21T10:00:00Z", null, 300),
    row("8", "2026-11-22T10:00:00Z", T2, 100),
  ];
  it("titel i svensk ordning, utan titel sist", () => {
    expect(sortRows(rows, { key: "titel", dir: "asc" }, refs).map((r) => r.id)).toEqual([
      "8",
      "9",
      "10",
    ]);
  });
  it("lika belopp: nyaste först", () => {
    expect(sortRows(rows, { key: "belopp", dir: "desc" }, refs).map((r) => r.id)).toEqual([
      "10",
      "8",
      "9",
    ]);
  });
  it("ordernummer numeriskt", () => {
    expect(sortRows(rows, { key: "nr", dir: "asc" }, refs).map((r) => r.id)).toEqual([
      "8",
      "9",
      "10",
    ]);
  });
});

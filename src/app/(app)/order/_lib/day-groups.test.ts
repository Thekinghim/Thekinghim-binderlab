import { describe, expect, it } from "vitest";

import { chipName, dayLabel, groupByDay, timeOf } from "./day-groups";
import type { OrderRow } from "./types";

function row(id: string, businessDate: string, orderedAt: string, amountOre = 12900): OrderRow {
  return {
    id,
    externalId: id,
    orderedAt,
    businessDate,
    titleId: null,
    rawTitle: "X",
    machineId: null,
    storeId: null,
    amountOre,
    testPurchase: false,
  };
}

describe("dayLabel", () => {
  it("säger I dag och I går", () => {
    expect(dayLabel("2026-11-23", "2026-11-23")).toBe("I dag");
    expect(dayLabel("2026-11-22", "2026-11-23")).toBe("I går");
  });
  it("veckodag och datum, år bara när det inte är i år", () => {
    expect(dayLabel("2026-11-20", "2026-11-23")).toBe("Fredag 20 nov.");
    expect(dayLabel("2025-12-31", "2026-01-02")).toBe("Onsdag 31 dec. 2025");
  });
});

describe("groupByDay", () => {
  it("grupperar i följd och tar dagens summa från servern", () => {
    const rows = [
      row("a", "2026-11-23", "2026-11-23T10:56:00Z"),
      row("b", "2026-11-23", "2026-11-23T08:00:00Z"),
      row("c", "2026-11-22", "2026-11-22T20:30:00Z"),
    ];
    const groups = groupByDay(
      rows,
      [
        { date: "2026-11-23", count: 6, amountOre: 92400 },
        { date: "2026-11-22", count: 31, amountOre: 521200 },
      ],
      "2026-11-23",
    );
    expect(groups.map((g) => [g.label, g.rows.length, g.total?.count])).toEqual([
      ["I dag", 2, 6],
      ["I går", 1, 31],
    ]);
  });
  it("saknas dagen hos servern blir summan null", () => {
    const groups = groupByDay([row("a", "2026-11-01", "2026-11-01T10:00:00Z")], [], "2026-11-23");
    expect(groups[0]?.total).toBeNull();
  });
  it("tom lista ger inga grupper", () => {
    expect(groupByDay([], [], "2026-11-23")).toEqual([]);
  });
});

describe("timeOf och chipName", () => {
  it("tid i tidszonen", () => {
    expect(timeOf("2026-11-23T10:56:00Z", "Europe/Stockholm")).toBe("11:56");
    expect(timeOf("inte ett datum", "Europe/Stockholm")).toBe("");
  });
  it("chipets namn är delen efter kolon", () => {
    expect(chipName("One Piece: Romance Dawn")).toBe("Romance Dawn");
    expect(chipName("Prismatic Evolutions")).toBe("Prismatic Evolutions");
    expect(chipName("Konstig:")).toBe("Konstig:");
  });
});

/**
 * Prestanda (fas 7): replayStockDaily sorterar med förberäknade nycklar. Ordningen ska
 * vara exakt densamma som med compareStockEvents, även med saknade och ogiltiga tidpunkter.
 */

import { describe, expect, it } from "vitest";

import { compareStockEvents, replayStockDaily, stockKey, type StockEventRef } from "./stock";

function lcg(seed: number) {
  let x = seed >>> 0;
  return () => {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    return x / 2 ** 32;
  };
}

function randomEvents(seed: number, n: number): StockEventRef[] {
  const rand = lcg(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
  const kinds = ["refill", "count", "sale", "waste", "adjustment"] as const;
  const times = [
    "2026-10-0DT06:58:00Z",
    "2026-10-0DT06:58:00.000Z",
    "2026-10-0DT12:00:00+02:00",
    "2026-10-0D 06:58:00+00", // Postgres textformat: ogiltig som ISO, sorteras sist
    null,
    undefined,
  ];
  return Array.from({ length: n }, (_, i) => {
    const kind = pick(kinds);
    const day = 1 + Math.floor(rand() * 5);
    const t = pick(times);
    return {
      id: `e-${String(Math.floor(rand() * 1e6)).padStart(6, "0")}-${i}`,
      locationId: pick(["l1", "l2"]),
      machineId: "m1",
      titleId: pick(["t1", "t2"]),
      kind,
      quantity:
        kind === "sale"
          ? -1
          : kind === "count"
            ? Math.floor(rand() * 9)
            : kind === "waste"
              ? -1
              : 1 + Math.floor(rand() * 5),
      businessDate: `2026-10-0${day}`,
      occurredAt: t ? t.replace("D", String(day)) : t,
      seq: rand() < 0.2 ? null : Math.floor(rand() * 50),
    };
  });
}

describe("replayStockDaily: ordningen inom dagen", () => {
  it.each([1, 2, 3, 4, 5])("är densamma som compareStockEvents (slump %i)", (seed) => {
    const events = randomEvents(seed, 600);
    const series = replayStockDaily(events, "2026-10-06");
    for (const s of series) {
      const expected = events
        .filter((e) => stockKey(e.locationId, e.titleId) === stockKey(s.locationId, s.titleId))
        .sort(compareStockEvents)
        .map((e) => e.id);
      expect(s.days.flatMap((d) => d.eventIds)).toEqual(expected);
    }
  });
});

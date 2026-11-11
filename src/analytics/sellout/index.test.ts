import { describe, expect, it } from "vitest";

import { addDays, dayOfWeek, daysOfStockLeft, stockoutDate, type SalesVelocity } from "@/domain";

import { FLAT_WEEK, normalizeWeekShare, sellOut, type WeekShare } from "./index";

/** Onsdag 11 november 2026. */
const WED = "2026-11-11";

/** Helgen säljer mest: lördag 2,2 gånger snittet. Summan är 7 (snittet per dag = 1). */
const WEEKEND: WeekShare = [0.4, 0.4, 0.4, 1.3, 1.5, 2.2, 0.8];

function velocity(units: number, days: number): SalesVelocity {
  return { units, days, perDay: days > 0 ? units / days : 0, start: WED, end: WED };
}

describe("sellOut utan veckoform: platt snitt, som i dag", () => {
  it("5 pack, 1 pack per dag från onsdag: slut på måndag", () => {
    expect(dayOfWeek(WED)).toBe(3);
    expect(sellOut({ onHand: 5, dailyAvg: 1, from: WED })).toEqual({
      date: "2026-11-16",
      daysLeft: 5,
      basis: "flat",
    });
  });

  it("ger samma dag och samma dagar som domänens stockoutDate och daysOfStockLeft", () => {
    for (let units = 1; units <= 40; units++) {
      for (const days of [1, 3, 7, 13, 14, 28]) {
        for (let onHand = 0; onHand <= 60; onHand++) {
          const v = velocity(units, days);
          const out = sellOut({ onHand, dailyAvg: { units, days }, from: WED });
          expect(out?.date, `${onHand} pack, ${units}/${days}`).toBe(stockoutDate(WED, onHand, v));
          expect(out?.daysLeft, `${onHand} pack, ${units}/${days}`).toBe(
            daysOfStockLeft(onHand, v),
          );
          expect(out?.basis).toBe("flat");
        }
      }
    }
  });

  it("decimaltal ger samma svar som bråket, även när divisionen inte går jämnt ut", () => {
    for (let units = 1; units <= 40; units++) {
      for (const days of [3, 7, 14, 28]) {
        for (let onHand = 0; onHand <= 60; onHand++) {
          expect(
            sellOut({ onHand, dailyAvg: units / days, from: WED }),
            `${onHand} pack, ${units}/${days}`,
          ).toEqual(sellOut({ onHand, dailyAvg: { units, days }, from: WED }));
        }
      }
    }
  });

  it("ingen takt: null (tar aldrig slut)", () => {
    expect(sellOut({ onHand: 5, dailyAvg: 0, from: WED })).toBeNull();
    expect(sellOut({ onHand: 5, dailyAvg: { units: 0, days: 14 }, from: WED })).toBeNull();
    expect(sellOut({ onHand: 5, dailyAvg: { units: 3, days: 0 }, from: WED })).toBeNull();
    expect(sellOut({ onHand: 5, dailyAvg: Number.NaN, from: WED })).toBeNull();
    expect(sellOut({ onHand: 0, dailyAvg: 0, from: WED, weekShare: WEEKEND })).toBeNull();
  });

  it("tomt fack eller minus: slut samma dag, 0 dagar", () => {
    expect(sellOut({ onHand: 0, dailyAvg: 2, from: WED })).toEqual({
      date: WED,
      daysLeft: 0,
      basis: "flat",
    });
    expect(sellOut({ onHand: -3, dailyAvg: 2, from: WED })?.date).toBe(WED);
  });

  it("så låg takt att dagen hamnar utanför kalendern: null, aldrig ett fel", () => {
    expect(sellOut({ onHand: 5, dailyAvg: 1e-300, from: WED })).toBeNull();
    expect(sellOut({ onHand: 5000, dailyAvg: 1e-6, from: WED })).toBeNull();
    expect(sellOut({ onHand: 5000, dailyAvg: 1e-6, from: WED, weekShare: WEEKEND })).toBeNull();
    expect(sellOut({ onHand: 4_000_000, dailyAvg: { units: 1, days: 28 }, from: WED })).toBeNull();
    // Långt fram men inom kalendern: en dag, som förut.
    expect(sellOut({ onHand: 1000, dailyAvg: { units: 1, days: 28 }, from: WED })).toEqual({
      date: addDays(WED, 28_000),
      daysLeft: 28_000,
      basis: "flat",
    });
  });

  it("ogiltig startdag ger fel", () => {
    expect(() => sellOut({ onHand: 1, dailyAvg: 1, from: "11/11/2026" })).toThrow();
  });
});

describe("sellOut med veckoform: helgen räknas", () => {
  it("5 pack där lördagen säljer 2,2 gånger snittet: slut på lördag, inte måndag", () => {
    const out = sellOut({ onHand: 5, dailyAvg: 1, from: WED, weekShare: WEEKEND });
    expect(out).toEqual({ date: "2026-11-14", daysLeft: 3, basis: "weekday" });
    expect(dayOfWeek(out!.date)).toBe(6);
    expect(sellOut({ onHand: 5, dailyAvg: 1, from: WED })?.date).toBe("2026-11-16");
  });

  it("ett pack till räcker över lördagen: slut på söndag, 3 hela dagar", () => {
    expect(sellOut({ onHand: 5.5, dailyAvg: 1, from: WED, weekShare: WEEKEND })).toEqual({
      date: "2026-11-15",
      daysLeft: 3,
      basis: "weekday",
    });
  });

  it("sju lika andelar ger samma dag som det platta snittet", () => {
    for (let units = 1; units <= 30; units++) {
      for (const days of [7, 14, 28]) {
        for (let onHand = 0; onHand <= 80; onHand += 1) {
          const flat = sellOut({ onHand, dailyAvg: { units, days }, from: WED });
          const even = sellOut({
            onHand,
            dailyAvg: { units, days },
            from: WED,
            weekShare: FLAT_WEEK,
          });
          expect(even, `${onHand} pack, ${units}/${days}`).toEqual({ ...flat, basis: "weekday" });
        }
      }
    }
  });

  it("andelarna behöver inte summera till 1", () => {
    const doubled = WEEKEND.map((s) => s * 2);
    expect(sellOut({ onHand: 5, dailyAvg: 1, from: WED, weekShare: doubled })).toEqual(
      sellOut({ onHand: 5, dailyAvg: 1, from: WED, weekShare: WEEKEND }),
    );
  });

  it("dagar utan försäljning hoppas över: stängt måndag till fredag", () => {
    const weekendOnly = [0, 0, 0, 0, 0, 1, 1];
    // 1 pack per dag i snitt = 3,5 på lördagen och 3,5 på söndagen.
    expect(sellOut({ onHand: 3, dailyAvg: 1, from: WED, weekShare: weekendOnly })).toEqual({
      date: "2026-11-14",
      daysLeft: 2,
      basis: "weekday",
    });
    expect(sellOut({ onHand: 7, dailyAvg: 1, from: WED, weekShare: weekendOnly })).toEqual({
      date: "2026-11-15",
      daysLeft: 4,
      basis: "weekday",
    });
    // Nästa pack säljs först lördagen därpå.
    expect(sellOut({ onHand: 8, dailyAvg: 1, from: WED, weekShare: weekendOnly })?.date).toBe(
      "2026-11-21",
    );
  });

  it("långt fram: samma vecka som snittet, men rätt veckodag", () => {
    const out = sellOut({ onHand: 705, dailyAvg: 1, from: WED, weekShare: WEEKEND });
    // 700 pack = 100 hela veckor, sedan 5 pack som i första testet.
    expect(out).toEqual({ date: addDays("2026-11-14", 700), daysLeft: 703, basis: "weekday" });
  });

  it("mer än tio år fram: platt snitt, och svaret säger det", () => {
    const far = sellOut({ onHand: 4000, dailyAvg: 1, from: WED, weekShare: WEEKEND });
    expect(far).toEqual(sellOut({ onHand: 4000, dailyAvg: 1, from: WED }));
    expect(far?.basis).toBe("flat");
  });

  it("ogiltig veckoform: platt snitt", () => {
    for (const bad of [[1, 1, 1], [0, 0, 0, 0, 0, 0, 0], [1, 1, 1, 1, 1, 1, -1], null, undefined]) {
      expect(sellOut({ onHand: 5, dailyAvg: 1, from: WED, weekShare: bad })).toEqual({
        date: "2026-11-16",
        daysLeft: 5,
        basis: "flat",
      });
    }
    expect(normalizeWeekShare([1, 1, 1, 1, 1, 1, Number.NaN])).toBeNull();
    expect(normalizeWeekShare([2, 2, 2, 2, 2, 2, 2])).toEqual(FLAT_WEEK);
  });
});

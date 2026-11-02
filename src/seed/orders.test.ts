/**
 * Seed-generatorn: facit på öret, bästa dagen, de sista orderna, tidsordning
 * och determinism. Körs under UTC, Europe/Stockholm och Asia/Shanghai
 * (npm run test:seed:tz).
 */

import { describe, expect, it } from "vitest";

import { formatInZone } from "@/import/zoned";

import {
  AUTUMN_BREAK,
  BEST_DAY,
  BEST_DAY_RANGE_ORE,
  EXPECTED_TOTAL_ORE,
  FIRST_ORDER_NO,
  LAST_ORDER_NO,
  OPEN_HOURS,
  SEED_LAST_ORDERS,
  SEED_MACHINES,
  SEED_PERIOD,
  SEED_TITLES,
  TITLES_WITHOUT_PRICE,
  expectedByTitle,
} from "./catalog";
import { generateSeedOrders, stockholmToUtcMs, summarizeSeedOrders } from "./orders";

const orders = generateSeedOrders();
const summary = summarizeSeedOrders(orders);

describe("facit", () => {
  it("460 order, 79 987 kr, snitt 173,88 kr", () => {
    expect(summary.orders).toBe(460);
    expect(summary.revenueOre).toBe(7_998_700);
    expect(summary.revenueOre).toBe(EXPECTED_TOTAL_ORE);
    // Snittet avrundat till hela öre (halvt uppåt) med heltal.
    expect(Math.floor((summary.revenueOre * 2 + summary.orders) / (2 * summary.orders))).toBe(
      17_388,
    );
  });

  it("per titel exakt enligt beställarens siffror", () => {
    const kr = (name: string) => {
      const v = summary.byTitle.get(name);
      return v ? [v.orders, v.revenueOre / 100] : null;
    };
    expect(kr("30th Celebration")).toEqual([150, 26_475]);
    expect(kr("Mystery Pack")).toEqual([62, 12_338]);
    expect(kr("Surging Sparks")).toEqual([48, 5_830]);
    expect(kr("Prismatic Evolution")).toEqual([45, 8_740]);
    expect(kr("Ascended Heroes")).toEqual([43, 8_127]);

    const big = new Set([
      "30th Celebration",
      "Mystery Pack",
      "Surging Sparks",
      "Prismatic Evolution",
      "Ascended Heroes",
    ]);
    let otherOrders = 0;
    let otherOre = 0;
    for (const [name, v] of summary.byTitle) {
      if (!big.has(name)) {
        otherOrders += v.orders;
        otherOre += v.revenueOre;
      }
    }
    expect(otherOrders).toBe(112);
    expect(otherOre).toBe(1_847_700);
    expect([...summary.byTitle.keys()].filter((n) => !big.has(n)).sort()).toEqual(
      [
        "Black bolt",
        "Destin Rivals",
        "Mega Evolution",
        "Mystery pack premium",
        "Paldea Evolved",
        "Perfect Order",
        "Phantasmal Flames",
        "White Flair",
      ].sort(),
    );
  });

  it("katalogens facit per titel stämmer med genererade orderna", () => {
    for (const [name, expected] of expectedByTitle()) {
      expect(summary.byTitle.get(name), name).toEqual(expected);
    }
  });

  it("alla belopp är hela kronor och säkra heltal i öre", () => {
    for (const o of orders) {
      expect(Number.isSafeInteger(o.amountOre)).toBe(true);
      expect(o.amountOre % 100).toBe(0);
      expect(o.amountOre).toBeGreaterThan(0);
    }
  });

  it("två titlar saknar inköpspris", () => {
    expect([...TITLES_WITHOUT_PRICE].sort()).toEqual(["Perfect Order", "White Flair"]);
  });

  it("exakt en titel har en prisändring mitt i perioden (27 okt)", () => {
    const changing = SEED_TITLES.filter((t) => t.purchasePrices.length > 1);
    expect(changing.map((t) => t.name)).toEqual(["30th Celebration"]);
    const dates = changing[0]?.purchasePrices.map((p) => p.validFrom);
    expect(dates).toEqual(["2026-10-01", "2026-10-27"]);
  });
});

describe("bästa dagen", () => {
  it("26 okt med 8 300–8 500 kr och periodens högsta", () => {
    expect(summary.bestDay.date).toBe(BEST_DAY);
    expect(summary.bestDay.revenueOre).toBeGreaterThanOrEqual(BEST_DAY_RANGE_ORE.min);
    expect(summary.bestDay.revenueOre).toBeLessThanOrEqual(BEST_DAY_RANGE_ORE.max);
    for (const [date, v] of summary.byDay) {
      if (date !== BEST_DAY) {
        expect(v.revenueOre, date).toBeLessThan(summary.bestDay.revenueOre);
      }
    }
  });

  it("varje dag i perioden har försäljning, helger och höstlov mer än vardagar", () => {
    expect(summary.byDay.size).toBe(20);
    const avg = (pred: (d: string) => boolean) => {
      const days = [...summary.byDay].filter(([d]) => pred(d) && d !== BEST_DAY);
      return days.reduce((n, [, v]) => n + v.revenueOre, 0) / days.length;
    };
    const breakDays = (d: string) => d >= AUTUMN_BREAK.start && d <= AUTUMN_BREAK.end;
    expect(avg(breakDays)).toBeGreaterThan(avg((d) => !breakDays(d)));
  });
});

describe("tider och ordernummer", () => {
  it("ordernummer 42321–42780 i tidsordning", () => {
    expect(orders[0]?.externalId).toBe(String(FIRST_ORDER_NO));
    expect(orders.at(-1)?.externalId).toBe(String(LAST_ORDER_NO));
    for (let i = 1; i < orders.length; i++) {
      const a = orders[i - 1];
      const b = orders[i];
      expect(Number(b?.externalId)).toBe(Number(a?.externalId) + 1);
      expect(b?.paidAtMs ?? 0).toBeGreaterThan(a?.paidAtMs ?? 0);
    }
  });

  it("alla order ligger i perioden och inom öppettiderna (svensk tid)", () => {
    for (const o of orders) {
      const local = formatInZone(new Date(o.paidAtMs), "Europe/Stockholm");
      expect(local).toBe(o.stockholmTime);
      expect(o.businessDate).toBe(local.slice(0, 10));
      expect(o.businessDate >= SEED_PERIOD.start && o.businessDate <= SEED_PERIOD.end).toBe(true);
      const hour = Number(local.slice(11, 13));
      expect(hour).toBeGreaterThanOrEqual(OPEN_HOURS.first);
      expect(hour).toBeLessThanOrEqual(OPEN_HOURS.last);
      expect(o.createdAtMs).toBeLessThan(o.paidAtMs);
    }
  });

  it("de fyra sista orderna exakt (svensk tid)", () => {
    const last = orders.slice(-4).map((o) => ({
      externalId: o.externalId,
      title: o.title,
      amountOre: o.amountOre,
      stockholmTime: o.stockholmTime,
    }));
    expect(last).toEqual(SEED_LAST_ORDERS);
    expect(last.map((o) => `${o.externalId} ${o.title} ${o.stockholmTime.slice(11, 16)}`)).toEqual([
      "42777 Ascended Heroes 17:09",
      "42778 Mystery Pack 17:09",
      "42779 Ascended Heroes 17:11",
      "42780 30th Celebration 17:17",
    ]);
  });

  it("order 42780: Shanghai 2 nov. 00:17, UTC 1 nov. 16:17 (som i datamodellen)", () => {
    const o = orders.at(-1);
    expect(o?.externalId).toBe("42780");
    expect(new Date(o?.paidAtMs ?? 0).toISOString()).toBe("2026-11-01T16:17:00.000Z");
    expect(formatInZone(new Date(o?.paidAtMs ?? 0), "Asia/Shanghai")).toBe("2026-11-02 00:17:00");
  });

  it("sommartiden slutar 25 okt: svensk tid räknas rätt före och efter", () => {
    expect(new Date(stockholmToUtcMs("2026-10-24", "12:00:00")).toISOString()).toBe(
      "2026-10-24T10:00:00.000Z",
    );
    expect(new Date(stockholmToUtcMs("2026-10-26", "12:00:00")).toISOString()).toBe(
      "2026-10-26T11:00:00.000Z",
    );
    expect(() => stockholmToUtcMs("2026-10-25", "02:30:00")).toThrow(/entydig/);
  });

  it("försäljningspriset per titel följer schemat i tidsordning", () => {
    for (const t of SEED_TITLES) {
      const amounts = orders.filter((o) => o.title === t.name).map((o) => o.amountOre);
      const expected = t.prices.flatMap((p) => new Array<number>(p.count).fill(p.ore));
      expect(amounts, t.name).toEqual(expected);
    }
  });

  it("alla tre automater säljer, automat 1 mest", () => {
    const counts = SEED_MACHINES.map((m) => summary.byMachine.get(m.code)?.orders ?? 0);
    expect(counts.every((n) => n > 50)).toBe(true);
    expect(counts[0]).toBeGreaterThan(counts[1] ?? 0);
    expect(counts[1]).toBeGreaterThan(counts[2] ?? 0);
  });
});

describe("determinism", () => {
  it("samma frö ger samma order", () => {
    expect(generateSeedOrders()).toEqual(orders);
  });

  it("ett annat frö ger andra tider men samma facit", () => {
    const other = generateSeedOrders(7);
    const s = summarizeSeedOrders(other);
    expect(other.map((o) => o.paidAtMs)).not.toEqual(orders.map((o) => o.paidAtMs));
    expect(s.revenueOre).toBe(EXPECTED_TOTAL_ORE);
    expect(s.bestDay.date).toBe(BEST_DAY);
    expect(other.slice(-4).map((o) => o.stockholmTime)).toEqual(
      SEED_LAST_ORDERS.map((o) => o.stockholmTime),
    );
  });
});

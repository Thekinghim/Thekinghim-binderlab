import { describe, expect, it } from "vitest";

import { formatters, messages } from "@/i18n";

import type { ProductProfitRow } from "../../_enkel/model";
import type { SalesRow } from "../../forsaljning/_lib/model";
import {
  buildWeeklySummary,
  lastWeekOf,
  trendOf,
  weekFromParam,
  weekPeriods,
  weekWords,
  weeklyDue,
  weeklyHref,
  weeklyPushText,
} from "./model";

const day = (key: string, over: Partial<SalesRow> = {}): SalesRow => ({
  key,
  orders: 2,
  revenueOre: 10_000,
  unpricedRevenueOre: 0,
  unpricedOrders: 0,
  profitBeforeShareOre: 4_000,
  ...over,
});

const title = (key: string, over: Partial<ProductProfitRow> = {}): ProductProfitRow => ({
  key,
  kind: "item",
  orders: 3,
  pricedOrders: 3,
  unpricedOrders: 0,
  revenueOre: 20_000,
  unpricedRevenueOre: 0,
  profitBeforeShareOre: 9_000,
  ...over,
});

const NBSP = " ";

describe("veckorna", () => {
  it("förra veckan är hela veckan före den som pågår (måndag–söndag)", () => {
    // Måndag 9 november 2026: förra veckan är 2–8 november, veckan innan 26 okt–1 nov.
    const p = lastWeekOf("2026-11-09");
    expect(p.week).toBe("2026-11-02");
    expect(p.last).toEqual({ start: "2026-11-02", end: "2026-11-08" });
    expect(p.previous).toEqual({ start: "2026-10-26", end: "2026-11-01" });
    expect(p.all).toEqual({ start: "2026-10-26", end: "2026-11-08" });
    // Samma vecka hela veckan ut (söndag 15 november).
    expect(lastWeekOf("2026-11-15").week).toBe("2026-11-02");
    expect(lastWeekOf("2026-11-16").week).toBe("2026-11-09");
  });

  it("över årsskiftet", () => {
    expect(lastWeekOf("2027-01-04").last).toEqual({ start: "2026-12-28", end: "2027-01-03" });
  });

  it("?v= väljer en avslutad vecka; allt annat ger förra veckan", () => {
    const today = "2026-11-10";
    expect(weekFromParam("2026-10-26", today).week).toBe("2026-10-26");
    expect(weekFromParam(["2026-10-26", "x"], today).week).toBe("2026-10-26");
    // Inte en måndag, veckan som pågår, framtiden, för gammal, skräp.
    for (const bad of [
      "2026-10-27",
      "2026-11-09",
      "2026-11-16",
      "2025-01-06",
      "igår",
      "",
      undefined,
      42,
    ]) {
      expect(weekFromParam(bad, today).week, String(bad)).toBe("2026-11-02");
    }
    expect(weekFromParam("2026-11-02", today)).toEqual(weekPeriods("2026-11-02"));
  });
});

describe("weeklyDue", () => {
  const tz = "Europe/Stockholm";
  it("bara måndag från 07:00 lokal tid, sommar som vinter", () => {
    // Vintertid (UTC+1): måndag 9 november 2026.
    expect(weeklyDue(new Date("2026-11-09T05:07:00Z"), tz)).toEqual({
      due: false,
      reason: "not_yet",
    });
    expect(weeklyDue(new Date("2026-11-09T06:07:00Z"), tz)).toEqual({
      due: true,
      week: "2026-11-02",
    });
    // Sommartid (UTC+2): måndag 6 juli 2026, 05:07 UTC är 07:07.
    expect(weeklyDue(new Date("2026-07-06T05:07:00Z"), tz)).toEqual({
      due: true,
      week: "2026-06-29",
    });
    // Sent på måndagen går också (om morgonens körning uteblev).
    expect(weeklyDue(new Date("2026-11-09T22:30:00Z"), tz).due).toBe(true);
  });

  it("aldrig andra dagar", () => {
    expect(weeklyDue(new Date("2026-11-08T10:00:00Z"), tz)).toEqual({
      due: false,
      reason: "not_monday",
    });
    expect(weeklyDue(new Date("2026-11-10T06:07:00Z"), tz)).toEqual({
      due: false,
      reason: "not_monday",
    });
    // Söndag kväll UTC är måndag morgon i Shanghai (men före 07:00 där).
    expect(weeklyDue(new Date("2026-11-08T18:00:00Z"), "Asia/Shanghai")).toEqual({
      due: false,
      reason: "not_yet",
    });
    expect(weeklyDue(new Date("2026-11-08T23:30:00Z"), "Asia/Shanghai")).toEqual({
      due: true,
      week: "2026-11-02",
    });
  });
});

describe("buildWeeklySummary", () => {
  const periods = weekPeriods("2026-11-02");
  const days = [
    day("2026-10-25", { orders: 99 }), // före båda veckorna
    day("2026-10-26", { orders: 4, profitBeforeShareOre: 6_000 }),
    day("2026-11-01", { orders: 1, profitBeforeShareOre: 1_500 }),
    day("2026-11-02", { orders: 5, profitBeforeShareOre: 10_000 }),
    day("2026-11-08", { orders: 2, profitBeforeShareOre: 3_050, unpricedOrders: 1 }),
    day("2026-11-09", { orders: 50 }), // veckan som pågår
  ];
  const titles = [
    { id: "a", name: "Prismatic Evolutions" },
    { id: "b", name: "Surging Sparks" },
    { id: "c", name: "Utan pris" },
  ];

  it("summerar varje vecka för sig, vinsten före butikernas andel", () => {
    const s = buildWeeklySummary({
      periods,
      days,
      titleRows: [
        title("a", { orders: 3, profitBeforeShareOre: 5_000 }),
        title("b", { orders: 4, pricedOrders: 4, profitBeforeShareOre: 8_050 }),
        title("c", { orders: 9, pricedOrders: 0, unpricedOrders: 9, profitBeforeShareOre: 0 }),
      ],
      titles,
      todos: 3,
    });
    expect(s.lastFigures).toMatchObject({ packs: 7, profitOre: 13_050, unpriced: 1 });
    expect(s.previousFigures).toMatchObject({ packs: 5, profitOre: 7_500 });
    // Mest vinst vinner, inte flest pack; en titel utan inköpspris går sist.
    expect(s.best).toEqual({
      titleId: "b",
      name: "Surging Sparks",
      packs: 4,
      profitOre: 8_050,
    });
    expect(s.todos).toBe(3);
    expect(s.week).toBe("2026-11-02");
  });

  it("utan försäljning: ingen bästa produkt", () => {
    const s = buildWeeklySummary({ periods, days: [], titleRows: [], titles, todos: 0 });
    expect(s.lastFigures.packs).toBe(0);
    expect(s.best).toBeNull();
  });

  it("bara titlar utan inköpspris: bästa produkten utan vinst", () => {
    const s = buildWeeklySummary({
      periods,
      days,
      titleRows: [title("c", { orders: 9, pricedOrders: 0, unpricedOrders: 9 })],
      titles,
      todos: null,
    });
    expect(s.best).toMatchObject({ titleId: "c", packs: 9, profitOre: null });
  });
});

describe("notisens text", () => {
  const base = buildWeeklySummary({
    periods: weekPeriods("2026-11-02"),
    days: [
      day("2026-10-27", { orders: 35, profitBeforeShareOre: 99_000 }),
      day("2026-11-03", { orders: 42, profitBeforeShareOre: 124_000 }),
    ],
    titleRows: [title("a")],
    titles: [{ id: "a", name: "Prismatic Evolutions" }],
    todos: 3,
  });

  it("svenska: det viktigaste först", () => {
    const text = weeklyPushText(base, messages("sv"), formatters("sv"));
    expect(text.title).toBe(`Förra veckan: 42${NBSP}pack, 1${NBSP}240${NBSP}kr vinst`);
    expect(text.body).toBe(
      `Veckan innan: 35${NBSP}pack, 990${NBSP}kr. Bäst: Prismatic Evolutions. 3 saker att göra.`,
    );
  });

  it("engelska för delägaren", () => {
    const text = weeklyPushText(base, messages("en"), formatters("en"));
    expect(text.title).toBe(`Last week: 42${NBSP}packs, 1,240${NBSP}kr profit`);
    expect(text.body).toBe(
      `Week before: 35${NBSP}packs, 990${NBSP}kr. Best: Prismatic Evolutions. 3 things to do.`,
    );
  });

  it("inget sålt, inget att göra, långt namn", () => {
    const empty = { ...base, lastFigures: { ...base.lastFigures, packs: 0 }, todos: 0 };
    expect(weeklyPushText(empty, messages("sv"), formatters("sv")).title).toBe(
      "Förra veckan: inget sålt",
    );
    expect(weeklyPushText(empty, messages("sv"), formatters("sv")).body).not.toContain("att göra");
    const none = {
      ...base,
      previousFigures: { ...base.previousFigures, packs: 0 },
      best: { ...base.best!, name: "X".repeat(80) },
      todos: 1,
    };
    const text = weeklyPushText(none, messages("en"), formatters("en"));
    expect(text.body.startsWith("Week before: nothing sold. Best: ")).toBe(true);
    expect(text.body).toContain("…");
    expect(text.body.endsWith("1 thing to do.")).toBe(true);
    expect(text.body.length).toBeLessThan(120);
  });

  it("öppnar Veckan i hela appen och Försäljning i den enkla vyn", () => {
    expect(weeklyHref("2026-11-02", "full")).toBe("/veckan?v=2026-11-02");
    expect(weeklyHref("2026-11-02", "simple")).toBe("/?vecka=2026-11-02");
  });

  it("riktningen mot veckan innan", () => {
    expect(trendOf(5, 3)).toBe("up");
    expect(trendOf(3, 5)).toBe("down");
    expect(trendOf(4, 4)).toBe("same");
  });
});

describe("weekWords", () => {
  const today = "2026-11-10";
  it("förra veckan heter Förra veckan; en äldre vecka kallas inte det", () => {
    const sv = messages("sv");
    const en = messages("en");
    expect(weekWords(sv, "2026-11-02", today)).toEqual({
      label: "Förra veckan",
      headlineNone: "Inget sålt förra veckan.",
    });
    // Notisen öppnad en vecka senare (eller en äldre vecka i adressen): inte "förra veckan".
    expect(weekWords(sv, "2026-10-26", today)).toEqual({
      label: "Den veckan",
      headlineNone: "Inget sålt den veckan.",
    });
    expect(weekWords(en, "2026-11-02", today).headlineNone).toBe("Nothing sold last week.");
    expect(weekWords(en, "2026-10-26", today)).toEqual({
      label: "That week",
      headlineNone: "Nothing sold that week.",
    });
  });
});

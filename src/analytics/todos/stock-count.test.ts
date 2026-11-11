import { describe, expect, it } from "vitest";

import { computeTodos } from "./index";
import { stockCountAge, stockCountLink, STOCK_COUNT_REMINDER_DAYS } from "./stock-count";
import { input, NOW } from "./test-helpers";
import type { StockCountRef } from "./types";

// NOW = måndag 2 nov. 2026 11:00 svensk tid.
const HEMMA = "11111111-1111-4111-8111-111111111111";
const KONTORET = "22222222-2222-4222-8222-222222222222";

const place = (over: Partial<StockCountRef>): StockCountRef => ({
  placeId: HEMMA,
  name: "Hemma",
  lastCountedAt: null,
  createdAt: "2026-01-01T08:00:00Z",
  ...over,
});

const todos = (stockCounts: StockCountRef[] | undefined) =>
  computeTodos(input(stockCounts ? { stockCounts } : {}), NOW).filter(
    (t) => t.kind === "stock-count",
  );

describe("Inventera lagret (30 dagar)", () => {
  it("gränsen är 30 dagar", () => {
    expect(STOCK_COUNT_REMINDER_DAYS).toBe(30);
  });

  it("inventerat för 30 dagar sedan: en mild punkt som länkar till inventeringen", () => {
    // 3 okt. → 2 nov. = 30 dagar.
    const [t] = todos([place({ lastCountedAt: "2026-10-03T10:00:00Z" })]);
    expect(t).toMatchObject({
      key: `stock-count:${HEMMA}`,
      kind: "stock-count",
      level: "later",
      atStakeOre: null,
      title: "Inventera Hemma",
      link: `/vart-lager/inventering?lager=${HEMMA}`,
      action: { kind: "count-stock", label: "Inventera" },
      fingerprint: "2026-10-03T10:00:00Z",
    });
    expect(t!.detail.replace(/ /g, " ")).toBe(
      "Senast inventerat 3 okt. (30 dagar sedan). Räkna packen så stämmer lagret.",
    );
  });

  it("29 dagar sedan: ingen punkt", () => {
    expect(todos([place({ lastCountedAt: "2026-10-04T10:00:00Z" })])).toHaveLength(0);
  });

  it("dagen räknas i svensk tid (23:30 den 3 okt. svensk tid är 3 okt.)", () => {
    expect(todos([place({ lastCountedAt: "2026-10-03T21:30:00Z" })])).toHaveLength(1);
    // 00:30 den 4 okt. svensk tid (22:30 UTC den 3 okt.) är 29 dagar sedan.
    expect(todos([place({ lastCountedAt: "2026-10-03T22:30:00Z" })])).toHaveLength(0);
  });

  it("aldrig inventerat: punkt först när lagret är 30 dagar gammalt", () => {
    const [t] = todos([place({ createdAt: "2026-09-01T08:00:00Z" })]);
    expect(t?.detail).toBe("Inte inventerat än. Räkna packen så stämmer lagret.");
    expect(t?.fingerprint).toBe("none");
    expect(todos([place({ createdAt: "2026-10-20T08:00:00Z" })])).toHaveLength(0);
    // Okänt skapandedatum: ingen påminnelse.
    expect(todos([place({ createdAt: null })])).toHaveLength(0);
  });

  it("en punkt per lager, bara de som är för gamla", () => {
    const list = todos([
      place({ lastCountedAt: "2026-09-01T10:00:00Z" }),
      place({ placeId: KONTORET, name: "Kontoret", lastCountedAt: "2026-11-01T10:00:00Z" }),
    ]);
    expect(list.map((t) => t.title)).toEqual(["Inventera Hemma"]);
  });

  it("efter en ny inventering är punkten borta", () => {
    expect(todos([place({ lastCountedAt: "2026-11-02T09:00:00Z" })])).toHaveLength(0);
  });

  it("utan uppgift (påfyllaren, läsaren): ingen punkt", () => {
    expect(todos(undefined)).toHaveLength(0);
  });

  it("står sist: efter allt som brådskar", () => {
    const all = computeTodos(
      input({
        team: { members: 1, pendingInvites: 0 },
        stockCounts: [place({ lastCountedAt: "2026-09-01T10:00:00Z" })],
      }),
      NOW,
    );
    expect(all.at(-1)?.kind).toBe("stock-count");
  });
});

describe("stockCountAge", () => {
  it("dagar sedan senaste inventeringen och om det är dags", () => {
    expect(
      stockCountAge(
        { lastCountedAt: "2026-11-02T08:00:00Z", createdAt: null },
        "2026-11-02",
        "Europe/Stockholm",
      ),
    ).toEqual({ lastDate: "2026-11-02", daysSince: 0, overdue: false });
    expect(
      stockCountAge(
        { lastCountedAt: "2026-09-01T08:00:00Z", createdAt: null },
        "2026-11-02",
        "Europe/Stockholm",
      ),
    ).toEqual({ lastDate: "2026-09-01", daysSince: 62, overdue: true });
    expect(
      stockCountAge({ lastCountedAt: null, createdAt: null }, "2026-11-02", "Europe/Stockholm"),
    ).toEqual({ lastDate: null, daysSince: null, overdue: false });
  });

  it("länken", () => {
    expect(stockCountLink()).toBe("/vart-lager/inventering");
    expect(stockCountLink(HEMMA)).toBe(`/vart-lager/inventering?lager=${HEMMA}`);
  });
});

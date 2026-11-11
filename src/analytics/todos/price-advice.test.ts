/**
 * Att göra: EN punkt "2\u00a0produkter tjänar för lite" när marginalen före butikernas andel är
 * under målet (standard 25 %), med priset i automaten och dagens inköpspris.
 */
import { describe, expect, it } from "vitest";

import { computeTodos } from "./index";
import { priceAdviceFor } from "./price-advice";
import { input, NOW, order, title, TODAY } from "./test-helpers";
import type { TodoInput } from "./types";

const TITLES = [
  title("fusion", "Fusion Strike"),
  title("flames", "Phantasmal Flames"),
  title("ok", "Surging Sparks"),
];

const base = (p: Partial<TodoInput> = {}) =>
  input({
    titles: TITLES,
    orders: [
      order({ titleId: "fusion", businessDate: "2026-11-01", amountOre: 24_900 }),
      order({ titleId: "flames", businessDate: "2026-10-28", amountOre: 17_900 }),
      order({ titleId: "ok", businessDate: "2026-11-01", amountOre: 9_900 }),
    ],
    prices: [
      { titleId: "fusion", unitCostOre: 22_000, validFrom: "2026-10-01" },
      { titleId: "flames", unitCostOre: 15_000, validFrom: "2026-10-01" },
      { titleId: "ok", unitCostOre: 5_000, validFrom: "2026-10-01" },
    ],
    ...p,
  });

const advice = (i: TodoInput) => computeTodos(i, NOW).filter((t) => t.kind === "price-advice");

describe("prisråd i Att göra", () => {
  it("en punkt för alla produkter under målet", () => {
    const [t, ...rest] = advice(base());
    expect(rest).toEqual([]);
    expect(t).toMatchObject({
      key: "price-advice:all",
      level: "later",
      title: "2\u00a0produkter tjänar för lite",
      link: "/lonsamhet#prisrad",
      action: { kind: "open-pricing", label: "Visa prisråd" },
    });
    expect(t?.detail).toBe(
      "Under 25 % marginal: Fusion Strike, Phantasmal Flames. Priset ändras i automatens system.",
    );
    expect(t?.evidence.titleIds).toEqual(["flames", "fusion"]);
  });

  it("en produkt: singular", () => {
    const one = base({
      prices: base().prices.map((p) => (p.titleId === "flames" ? { ...p, unitCostOre: 5_000 } : p)),
    });
    expect(advice(one)[0]?.title).toBe("1\u00a0produkt tjänar för lite");
  });

  it("organisationens mål styr", () => {
    expect(advice(base({ options: { targetMarginBp: 1_000 } }))).toEqual([]);
    expect(advice(base({ options: { targetMarginBp: 6_000 } }))[0]?.title).toBe(
      "3\u00a0produkter tjänar för lite",
    );
  });

  it("ingen punkt utan inköpspriser (påfyllarens underlag) eller utan köp på 30 dagar", () => {
    expect(advice(base({ prices: [] }))).toEqual([]);
    const old = base({
      orders: [order({ titleId: "fusion", businessDate: "2026-09-20", amountOre: 24_900 })],
    });
    expect(advice(old)).toEqual([]);
  });

  it("arkiverade titlar får inga råd", () => {
    const archived = base({ titles: TITLES.map((t) => ({ ...t, archived: true })) });
    expect(advice(archived)).toEqual([]);
  });

  it("fingerprintet ändras med pris, inköpspris och mål", () => {
    const a = advice(base())[0]!.fingerprint;
    const raised = base({
      orders: [
        ...base().orders,
        order({ titleId: "fusion", businessDate: TODAY, amountOre: 25_900 }),
      ],
    });
    expect(advice(raised)[0]!.fingerprint).not.toBe(a);
    expect(advice(base({ options: { targetMarginBp: 3_000 } }))[0]!.fingerprint).not.toBe(a);
  });

  it("priceAdviceFor ger Lönsamhets rader: pris, inköp, marginal och förslaget", () => {
    const rows = priceAdviceFor(base(), TODAY, 2_500);
    expect(rows).toEqual([
      {
        titleId: "fusion",
        salePriceOre: 24_900,
        lowestIn: null,
        unitCostOre: 22_000,
        profitOre: 2_900,
        marginBp: 1_165,
        suggestedPriceOre: 29_500,
        suggestedMarginBp: 2_542,
      },
      {
        titleId: "flames",
        salePriceOre: 17_900,
        lowestIn: null,
        unitCostOre: 15_000,
        profitOre: 2_900,
        marginBp: 1_620,
        suggestedPriceOre: 20_500,
        suggestedMarginBp: 2_683,
      },
    ]);
  });
});

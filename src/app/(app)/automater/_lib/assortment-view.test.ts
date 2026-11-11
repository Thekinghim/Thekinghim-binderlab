import { describe, expect, it } from "vitest";

import type { AssortmentRow, BestAssortment } from "@/analytics/ranking/assortment";

import { assortmentView } from "./assortment-view";

const plain = (s: string | null) => (s ?? "").replace(/[ ⁠]/g, " ");

function row(over: Partial<AssortmentRow>): AssortmentRow {
  return {
    titleId: "t",
    name: "Pokémon 151",
    current: true,
    mysteryBatch: null,
    units: 112,
    stockedDayTenths: 280,
    enough: true,
    unitsPerDayMilli: 4_000,
    profitPerDayOre: 10_000,
    unpricedUnits: 0,
    slow: false,
    ...over,
  };
}

function assortment(over: Partial<BestAssortment>): BestAssortment {
  const rows = over.rows ?? [row({})];
  return {
    period: { start: "2026-10-01", end: "2026-10-28" },
    days: 28,
    tooShort: false,
    rows,
    best: rows[0] ?? null,
    slow: rows.filter((r) => r.slow),
    suggestions: [],
    otherMachines: 0,
    medianUnitsPerDayMilli: null,
    ...over,
  } as BestAssortment;
}

const view = (a: BestAssortment, deducted = false) =>
  assortmentView({ assortment: a, code: "BL-001", storeShareDeducted: deducted });

describe("assortmentView", () => {
  it("rubriken säger vad som säljer bäst, raderna visar pack och vinst per dag", () => {
    const v = view(assortment({}));
    expect(v.title).toBe("Pokémon 151 säljer bäst här.");
    expect(plain(v.aside)).toBe("4 pack/dag, 100 kr vinst/dag.");
    expect(plain(v.rows[0]!.units)).toBe("4/dag");
    expect(plain(v.rows[0]!.profit)).toBe("100 kr/dag");
    expect(plain(v.rows[0]!.basis)).toBe("28 dagar i lager · 112 pack");
    expect(v.rows[0]!.bar).toBe(1);
    expect(v.notice).toBe("Inget står still: inget att byta ut.");
    expect(v.note).toContain("Vinst före butikernas andel.");
    expect(view(assortment({}), true).note).toContain("Vinst efter butikernas andel.");
  });

  it("förslagen visas som text, och raden märks Står still", () => {
    const slow = row({ titleId: "f", name: "White Flair", unitsPerDayMilli: 107, slow: true });
    const v = view(
      assortment({
        rows: [row({}), slow],
        otherMachines: 2,
        suggestions: [
          {
            swapOut: { titleId: "f", name: "White Flair", unitsPerDayMilli: 107 },
            tryInstead: { titleId: "x", name: "30th", unitsPerDayMilli: 6_000, machines: 2 },
            text: "Byt ut White Flair: säljer 0,1/dag. Prova 30th: säljer 6/dag i 2 andra automater.",
          },
        ],
      }),
    );
    expect(v.suggestions).toHaveLength(1);
    expect(v.notice).toBeNull();
    expect(v.rows[1]).toMatchObject({ tag: "Står still", warn: true });
  });

  it("säger ärligt varför det inte finns något att prova", () => {
    const slow = row({ titleId: "f", name: "White Flair", unitsPerDayMilli: 107, slow: true });
    const sug = {
      swapOut: { titleId: "f", name: "White Flair", unitsPerDayMilli: 107 },
      tryInstead: null,
      text: "Byt ut White Flair: säljer 0,1/dag.",
    };
    const alone = view(assortment({ rows: [row({}), slow], suggestions: [sug] }));
    expect(plain(alone.notice)).toBe(
      "Inget att prova i stället än: ingen annan automat har sålt i 14 dagar.",
    );
    const none = view(assortment({ rows: [row({}), slow], suggestions: [sug], otherMachines: 3 }));
    expect(none.notice).toBe(
      "Inget att prova i stället: ingen titel säljer tydligt bättre i andra automater.",
    );
  });

  it("för kort period och för lite data sägs rakt ut", () => {
    const short = view(assortment({ days: 7, tooShort: true, best: null }));
    expect(plain(short.title)).toBe("För lite data: 7 dagar.");
    expect(plain(short.aside)).toBe("Välj minst 14 dagar för att få förslag.");
    const thin = view(assortment({ best: null, rows: [row({ enough: false })] }));
    expect(thin.title).toBe("För lite data än.");
    expect(thin.rows[0]!.tag).toBe("För lite data");
    expect(view(assortment({ rows: [], best: null })).title).toBe(
      "Inget har sålt i BL-001 i perioden.",
    );
  });

  it("mystery pack, saknat inköpspris och titel utanför sortimentet märks", () => {
    const v = view(
      assortment({
        rows: [
          row({ mysteryBatch: 14 }),
          row({ titleId: "b", profitPerDayOre: null, unpricedUnits: 5 }),
          row({ titleId: "c", current: false }),
        ],
      }),
    );
    expect(plain(v.rows[0]!.tag)).toBe("Mystery pack: fylls bara när facket är tomt (14 st)");
    expect(v.rows[1]!.profit).toBe("Inköpspris saknas");
    expect(v.rows[2]!.tag).toBe("Inte i sortimentet nu");
  });
});

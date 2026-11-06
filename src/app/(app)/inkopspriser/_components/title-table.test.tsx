/**
 * Hyran är en del av butikernas andel. Med vyknappen av och ingen vald butik dras inget som
 * hör till butikerna: inga hyreskolumner ("Kvar efter hyra" drog hyran även när knappen var
 * av). Med andelen synlig (knappen eller vald butik) är butikens andel per order provision
 * eller vinstdelning + hyra, och vår del är det som blir kvar efter båda, som i Lönsamhet.
 */

import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { TitleRow } from "../_lib/model";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {}, refresh: () => {} }) }));

const { TitleTable } = await import("./title-table");

/** En titel: 50 kr kvar före andelen, 10 kr provision och 3 kr hyra per order. */
const ROW: TitleRow = {
  id: "t-1",
  name: "Perfect Order",
  series: null,
  archived: false,
  currentCostOre: 10_000,
  currentFrom: "2026-10-01",
  averagePriceOre: 15_000,
  averageCostOre: 10_000,
  leftBeforeOre: 5_000,
  storeShareOre: 1_300,
  leftOre: 3_700,
  marginBeforeBp: 3_333,
  marginBeforeShare: 0.3333,
  marginBp: 2_467,
  rentOre: 300,
  leftBeforeAfterRentOre: 4_700,
  leftAfterRentOre: 3_700,
  orders: 10,
  unpricedOrders: 0,
  unpricedRevenueOre: 0,
  unpricedFirstDate: null,
  status: "ok",
  own: false,
};

function html(share: { header: string; scope: string } | null): string {
  return renderToString(
    createElement(TitleTable, {
      rows: [ROW],
      selectedId: null,
      baseQuery: "",
      today: "2026-11-03",
      periodLabel: "Oktober",
      criticalIds: [],
      rent: true,
      share,
    }),
  );
}

describe("TitleTable: hyran hör till butikernas andel", () => {
  it("av och ingen butik vald: inget efter hyra, ingen hyra, bara kvar före andelen", () => {
    const out = html(null);
    expect(out).not.toContain("Kvar efter hyra");
    expect(out).not.toContain("Hyra per order");
    expect(out).not.toContain("47,00");
    expect(out).toContain("50,00");
  });

  it("med andelen: andelen inklusive hyra och vår del efter båda, som Lönsamhet", () => {
    const out = html({ header: "Butikernas andel", scope: "alla butiker" });
    expect(out).toContain("Butikernas andel");
    expect(out).toContain("13,00");
    expect(out).toContain("37,00");
    // Ingen andra "vår del" efter hyra: vår del är redan efter hyran.
    expect(out).not.toContain("Vår del efter hyra");
    expect(out).not.toContain("Kvar efter hyra");
  });
});

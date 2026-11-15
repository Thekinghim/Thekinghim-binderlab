/**
 * Vad butiksrapporten visar: den korta rapporten som standard, detaljer bara med butikens
 * val, och regeln för rapporter från före valet fanns.
 */

import { describe, expect, it } from "vitest";

import { NBSP } from "@/lib/format";

import { buildStoreReport } from "./store-report";
import {
  TITLES_ON_REQUEST,
  isLegacyUnsent,
  storeDetailsOf,
  storeHeadline,
  storeReportView,
  storeSummary,
} from "./store-view";
import { agreement, ord, sources } from "./testing/fixtures";

const plain = (text: string) => text.split(NBSP).join(" ");

const src = sources({
  orders: [
    ord("2026-10-03", { amountOre: 10_000 }),
    ord("2026-11-02", { titleId: "t-a", amountOre: 10_000 }),
    ord("2026-11-03", { titleId: "t-b", amountOre: 5_000 }),
  ],
  agreements: [agreement("s-1", "2026-01-01", null, { commissionBp: 1000 })],
});

describe("storeReportView", () => {
  it("standard: beloppet i rubriken, summor, uträkning, veckor, automater och raden om underlag", () => {
    const view = storeReportView(buildStoreReport(src, "s-1", "2026-11"));
    expect(view.details).toBe(false);
    expect(plain(view.headline)).toBe("Er ersättning för november: 15 kr.");
    expect(view.kpis).toEqual(["sales", "orders", "compensation"]);
    expect(view.sections).toEqual(["calculation", "weeks", "machines"]);
    expect(view.closing).toBe("Underlag per titel finns på begäran.");
    expect(view.closing).toBe(TITLES_ON_REQUEST);
  });

  it("standard: inga titlar, inget snittköp och ingen service", () => {
    const view = storeReportView(buildStoreReport(src, "s-1", "2026-11"));
    expect(view.kpis).not.toContain("average");
    expect(view.sections).not.toContain("titles");
    expect(view.sections).not.toContain("service");
    expect(view.headline).not.toContain("30th Celebration");
  });

  it("med detaljer: som förut, med titlar, snittköp och service och utan raden om underlag", () => {
    const report = buildStoreReport(src, "s-1", "2026-11", { details: true });
    const view = storeReportView(report);
    expect(view.details).toBe(true);
    expect(view.headline).toBe(report.conclusion.text);
    expect(view.headline).toContain("30th Celebration");
    expect(view.kpis).toEqual(["sales", "orders", "average", "compensation"]);
    expect(view.sections).toEqual(["calculation", "weeks", "titles", "machines", "service"]);
    expect(view.closing).toBeNull();
  });

  it("en rapport utan sparat val visas kort (aldrig mer än standard)", () => {
    const { details: _details, ...legacy } = buildStoreReport(src, "s-1", "2026-11", {
      details: true,
    });
    void _details;
    expect(storeReportView(legacy).details).toBe(false);
  });
});

describe("storeHeadline", () => {
  it("visar ören bara när beloppet inte är jämna kronor", () => {
    const odd = sources({
      orders: [ord("2026-11-02", { amountOre: 4_999 })],
      agreements: [agreement("s-1", "2026-01-01", null, { commissionBp: 1000 })],
    });
    expect(plain(storeHeadline(buildStoreReport(odd, "s-1", "2026-11")))).toBe(
      "Er ersättning för november: 5 kr.",
    );
    const cents = sources({
      orders: [ord("2026-11-02", { amountOre: 4_950 })],
      agreements: [agreement("s-1", "2026-01-01", null, { commissionBp: 1000 })],
    });
    expect(plain(storeHeadline(buildStoreReport(cents, "s-1", "2026-11")))).toBe(
      "Er ersättning för november: 4,95 kr.",
    );
  });

  it("eget datum: perioden i rubriken", () => {
    const report = buildStoreReport(src, "s-1", { start: "2026-11-01", end: "2026-11-15" });
    expect(plain(storeHeadline(report))).toBe("Er ersättning för 1–15 nov. 2026: 15 kr.");
  });

  it("ingen ersättning: 0 kr, ingen påhittad utbetalningsdag", () => {
    const none = sources({ orders: [ord("2026-11-02")], agreements: [] });
    const text = plain(storeHeadline(buildStoreReport(none, "s-1", "2026-11")));
    expect(text).toBe("Er ersättning för november: 0 kr.");
    expect(text).not.toMatch(/betalas|senast/i);
  });
});

describe("storeDetailsOf: rapporter från före valet fanns", () => {
  it("sparat val gäller alltid, skickad eller inte", () => {
    expect(storeDetailsOf({ details: true }, false)).toBe(true);
    expect(storeDetailsOf({ details: true }, true)).toBe(true);
    expect(storeDetailsOf({ details: false }, false)).toBe(false);
    expect(storeDetailsOf({ details: false }, true)).toBe(false);
  });

  it("utan sparat val: kort, också när den är godkänd; bara en skickad står kvar med detaljer", () => {
    expect(storeDetailsOf({}, false)).toBe(false);
    expect(storeDetailsOf({}, true)).toBe(true);
  });
});

describe("isLegacyUnsent: äldre rapport som inte har skickats", () => {
  it("bara rapporter utan sparat val som inte har gått iväg", () => {
    expect(isLegacyUnsent({}, false)).toBe(true);
    expect(isLegacyUnsent({}, true)).toBe(false);
  });

  it("en rapport med sparat val är aldrig äldre", () => {
    for (const details of [true, false]) {
      expect(isLegacyUnsent({ details }, false)).toBe(false);
      expect(isLegacyUnsent({ details }, true)).toBe(false);
    }
  });

  it("en äldre rapport som inte är skickad visas alltid kort", () => {
    // De två hör ihop: det som inte kan skickas längre visas aldrig med detaljer.
    for (const sent of [true, false]) {
      expect(isLegacyUnsent({}, sent) && storeDetailsOf({}, sent)).toBe(false);
    }
  });
});

describe("storeSummary: meningen under rubriken i portalen", () => {
  const detailed = buildStoreReport(src, "s-1", "2026-11", { details: true });
  // Som den sparades förut: slutsatsen nämner mest sålda titel, inget sparat val.
  const { details: _d, ...legacy } = detailed;
  void _d;

  it("äldre rapport som visas kort: raden om ersättningen, aldrig titeln", () => {
    expect(legacy.conclusion.text).toContain(legacy.topTitles[0]!.name);
    const text = storeSummary(legacy, false);
    expect(text).toBe(storeHeadline(legacy));
    for (const t of legacy.topTitles) expect(text).not.toContain(t.name);
  });

  it("äldre rapport som har skickats: slutsatsen som den skickades", () => {
    expect(storeSummary(legacy, true)).toBe(legacy.conclusion.text);
  });

  it("rapport med sparat val: sin egen slutsats", () => {
    expect(storeSummary(detailed, true)).toBe(detailed.conclusion.text);
    const short = buildStoreReport(src, "s-1", "2026-11");
    expect(storeSummary(short, false)).toBe(short.conclusion.text);
    expect(short.conclusion.text).not.toContain(detailed.topTitles[0]!.name);
  });
});

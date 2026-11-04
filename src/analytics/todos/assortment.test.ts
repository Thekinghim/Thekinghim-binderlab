import { describe, expect, it } from "vitest";

import {
  assortmentKey,
  isRetiredRefill,
  retiredPairs,
  retiredTitles,
  withoutRetiredRefills,
  type SlotPeriod,
} from "./assortment";
import { computeTodos } from "./index";
import { daily, input, NOW, title } from "./test-helpers";
import type { TodoInput } from "./types";

const TODAY = "2026-11-02";
const period = (validTo: string | null, validFrom = "2026-02-01"): SlotPeriod => ({
  machineId: "m1",
  titleId: "t1",
  validFrom,
  validTo,
});

describe("utgångna titlar (sortimentet)", () => {
  it("är utgångna när ingen period gäller i dag och ingen börjar senare", () => {
    expect(retiredPairs([period("2026-10-31")], TODAY)).toEqual(
      new Set([assortmentKey("m1", "t1")]),
    );
    // Sista dagen i dag gäller fortfarande.
    expect(retiredPairs([period(TODAY)], TODAY).size).toBe(0);
    // Tills vidare, eller en ny period efter en gammal.
    expect(retiredPairs([period(null)], TODAY).size).toBe(0);
    expect(retiredPairs([period("2026-05-31"), period(null, "2026-09-01")], TODAY).size).toBe(0);
    // Inget registrerat sortiment: aldrig utgånget.
    expect(retiredPairs([], TODAY).size).toBe(0);
  });

  // Fönstret: 14 dagar t.o.m. i går. 4 pack vid 2 per dag räcker 2,0 dagar: påfyllning.
  const base = (p: Partial<TodoInput> = {}) =>
    input({
      titles: [title("t1", "Black Bolt")],
      orders: daily("t1", "m1", "2026-10-19", 14, 2),
      stock: [{ machineId: "m1", titleId: "t1", onHand: 4 }],
      ...p,
    });
  const refills = (i: TodoInput) => computeTodos(i, NOW).filter((t) => t.kind === "refill");

  it("ger ingen påfyllningspunkt för en utgången titel, men för en som gäller", () => {
    expect(refills(base())).toHaveLength(1);
    expect(refills(base({ slotPeriods: [period(null)] }))).toHaveLength(1);
    expect(refills(base({ slotPeriods: [period("2026-10-31")] }))).toHaveLength(0);
  });

  it("filtrerar laddarens punkter med samma regel (menyns räknare och listan)", () => {
    const items = computeTodos(base(), NOW);
    const retired = retiredPairs([period("2026-10-31")], TODAY);
    const refill = items.find((t) => t.kind === "refill")!;
    expect(isRetiredRefill(refill, retired)).toBe(true);
    const kept = withoutRetiredRefills(items, retired);
    expect(kept.some((t) => t.kind === "refill")).toBe(false);
    expect(kept).toHaveLength(items.length - 1);
    expect(withoutRetiredRefills(items, new Set())).toEqual(items);
  });

  it("tar också bort en tyst titel för en utgången titel, men inte en tyst automat", () => {
    const item = computeTodos(base(), NOW).find((t) => t.kind === "refill")!;
    const retired = retiredPairs([period("2026-10-31")], TODAY);
    expect(isRetiredRefill({ ...item, kind: "silent-title" }, retired)).toBe(true);
    expect(isRetiredRefill({ ...item, kind: "stale-machine" }, retired)).toBe(false);
  });
});

describe("retiredTitles", () => {
  it("titlar utan gällande period i någon automat; utan perioder aldrig utgången", () => {
    const periods = [
      { machineId: "m1", titleId: "bolt", validFrom: "2026-10-14", validTo: "2026-11-02" },
      { machineId: "m1", titleId: "30th", validFrom: "2026-10-14", validTo: "2026-11-02" },
      { machineId: "m2", titleId: "30th", validFrom: "2026-10-14", validTo: null },
    ] as const;
    expect([...retiredTitles(periods, "2026-11-04")]).toEqual(["bolt"]);
    expect(retiredTitles([], "2026-11-04").size).toBe(0);
  });
});

import { describe, expect, it } from "vitest";

import { missingSettlementTodos } from "@/analytics/todos/settlements";
import { createTodoContext } from "@/analytics/todos/context";

import { missingSettlements, previousProfitOre } from "./cards-model";

describe("previousProfitOre (Resultat = hjältekortet)", () => {
  it("tar jämförelseperiodens vinst som den är, inte baklänges ur förändringen", () => {
    // 31 104 kr nu, 140 121 kr förra perioden: förändringen avrundas, beloppet ska inte göra det.
    const kpi = { value: 3_110_400, previous: 14_012_100, delta: 3_110_400 / 14_012_100 - 1 };
    const prev = previousProfitOre(kpi);
    expect(prev).toBe(14_012_100);
    expect(kpi.value - prev!).toBe(-10_901_700);
    // Den gamla uträkningen gav ett annat belopp så fort förändringen var avrundad.
    const rounded = Math.round(kpi.delta * 10_000) / 10_000;
    expect(Math.round(kpi.value / (1 + rounded))).not.toBe(prev);
  });

  it("ingen jämförelse eller inget värde: null", () => {
    expect(previousProfitOre({ value: 100, previous: null })).toBeNull();
    expect(previousProfitOre({ value: null, previous: 100 })).toBeNull();
    expect(previousProfitOre(undefined)).toBeNull();
  });
});

describe("missingSettlements (Butiker-kortet räknar saknade avräkningar)", () => {
  it("samma butiker, månad och länk som Att göras 'Skapa oktober-avräkningarna'", () => {
    const missing = [
      { storeName: "Kafé Ett", month: "2026-10" },
      { storeName: "Butik Två", month: "2026-10" },
    ];
    const m = missingSettlements(missing)!;
    expect(m.text).toBe("2 butiker saknar avräkning för oktober.");
    expect(m.stores).toBe(2);
    expect(m.due).toBe("2026-11-15");
    const [todo] = missingSettlementTodos(
      createTodoContext(
        {
          orders: [],
          prices: [],
          agreements: [],
          placements: [],
          settings: { vatRateBp: 0, cardFeeBp: 0 },
          titles: [],
          machines: [],
          stores: [
            { id: "s1", name: "Kafé Ett" },
            { id: "s2", name: "Butik Två" },
          ],
          stock: [],
          reportRecipients: [],
          reportDeliveries: [],
          missingSettlements: { month: "2026-10", storeIds: ["s1", "s2"] },
        },
        new Date("2026-11-26T10:00:00Z"),
      ),
    );
    expect(m.href).toBe(todo!.link);
    expect(todo!.evidence.dates).toContain(m.due);
  });

  it("äldsta månaden styr; inget saknas: null", () => {
    const m = missingSettlements([
      { storeName: "Kafé Ett", month: "2026-10" },
      { storeName: "Butik Två", month: "2026-09" },
    ])!;
    expect(m.due).toBe("2026-10-15");
    expect(m.href).toContain("manad=2026-09");
    expect(missingSettlements([])).toBeNull();
  });
});

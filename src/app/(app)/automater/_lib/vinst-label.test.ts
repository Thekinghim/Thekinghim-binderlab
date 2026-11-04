import { describe, expect, it } from "vitest";

import { machineHeadline, overviewKpis, spanOf } from "./model";

describe("Automater: en betydelse av vinst", () => {
  it("kallar vinsten Vår vinst, som Hem och Lönsamhet", () => {
    const k = overviewKpis({
      revenueOre: 100_000,
      revenueChange: null,
      profitOre: 12_000,
      profitChange: null,
      marginBp: 1_200,
      previousMarginBp: null,
      orders: 10,
      ordersChange: null,
      revenuePerMachineDayOre: null,
    } as unknown as Parameters<typeof overviewKpis>[0]);
    expect(k.find((x) => x.id === "profit")?.label).toBe("Vår vinst");
  });

  it("automatsidans rubrik säger Vår vinst, inte bara Vinst (utvärderingen 4 nov., punkt 4)", () => {
    const h = machineHeadline({
      code: "BL-001",
      lifecycle: "active",
      activeFrom: "2026-10-13",
      activeTo: null,
      figures: { revenueOre: 9_015_700, profitOre: 1_481_700 } as unknown as Parameters<
        typeof machineHeadline
      >[0]["figures"],
      previous: null,
      span: spanOf({ start: "2026-10-13", end: "2026-11-03" }, "2026-11-04"),
      store: { name: "Sega gubben", since: "2026-10-13" },
      today: "2026-11-04",
    });
    expect(h.aside).toMatch(/^Vår vinst 14\s817\skr/);
  });
});

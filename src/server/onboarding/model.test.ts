import { describe, expect, it } from "vitest";

import {
  buildOnboardingStatus,
  coverageReachedAt,
  coverageText,
  priceCoverage,
  PRICE_COVERAGE_TARGET_BP,
  type OnboardingFacts,
  type RevenueGroup,
} from "./model";

const ORG = "00000000-0000-4000-8000-000000000001";
const T0 = "2026-11-02T08:00:00.000Z";
const at = (min: number) => new Date(Date.parse(T0) + min * 60_000).toISOString();

function facts(over: Partial<OnboardingFacts> = {}): OnboardingFacts {
  return {
    organization: { name: "Kortautomater Väst AB", createdAt: T0 },
    stores: { count: 0, firstAt: null },
    agreements: { count: 0, firstAt: null, targetStoreId: null },
    machines: {
      count: 0,
      firstAt: null,
      placed: 0,
      placedOrPlanned: 0,
      placedAt: null,
      unplacedCode: null,
    },
    dataSources: { count: 0, firstAt: null },
    imports: { withOrders: 0, firstAt: null, orders: 0 },
    revenue: [],
    prices: [],
    vatRateBp: 0,
    ...over,
  };
}

const groups: RevenueGroup[] = [
  { titleId: "a", businessDate: "2026-10-05", amountOre: 4_900, orders: 9 }, // 44 100
  { titleId: "b", businessDate: "2026-10-05", amountOre: 4_900, orders: 1 }, //  4 900
];

function full(): OnboardingFacts {
  return facts({
    stores: { count: 1, firstAt: at(5) },
    agreements: { count: 1, firstAt: at(9), targetStoreId: "s1" },
    machines: {
      count: 1,
      firstAt: at(12),
      placed: 1,
      placedOrPlanned: 1,
      placedAt: at(14),
      unplacedCode: null,
    },
    dataSources: { count: 1, firstAt: at(20) },
    imports: { withOrders: 1, firstAt: at(30), orders: 10 },
    revenue: groups,
    prices: [
      { titleId: "a", unitCostOre: 2_000, validFrom: "2026-01-01", createdAt: at(40) },
      { titleId: "b", unitCostOre: 2_000, validFrom: "2026-01-01", createdAt: at(50) },
    ],
  });
}

describe("priceCoverage", () => {
  it("räknar andelen av nettointäkten med pris den dagen", () => {
    const c = priceCoverage(groups, [{ titleId: "a", unitCostOre: 1, validFrom: "2026-10-05" }], 0);
    expect(c).toEqual({
      revenueOre: 49_000,
      pricedRevenueOre: 44_100,
      pricedShareBp: 9_000,
      untitledRevenueOre: 0,
    });
  });

  it("ett pris som börjar gälla efter ordern täcker den inte", () => {
    const c = priceCoverage(groups, [{ titleId: "a", unitCostOre: 1, validFrom: "2026-10-06" }], 0);
    expect(c.pricedShareBp).toBe(0);
  });

  it("drar momsen per order (som domänlagret) och räknar order utan titel som utan pris", () => {
    const c = priceCoverage(
      [
        { titleId: "a", businessDate: "2026-10-05", amountOre: 4_900, orders: 2 },
        { titleId: null, businessDate: "2026-10-05", amountOre: 4_900, orders: 2 },
      ],
      [{ titleId: "a", unitCostOre: 1, validFrom: "2026-01-01" }],
      2_500,
    );
    // 4 900 − round(4 900 × 2 500 / 12 500) = 3 920 per order.
    expect(c).toEqual({
      revenueOre: 15_680,
      pricedRevenueOre: 7_840,
      pricedShareBp: 5_000,
      untitledRevenueOre: 7_840,
    });
  });

  it("ingen intäkt ger ingen andel", () => {
    expect(priceCoverage([], [], 0).pricedShareBp).toBeNull();
  });
});

describe("coverageReachedAt", () => {
  it("ger tidpunkten för det pris som tog täckningen över gränsen", () => {
    expect(coverageReachedAt(groups, full().prices, 0)).toBe(at(40));
  });

  it("ordningen avgörs av när priset lades in, inte av listans ordning", () => {
    const prices = [
      { titleId: "b", unitCostOre: 1, validFrom: "2026-01-01", createdAt: at(10) },
      { titleId: "a", unitCostOre: 1, validFrom: "2026-01-01", createdAt: at(70) },
    ];
    expect(coverageReachedAt(groups, prices, 0)).toBe(at(70));
  });

  it("null när gränsen inte nås", () => {
    const prices = [{ titleId: "b", unitCostOre: 1, validFrom: "2026-01-01", createdAt: at(1) }];
    expect(coverageReachedAt(groups, prices, 0)).toBeNull();
  });
});

describe("buildOnboardingStatus", () => {
  it("ny organisation: bara organisationen är klar, beroende steg väntar", () => {
    const s = buildOnboardingStatus(ORG, facts(), new Date(at(15)));
    expect(s.complete).toBe(false);
    expect(s.requiredDone).toBe(1);
    expect(s.requiredTotal).toBe(6);
    expect(Object.fromEntries(s.steps.map((x) => [x.id, x.state]))).toEqual({
      organisation: "done",
      butik: "todo",
      avtal: "waiting",
      automat: "waiting",
      datakalla: "todo",
      import: "waiting",
      inkopspriser: "waiting",
    });
    expect(s.next?.id).toBe("butik");
    expect(s.elapsedMs).toBe(15 * 60_000);
    expect(s.completedAt).toBeNull();
    expect(s.steps.map((x) => x.number)).toEqual(["01", "02", "03", "04", "05", "06", "07"]);
  });

  it("allt på plats: klar, med tid per steg och total tid till sista krävda steget", () => {
    const s = buildOnboardingStatus(ORG, full(), new Date(at(600)));
    expect(s.complete).toBe(true);
    expect(s.next).toBeNull();
    expect(s.completedAt).toBe(at(40));
    expect(s.elapsedMs).toBe(40 * 60_000);
    expect(s.loadedAtOnce).toBe(false);
    const byId = Object.fromEntries(s.steps.map((x) => [x.id, x]));
    expect(byId.butik!.sinceStartMs).toBe(5 * 60_000);
    expect(byId.import!.doneAt).toBe(at(30));
    expect(byId.inkopspriser!.doneAt).toBe(at(40));
    expect(byId.avtal!.action?.href).toBe("/butiker/s1#ersattning");
    expect(byId.inkopspriser!.detail).toBe(
      `100,0 % av intäkten har inköpspris, gränsen är 90,0 %.`,
    );
  });

  it("avtalet krävs inte för att panelen ska vara klar", () => {
    const f = full();
    const s = buildOnboardingStatus(
      ORG,
      { ...f, agreements: { count: 0, firstAt: null, targetStoreId: "s1" } },
      new Date(at(600)),
    );
    expect(s.complete).toBe(true);
    expect(s.steps.find((x) => x.id === "avtal")!.state).toBe("todo");
    expect(s.next?.id).toBe("avtal");
  });

  it("under 90 % av intäkten med pris: inköpspriserna är kvar att göra", () => {
    const f = full();
    const s = buildOnboardingStatus(ORG, { ...f, prices: [f.prices[1]!] }, new Date(at(600)));
    expect(s.complete).toBe(false);
    expect(s.next?.id).toBe("inkopspriser");
    // Hela datan (period=allt), inte skalets standardperiod: alla order utan pris syns.
    expect(s.next?.action?.href).toBe("/inkopspriser?saknar=pris&period=allt");
    expect(s.coverage.pricedShareBp).toBe(1_000);
  });

  it("priser inlagda före importen: steget blir klart när orderna kom", () => {
    const f = full();
    const early = f.prices.map((p) => ({ ...p, createdAt: at(1) }));
    const s = buildOnboardingStatus(ORG, { ...f, prices: early }, new Date(at(600)));
    expect(s.steps.find((x) => x.id === "inkopspriser")!.doneAt).toBe(at(30));
  });

  it("automat utan placering är inte klar: länken går till automaten", () => {
    const f = full();
    const s = buildOnboardingStatus(
      ORG,
      {
        ...f,
        machines: {
          count: 1,
          firstAt: at(12),
          placed: 0,
          placedOrPlanned: 0,
          placedAt: null,
          unplacedCode: "BL-101",
        },
      },
      new Date(at(600)),
    );
    const automat = s.steps.find((x) => x.id === "automat")!;
    expect(automat.state).toBe("todo");
    expect(automat.detail).toBe("1\u00a0automat, ingen placerad i en butik.");
    expect(automat.action).toEqual({ label: "Placera BL-101", href: "/automater/bl-101" });
    expect(s.complete).toBe(false);
    expect(s.next?.id).toBe("automat");
  });

  it("automat placerad från ett senare datum räknas, med placeringens tid", () => {
    const f = full();
    const s = buildOnboardingStatus(
      ORG,
      { ...f, machines: { ...f.machines, placed: 0, placedOrPlanned: 1, placedAt: at(15) } },
      new Date(at(600)),
    );
    const automat = s.steps.find((x) => x.id === "automat")!;
    expect(automat.state).toBe("done");
    expect(automat.doneAt).toBe(at(15));
  });

  it("automat utan butik väntar på butiken", () => {
    const s = buildOnboardingStatus(
      ORG,
      facts({
        machines: {
          count: 1,
          firstAt: at(1),
          placed: 0,
          placedOrPlanned: 0,
          placedAt: null,
          unplacedCode: "BL-1",
        },
      }),
      new Date(at(5)),
    );
    const automat = s.steps.find((x) => x.id === "automat")!;
    expect(automat.state).toBe("waiting");
    expect(automat.waitingFor).toBe("Väntar på en butik att placera den i.");
  });

  it("order utan titel: andelen står i stegets text", () => {
    const f = full();
    const s = buildOnboardingStatus(
      ORG,
      {
        ...f,
        revenue: [
          ...f.revenue,
          { titleId: null, businessDate: "2026-10-05", amountOre: 4_900, orders: 1 },
        ],
      },
      new Date(at(600)),
    );
    const prices = s.steps.find((x) => x.id === "inkopspriser")!;
    // 49 000 av 53 900 med pris (90,9 %), 4 900 utan titel (9,1 %, avrundat uppåt).
    expect(prices.detail.replace(/\u00a0/g, " ")).toBe(
      "90,9 % av intäkten har inköpspris, gränsen är 90,0 %. 9,1 % är order utan tolkad titel, som inte kan få inköpspris förrän titeln är känd.",
    );
    expect(prices.state).toBe("done");
  });

  it("data inlagd på en gång (seed): ingen tid att visa", () => {
    const f = full();
    const instant: OnboardingFacts = {
      ...f,
      stores: { count: 1, firstAt: at(0) },
      machines: { ...f.machines, firstAt: at(0), placedAt: at(0) },
      dataSources: { count: 1, firstAt: at(0) },
      imports: { ...f.imports, firstAt: at(0.5) },
      prices: f.prices.map((p) => ({ ...p, createdAt: at(0.2) })),
    };
    const s = buildOnboardingStatus(ORG, instant, new Date(at(600)));
    expect(s.complete).toBe(true);
    expect(s.loadedAtOnce).toBe(true);
  });

  it("import utan order räknas inte; inköpspriserna väntar då", () => {
    const f = full();
    const s = buildOnboardingStatus(
      ORG,
      { ...f, imports: { withOrders: 0, firstAt: null, orders: 0 }, revenue: [] },
      new Date(at(600)),
    );
    const byId = Object.fromEntries(s.steps.map((x) => [x.id, x.state]));
    expect(byId.import).toBe("todo");
    expect(byId.inkopspriser).toBe("waiting");
  });
});

describe("coverageText", () => {
  it("avrundar nedåt så att gränsen aldrig visas som nådd för tidigt", () => {
    expect(coverageText(8_996)).toBe("89,9 %");
    expect(coverageText(PRICE_COVERAGE_TARGET_BP)).toBe("90,0 %");
  });
});

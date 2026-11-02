import { describe, expect, it } from "vitest";

import { priceHistory, titleEconomics, type TitleEconomics } from "@/domain";

import {
  PRICE_MESSAGES,
  actorName,
  closedMonthsHit,
  pageHeadline,
  parsePriceInput,
  perTitleAside,
  previewPrice,
  priceLog,
  priceTimeline,
  sentence,
  signalTitleIds,
  suggestedValidFrom,
  timelineShares,
  titleHeadline,
  titleRows,
  type PriceAuditEvent,
  type TitleRow,
} from "./model";

const NBSP = " ";
const DATES = { asOf: "2026-11-01", today: "2026-11-02" };

function row(over: Partial<TitleRow>): TitleRow {
  return {
    id: "t",
    name: "Titel",
    series: null,
    archived: false,
    currentCostOre: 10_000,
    currentFrom: "2026-10-01",
    averagePriceOre: 15_000,
    averageCostOre: 10_000,
    leftOre: 5_000,
    marginBp: 3_333,
    rentOre: 300,
    leftAfterRentOre: 4_700,
    orders: 10,
    unpricedOrders: 0,
    unpricedRevenueOre: 0,
    unpricedFirstDate: null,
    status: "ok",
    ...over,
  };
}

describe("parsePriceInput", () => {
  it("tar emot kronor med komma, punkt, mellanslag och kr", () => {
    expect(parsePriceInput("112,50")).toEqual({ ok: true, ore: 11_250 });
    expect(parsePriceInput("112")).toEqual({ ok: true, ore: 11_200 });
    expect(parsePriceInput("1 120 kr")).toEqual({ ok: true, ore: 112_000 });
    expect(parsePriceInput("0")).toEqual({ ok: true, ore: 0 });
  });

  it("nekar tomt, negativt, för många decimaler och orimligt stora belopp", () => {
    expect(parsePriceInput("").ok).toBe(false);
    expect(parsePriceInput("-5").ok).toBe(false);
    expect(parsePriceInput("12,345").ok).toBe(false);
    expect(parsePriceInput("abc").ok).toBe(false);
    expect(parsePriceInput("100 001").ok).toBe(false);
  });
});

describe("closedMonthsHit", () => {
  const prices = [{ validFrom: "2026-09-01" }, { validFrom: "2026-11-01" }];

  it("ett pris gäller till dagen före nästa pris: bara månaderna däremellan räknas", () => {
    expect(closedMonthsHit(prices, "2026-10-05", ["2026-09", "2026-10", "2026-11"])).toEqual([
      "2026-10",
    ]);
  });

  it("ett pris i en öppen månad som skulle gälla in i en stängd blockeras också", () => {
    expect(closedMonthsHit([], "2026-08-15", ["2026-09"])).toEqual(["2026-09"]);
  });

  it("efter den sista stängda månaden: inget", () => {
    expect(closedMonthsHit(prices, "2026-11-15", ["2026-09", "2026-10"])).toEqual([]);
  });

  it("felet säger vilka månader det gäller", () => {
    expect(PRICE_MESSAGES.closedMonth(["2026-09"])).toContain("september 2026, som är stängd");
    expect(PRICE_MESSAGES.closedMonth(["2026-09", "2026-10"])).toContain(
      "september 2026 och oktober 2026, som är stängda",
    );
  });
});

describe("titleRows", () => {
  it("sätter status från titleEconomics och hoppar över okända titlar", () => {
    const base = {
      orders: [
        {
          id: "o1",
          externalId: "1",
          titleId: "a",
          machineId: null,
          businessDate: "2026-10-02",
          amountOre: 4_900,
        },
        {
          id: "o2",
          externalId: "2",
          titleId: "b",
          machineId: null,
          businessDate: "2026-10-02",
          amountOre: 4_900,
        },
      ],
      prices: [
        { titleId: "a", unitCostOre: 2_000, validFrom: "2026-10-01" },
        { titleId: "c", unitCostOre: 6_000, validFrom: "2026-10-01" },
      ],
      agreements: [],
      placements: [],
      settings: { vatRateBp: 0, cardFeeBp: 0 },
      period: { start: "2026-10-01", end: "2026-10-31" },
    };
    const econ: TitleEconomics[] = titleEconomics({ ...base, titleIds: ["d"] });
    const rows = titleRows(econ, [
      { id: "a", name: "A", series: null, archived: false },
      { id: "b", name: "B", series: null, archived: false },
      { id: "c", name: "C", series: null, archived: false },
    ]);
    const status = Object.fromEntries(rows.map((r) => [r.name, r.status]));
    expect(status).toEqual({ A: "ok", B: "missing", C: "idle" });
    expect(rows.find((r) => r.name === "A")?.leftOre).toBe(2_900);
  });
});

describe("titleRows: delvis utan pris", () => {
  it("en titel med pris i dag men order utan pris tidigare i perioden får egen status", () => {
    const base = {
      orders: [
        {
          id: "o1",
          externalId: "1",
          titleId: "a",
          machineId: null,
          businessDate: "2026-10-02",
          amountOre: 4_900,
        },
        {
          id: "o2",
          externalId: "2",
          titleId: "a",
          machineId: null,
          businessDate: "2026-10-20",
          amountOre: 4_900,
        },
      ],
      prices: [{ titleId: "a", unitCostOre: 2_000, validFrom: "2026-10-10" }],
      agreements: [],
      placements: [],
      settings: { vatRateBp: 0, cardFeeBp: 0 },
      period: { start: "2026-10-01", end: "2026-10-31" },
    };
    const rows = titleRows(
      titleEconomics(base),
      [{ id: "a", name: "A", series: null, archived: false }],
      [
        {
          titleId: "a",
          orders: 1,
          revenueOre: 4_900,
          firstDate: "2026-10-02",
          lastDate: "2026-10-02",
        },
      ],
    );
    expect(rows[0]).toMatchObject({
      status: "partial",
      unpricedOrders: 1,
      unpricedRevenueOre: 4_900,
      unpricedFirstDate: "2026-10-02",
    });
  });
});

describe("pageHeadline", () => {
  it("titlar utan pris först, med order och intäkt som inte räknas", () => {
    const h = pageHeadline(
      [
        row({
          id: "a",
          name: "A",
          status: "missing",
          currentCostOre: null,
          orders: 3,
          unpricedOrders: 3,
          unpricedRevenueOre: 45_000,
        }),
        row({ id: "b" }),
      ],
      DATES,
    );
    expect(h.title).toBe("A saknar inköpspris.");
    expect(h.aside).toBe(`3 order och 450${NBSP}kr i intäkt räknas inte in i vinsten.`);
  });

  it("en titel med pris i dag men order utan pris tidigare: rubriken säger det", () => {
    const h = pageHeadline(
      [
        row({
          id: "a",
          name: "A",
          status: "partial",
          unpricedOrders: 3,
          unpricedRevenueOre: 14_700,
          unpricedFirstDate: "2026-10-14",
        }),
        row({ id: "b", name: "B" }),
      ],
      DATES,
    );
    expect(h.title).toBe("A har 3 order utan inköpspris.");
    expect(h.aside).toBe(`147${NBSP}kr i intäkt från 14${NBSP}okt. räknas inte in i vinsten.`);
  });

  it("namn och siffror gäller samma titlar: alla titlar med order utan pris räknas", () => {
    const h = pageHeadline(
      [
        row({
          id: "a",
          name: "A",
          status: "missing",
          currentCostOre: null,
          orders: 2,
          unpricedOrders: 2,
          unpricedRevenueOre: 10_000,
        }),
        row({
          id: "b",
          name: "B",
          status: "partial",
          unpricedOrders: 3,
          unpricedRevenueOre: 14_700,
        }),
      ],
      DATES,
    );
    expect(h.title).toBe("2 titlar har order utan inköpspris.");
    expect(h.aside).toBe(`5 order och 247${NBSP}kr i intäkt räknas inte in i vinsten.`);
  });

  it("annars förlust, sämsta titeln först, med priset som gäller periodens slut", () => {
    const h = pageHeadline(
      [
        row({ id: "a", name: "A", status: "loss", leftOre: -100 }),
        row({ id: "b", name: "B", status: "loss", leftOre: -513 }),
      ],
      DATES,
    );
    expect(h.title).toBe("2 titlar går med förlust.");
    expect(h.aside).toBe(
      `Sämst är B: −5,13${NBSP}kr per order med inköpspriset som gäller 1${NBSP}nov.`,
    );
  });

  it("allt i ordning: minst kvar per order", () => {
    const h = pageHeadline(
      [row({ id: "a", name: "A", leftOre: 900 }), row({ id: "b", name: "B" })],
      DATES,
    );
    expect(h.title).toBe("Alla 2 titlar har inköpspris.");
    expect(h.aside).toBe(`Minst kvar per order: A, 9,00${NBSP}kr.`);
  });

  it("titlar utan pris som inte sålt i perioden nämns utan intäkt", () => {
    const h = pageHeadline(
      [row({ id: "a", name: "A", status: "missing", currentCostOre: null, orders: 0 })],
      DATES,
    );
    expect(h.title).toBe("1 titel utan inköpspris.");
  });
});

describe("perTitleAside", () => {
  it("den titel som lämnar minst, med datumet för priset", () => {
    expect(
      perTitleAside(
        [row({ id: "a", name: "A", leftOre: 3_935 }), row({ id: "b", name: "B" })],
        DATES,
      ),
    ).toBe(`Minst kvar har A, 39,35${NBSP}kr per order med inköpspriset som gäller 1${NBSP}nov.`);
    expect(perTitleAside([row({ leftOre: null, orders: 0 })], DATES)).toBe(
      "Ingen titel med inköpspris har sålt i perioden.",
    );
  });
});

describe("titleHeadline och sentence", () => {
  it("ingen dubbel punkt efter en förkortning", () => {
    expect(sentence("t.o.m. 26 okt.")).toBe("t.o.m. 26 okt.");
    expect(sentence("tills vidare")).toBe("tills vidare.");
    expect(titleHeadline(row({ leftOre: null, currentFrom: "2026-10-27" }), "X").aside).toBe(
      `Inköp 100,00${NBSP}kr sedan 27${NBSP}okt. Ingen försäljning i perioden.`,
    );
  });

  it("förlust med liten bokstav, går jämnt vid 0 och förlust efter hyra", () => {
    expect(titleHeadline(row({ leftOre: -513 }), "B").aside).toBe(
      `Inköp 100,00${NBSP}kr sedan 1${NBSP}okt., förlust 5,13${NBSP}kr per order.`,
    );
    expect(titleHeadline(row({ leftOre: 0 }), "B").aside).toContain("går jämnt per order.");
    expect(
      titleHeadline(row({ leftOre: 500, leftAfterRentOre: -200, status: "loss-after-rent" }), "B")
        .aside,
    ).toContain(`5,00${NBSP}kr kvar per order, men förlust 2,00${NBSP}kr per order efter hyra.`);
  });

  it("order utan pris i perioden nämns", () => {
    expect(titleHeadline(row({ unpricedOrders: 4, status: "partial" }), "B").aside).toContain(
      "4 order i perioden saknar inköpspris och räknas inte in i vinsten.",
    );
  });
});

describe("signalTitleIds", () => {
  it("högst tre, saknat pris före förlust och flest order först", () => {
    const rows = [
      row({ id: "l1", status: "loss", orders: 50 }),
      row({ id: "m1", status: "missing", orders: 1 }),
      row({ id: "m2", status: "missing", orders: 9 }),
      row({ id: "l2", status: "loss", orders: 80 }),
      row({ id: "ok", status: "ok" }),
    ];
    expect(signalTitleIds(rows)).toEqual(["m2", "m1", "l2"]);
  });
});

describe("priceTimeline", () => {
  const prices = [
    { titleId: "t", unitCostOre: 10_500, validFrom: "2026-10-01" },
    { titleId: "t", unitCostOre: 11_200, validFrom: "2026-10-27" },
    { titleId: "t", unitCostOre: 11_500, validFrom: "2026-12-01" },
  ];
  const days = [
    { date: "2026-10-05", orders: 3 },
    { date: "2026-10-26", orders: 2 },
    { date: "2026-10-27", orders: 4 },
  ];

  it("senaste först, förändring, order per prisperiod och vad som gäller i dag", () => {
    const t = priceTimeline(priceHistory(prices, "t"), days, "2026-11-02");
    expect(t.map((e) => [e.validFrom, e.validTo, e.orders, e.current, e.future])).toEqual([
      ["2026-12-01", null, 0, false, true],
      ["2026-10-27", "2026-11-30", 4, true, false],
      ["2026-10-01", "2026-10-26", 5, false, false],
    ]);
    expect(t[1]!.deltaOre).toBe(700);
    expect(t[1]!.deltaShare).toBeCloseTo(700 / 10_500);
    expect(t[2]!.deltaOre).toBeNull();
  });

  it("andelarna av tidslinjen summerar till 1", () => {
    const t = priceTimeline(priceHistory(prices, "t"), days, "2026-11-02");
    const shares = timelineShares(t, "2026-11-02");
    expect(shares.reduce((a, b) => a + b, 0)).toBeCloseTo(1);
    expect(shares[1]!).toBeGreaterThan(shares[2]!); // 35 dagar mot 26
  });
});

describe("priceLog", () => {
  const ev = (over: Partial<PriceAuditEvent>): PriceAuditEvent => ({
    id: "e",
    rowId: "r1",
    action: "insert",
    actorId: "u1",
    occurredAt: "2026-11-01T10:00:00.000Z",
    before: null,
    after: null,
    ...over,
  });

  it("före = priset som gällde datumet innan ändringen, senaste först", () => {
    const log = priceLog(
      [
        ev({
          id: "1",
          rowId: "r1",
          after: { unitCostOre: 10_500, validFrom: "2026-10-01", note: null },
        }),
        ev({
          id: "2",
          rowId: "r2",
          occurredAt: "2026-11-02T08:00:00.000Z",
          after: { unitCostOre: 11_200, validFrom: "2026-10-27", note: "Ny leverans" },
        }),
        ev({
          id: "3",
          rowId: "r2",
          action: "update",
          actorId: null,
          occurredAt: "2026-11-02T09:00:00.000Z",
          before: { unitCostOre: 11_200, validFrom: "2026-10-27", note: null },
          after: { unitCostOre: 11_000, validFrom: "2026-10-27", note: null },
        }),
      ],
      { u1: "Ägare" },
    );
    expect(log.map((e) => [e.id, e.kind, e.actor, e.beforeOre, e.afterOre])).toEqual([
      ["3", "Ändrat pris", "Systemet", 11_200, 11_000],
      ["2", "Nytt pris", "Ägare", 10_500, 11_200],
      ["1", "Nytt pris", "Ägare", null, 10_500],
    ]);
  });

  it("samma tidpunkt: äldsta giltig från räknas först", () => {
    const log = priceLog(
      [
        ev({
          id: "b",
          rowId: "r2",
          after: { unitCostOre: 11_200, validFrom: "2026-10-27", note: null },
        }),
        ev({
          id: "a",
          rowId: "r1",
          after: { unitCostOre: 10_500, validFrom: "2026-10-01", note: null },
        }),
      ],
      {},
    );
    expect(log.map((e) => [e.id, e.beforeOre])).toEqual([
      ["b", 10_500],
      ["a", null],
    ]);
  });

  it("namn: borttagen användare och systemet", () => {
    expect(actorName(null, {})).toBe("Systemet");
    expect(actorName("x", {})).toBe("Borttagen användare");
  });
});

describe("previewPrice", () => {
  const prices = [
    { unitCostOre: 10_000, validFrom: "2026-10-01" },
    { unitCostOre: 12_000, validFrom: "2026-10-20" },
  ];
  const orderDays = [
    { date: "2026-09-30", orders: 1 },
    { date: "2026-10-05", orders: 2 },
    { date: "2026-10-25", orders: 3 },
  ];

  it("påverkan räknas med priceChangeImpact: order, ändring i inköp och sista dag", () => {
    const p = previewPrice({
      titleId: "t",
      prices,
      orderDays,
      unitCostOre: 11_000,
      validFrom: "2026-10-03",
      closedMonths: [],
    });
    expect(p).toMatchObject({
      replaces: null,
      affectedOrders: 2,
      firstDate: "2026-10-05",
      costDeltaOre: 2_000,
      validTo: "2026-10-19",
      closedMonths: [],
    });
  });

  it("samma datum ersätter, order utan pris får pris, stängd månad rapporteras", () => {
    const p = previewPrice({
      titleId: "t",
      prices,
      orderDays,
      unitCostOre: 9_000,
      validFrom: "2026-09-15",
      closedMonths: ["2026-09"],
    });
    expect(p.ordersGainingPrice).toBe(1);
    expect(p.closedMonths).toEqual(["2026-09"]);
    expect(
      previewPrice({
        titleId: "t",
        prices,
        orderDays,
        unitCostOre: 1,
        validFrom: "2026-10-01",
        closedMonths: [],
      }).replaces,
    ).toEqual({ unitCostOre: 10_000, validFrom: "2026-10-01" });
  });

  it("order som fortfarande saknar pris efter ändringen", () => {
    const base = { titleId: "t", prices, orderDays, unitCostOre: 9_000, closedMonths: [] };
    expect(previewPrice({ ...base, validFrom: "2026-11-02" }).stillUnpriced).toEqual({
      orders: 1,
      firstDate: "2026-09-30",
      lastDate: "2026-09-30",
    });
    expect(previewPrice({ ...base, validFrom: "2026-09-30" }).stillUnpriced).toBeNull();
  });
});

describe("suggestedValidFrom", () => {
  const orderDays = [
    { date: "2026-08-30", orders: 1 },
    { date: "2026-09-02", orders: 2 },
    { date: "2026-10-05", orders: 3 },
  ];

  it("första dagen med order utan pris, annars i dag", () => {
    expect(suggestedValidFrom([], orderDays, [], "2026-11-02")).toBe("2026-08-30");
    expect(suggestedValidFrom([{ validFrom: "2026-08-01" }], orderDays, [], "2026-11-02")).toBe(
      "2026-11-02",
    );
  });

  it("hoppar över dagar där priset skulle gälla i en stängd månad", () => {
    expect(
      suggestedValidFrom([{ validFrom: "2026-10-01" }], orderDays, ["2026-08"], "2026-11-02"),
    ).toBe("2026-09-02");
    expect(suggestedValidFrom([], orderDays, ["2026-10"], "2026-11-02")).toBe("2026-11-02");
  });
});

import { describe, expect, it } from "vitest";
import { storeCompensation, monthPeriod } from "@/domain";
import { assertStoreReportSafe, buildStoreReport, type StoreReport } from "./store-report";
import { NO_TAX, VAT_25, agreement, ord, placement, price, sources } from "./testing/fixtures";

const NBSP = " ";
const plain = (s: string) => s.replace(/\u00a0/g, " ");

function compensationFromDomain(src: ReturnType<typeof sources>, storeId: string, month: string) {
  const r = storeCompensation({ ...src, period: monthPeriod(month) });
  return (
    r.stores.find((s) => s.storeId === storeId) ?? { commissionOre: 0, rentOre: 0, totalOre: 0 }
  );
}

describe("butiksersättning", () => {
  it("bara provision: 10 % av 30 400 kr = 3 040 kr, samma som beräkningslagret", () => {
    const src = sources({
      orders: [
        ...Array.from({ length: 5 }, (_, i) => ord(`2026-11-0${i + 1}`)),
        ord("2026-11-20", { amountOre: 5900 }),
      ],
      agreements: [agreement("s-1", "2026-01-01", null, { commissionBp: 1000 })],
    });
    const r = buildStoreReport(src, "s-1", "2026-11");
    expect(r.compensation.model).toBe("commission");
    expect(plain(r.compensation.modelText)).toBe("Provision 10 % på försäljningen exkl. moms.");
    expect(r.compensation.commissionOre).toBe(3040);
    expect(r.compensation.rentOre).toBe(0);
    expect(r.compensation.totalOre).toBe(3040);
    expect(r.compensation.steps.map((s) => s.kind)).toEqual(["commission", "total"]);
    expect(plain(r.compensation.steps[0]!.calculation)).toBe(
      "10 % av 304,00 kr exkl. moms (6 order) = 30,40 kr",
    );
    const d = compensationFromDomain(src, "s-1", "2026-11");
    expect(r.compensation.totalOre).toBe(d.totalOre);
  });

  it("bara hyra, hela månaden: exakt månadshyran", () => {
    const src = sources({
      orders: [ord("2026-11-03")],
      agreements: [agreement("s-1", "2026-01-01", null, { monthlyRentOre: 100_000 })],
    });
    const r = buildStoreReport(src, "s-1", "2026-11");
    expect(r.compensation.model).toBe("rent");
    expect(r.compensation.rentOre).toBe(100_000);
    expect(r.compensation.commissionOre).toBe(0);
    const rent = r.compensation.steps.find((s) => s.kind === "rent")!;
    expect(rent.label).toBe("Hyra");
    expect(plain(rent.calculation)).toBe("1 000,00 kr per månad, hela månaden = 1 000,00 kr");
    expect(r.compensation.totalOre).toBe(compensationFromDomain(src, "s-1", "2026-11").totalOre);
  });

  it("provision och hyra: summan av stegen = ersättningen", () => {
    const src = sources({
      orders: [ord("2026-11-03"), ord("2026-11-04", { amountOre: 5900 })],
      agreements: [
        agreement("s-1", "2026-01-01", null, { commissionBp: 1000, monthlyRentOre: 6200 }),
      ],
    });
    const r = buildStoreReport(src, "s-1", "2026-11");
    expect(r.compensation.model).toBe("commission_and_rent");
    expect(r.compensation.commissionOre).toBe(490 + 590);
    expect(r.compensation.rentOre).toBe(6200);
    const total = r.compensation.steps.find((s) => s.kind === "total")!;
    expect(total.amountOre).toBe(1080 + 6200);
    expect(plain(total.calculation)).toBe("Provision 10,80 kr + hyra 62,00 kr = 72,80 kr");
    const partsSum = r.compensation.steps
      .filter((s) => s.kind !== "total")
      .reduce((s, x) => s + x.amountOre, 0);
    expect(partsSum).toBe(total.amountOre);
    expect(r.compensation.totalOre).toBe(compensationFromDomain(src, "s-1", "2026-11").totalOre);
  });

  it("delmånad: hyra per dag (10–20 nov., 11 av 30 dagar = 366,67 kr) och ingen provision före avtalet", () => {
    const src = sources({
      orders: [ord("2026-11-05"), ord("2026-11-12"), ord("2026-11-25")],
      agreements: [
        agreement("s-1", "2026-11-10", "2026-11-20", {
          commissionBp: 1000,
          monthlyRentOre: 100_000,
        }),
      ],
    });
    const r = buildStoreReport(src, "s-1", "2026-11");
    expect(r.compensation.rentOre).toBe(36_667);
    expect(r.compensation.commissionOre).toBe(490);
    const rent = r.compensation.steps.find((s) => s.kind === "rent")!;
    expect(rent.label).toBe("Hyra (delmånad)");
    expect(plain(rent.calculation)).toBe(
      "1 000,00 kr per månad × 11 av 30 dagar (10–20 nov. 2026) = 366,67 kr",
    );
    // Dagar utan avtal: 1–9 nov. och 21–30 nov., ett steg per sammanhängande följd.
    const none = r.compensation.steps.filter((s) => s.kind === "no_agreement");
    expect(none.map((s) => [plain(s.label), s.amountOre, s.evidence.orderCount])).toEqual([
      ["Order utan avtal (1–9 nov. 2026)", 0, 1],
      ["Order utan avtal (21–30 nov. 2026)", 0, 1],
    ]);
    expect(none.map((s) => s.evidence.scope.period)).toEqual([
      { start: "2026-11-01", end: "2026-11-09" },
      { start: "2026-11-21", end: "2026-11-30" },
    ]);
    expect(none.map((s) => s.evidence.dates)).toEqual([["2026-11-05"], ["2026-11-25"]]);
    expect(r.compensation.modelText).toContain("(10–20 nov. 2026)");
    expect(r.compensation.totalOre).toBe(compensationFromDomain(src, "s-1", "2026-11").totalOre);
  });

  it("avtalsbyte mitt i månaden: hyrorna vägs efter dagar och avrundas en gång, provisionen per avtal", () => {
    const src = sources({
      orders: [ord("2026-11-02"), ord("2026-11-20")],
      agreements: [
        agreement("s-1", "2026-01-01", "2026-11-15", {
          commissionBp: 1000,
          monthlyRentOre: 3_000_000,
        }),
        agreement("s-1", "2026-11-16", null, { commissionBp: 1200, monthlyRentOre: 4_500_000 }),
      ],
    });
    const r = buildStoreReport(src, "s-1", "2026-11");
    expect(r.compensation.rentOre).toBe(3_750_000);
    expect(r.compensation.rentParts).toHaveLength(2);
    const commission = r.compensation.steps.filter((s) => s.kind === "commission");
    expect(commission.map((s) => s.amountOre)).toEqual([490, 588]);
    expect(plain(commission[1]!.label)).toBe("Provision 12 % (16–30 nov. 2026)");
    const rent = r.compensation.steps.find((s) => s.kind === "rent")!;
    expect(plain(rent.calculation)).toBe(
      "(30 000,00 kr × 15 dagar + 45 000,00 kr × 15 dagar) / 30 dagar = 37 500,00 kr",
    );
    expect(r.compensation.totalOre).toBe(compensationFromDomain(src, "s-1", "2026-11").totalOre);
  });

  it("provision avrundas per order och uträkningen säger det när det skiljer", () => {
    const src = sources({
      orders: [ord("2026-11-02", { amountOre: 4905 }), ord("2026-11-03", { amountOre: 4905 })],
      agreements: [agreement("s-1", "2026-01-01", null, { commissionBp: 1000 })],
    });
    const r = buildStoreReport(src, "s-1", "2026-11");
    // 490,5 → 491 per order, 982 öre; 10 % av 9 810 öre = 981.
    expect(r.compensation.commissionOre).toBe(982);
    expect(r.compensation.steps[0]!.calculation).toContain("avrundat per order");
  });

  it("moms 25 %: provisionen räknas på belopp exkl. moms", () => {
    const src = sources({
      settings: VAT_25,
      orders: [ord("2026-11-02")],
      agreements: [agreement("s-1", "2026-01-01", null, { commissionBp: 1000 })],
    });
    const r = buildStoreReport(src, "s-1", "2026-11");
    expect(r.sales.grossOre).toBe(4900);
    expect(r.sales.vatOre).toBe(980);
    expect(r.sales.revenueOre).toBe(3920);
    expect(r.compensation.commissionOre).toBe(392);
  });

  it("inget avtal: modellen är 'none' och ersättningen 0", () => {
    const r = buildStoreReport(sources({ orders: [ord("2026-11-02")] }), "s-1", "2026-11");
    expect(r.compensation.model).toBe("none");
    expect(r.compensation.totalOre).toBe(0);
    expect(r.compensation.modelText).toBe("Inget avtal gällde under månaden.");
  });
});

describe("butiksersättning: stegens underlag förklarar hela intäkten", () => {
  const baseOf = (r: StoreReport): number =>
    r.compensation.steps
      .filter(
        (s) => s.kind === "commission" || s.kind === "no_commission" || s.kind === "no_agreement",
      )
      .reduce((sum, s) => sum + s.evidence.figures[0]!.value, 0);

  it("order under ett avtal med bara hyra blir ett eget steg med 0 kr", () => {
    const src = sources({
      orders: [ord("2026-11-05"), ord("2026-11-05"), ord("2026-11-20", { amountOre: 5900 })],
      agreements: [
        agreement("s-1", "2026-01-01", "2026-11-15", { monthlyRentOre: 300_000 }),
        agreement("s-1", "2026-11-16", null, { commissionBp: 1000, monthlyRentOre: 300_000 }),
      ],
    });
    const r = buildStoreReport(src, "s-1", "2026-11");
    expect(r.compensation.steps.map((s) => [s.kind, s.amountOre])).toEqual([
      ["no_commission", 0],
      ["commission", 590],
      ["rent", 300_000],
      ["total", 300_590],
    ]);
    const step = r.compensation.steps[0]!;
    expect(plain(step.label)).toBe("Avtal utan provision (1–15 nov. 2026)");
    expect(plain(step.calculation)).toBe(
      "2 order (98,00 kr exkl. moms) såldes när avtalet bara hade hyra och ger ingen provision",
    );
    expect(step.evidence.orderCount).toBe(2);
    expect(step.evidence.dates).toEqual(["2026-11-05"]);
    expect(baseOf(r)).toBe(r.sales.revenueOre);
    expect(r.compensation.totalOre).toBe(compensationFromDomain(src, "s-1", "2026-11").totalOre);
  });

  it("avtal med bara hyra och inga order ger inget provisionssteg", () => {
    const src = sources({
      agreements: [agreement("s-1", "2026-01-01", null, { monthlyRentOre: 300_000 })],
    });
    const r = buildStoreReport(src, "s-1", "2026-11");
    expect(r.compensation.steps.map((s) => s.kind)).toEqual(["rent", "total"]);
  });

  it("underlaget summerar till intäkten med provision, bara hyra och dagar utan avtal (moms 25 %)", () => {
    const src = sources({
      settings: VAT_25,
      orders: [
        ord("2026-11-01"),
        ord("2026-11-04"),
        ord("2026-11-12"),
        ord("2026-11-18"),
        ord("2026-11-28", { amountOre: 5900 }),
      ],
      agreements: [
        agreement("s-1", "2026-11-03", "2026-11-10", { commissionBp: 1200 }),
        agreement("s-1", "2026-11-11", "2026-11-15", { monthlyRentOre: 150_000 }),
        agreement("s-1", "2026-11-20", null, { commissionBp: 1000 }),
      ],
    });
    const r = buildStoreReport(src, "s-1", "2026-11");
    expect(r.compensation.steps.map((s) => s.kind)).toEqual([
      "commission",
      "no_commission",
      "commission",
      "no_agreement",
      "no_agreement",
      "rent",
      "total",
    ]);
    expect(
      r.compensation.steps
        .filter((s) => s.kind === "no_agreement")
        .map((s) => s.evidence.scope.period),
    ).toEqual([
      { start: "2026-11-01", end: "2026-11-02" },
      { start: "2026-11-16", end: "2026-11-19" },
    ]);
    expect(baseOf(r)).toBe(r.sales.revenueOre);
    expect(r.compensation.totalOre).toBe(compensationFromDomain(src, "s-1", "2026-11").totalOre);
  });
});

describe("försäljning, veckor och titlar", () => {
  it("bara order från automater som stod i butiken den dagen räknas", () => {
    const src = sources({
      orders: [
        ord("2026-11-10", { machineId: "m-3", amountOre: 1000 }),
        ord("2026-11-20", { machineId: "m-3", amountOre: 2000 }),
        ord("2026-11-20", { machineId: null, amountOre: 3000 }),
      ],
      placements: [
        placement("m-1", "s-1", "2025-01-01", null),
        placement("m-3", "s-2", "2026-01-01", "2026-11-15"),
        placement("m-3", "s-1", "2026-11-16", null),
      ],
    });
    const r = buildStoreReport(src, "s-1", "2026-11");
    expect(r.sales.orders).toBe(1);
    expect(r.sales.revenueOre).toBe(2000);
    const m3 = r.machines.find((m) => m.machineId === "m-3")!;
    expect(m3.placedDays).toBe(15);
    expect(m3.orders).toBe(1);
    // m-1 stod i butiken hela månaden men sålde inget: den syns ändå.
    expect(r.machines.find((m) => m.machineId === "m-1")!.placedDays).toBe(30);
  });

  it("veckor: ISO-veckor, delvisa i kanterna, summan = månaden", () => {
    const src = sources({
      orders: [ord("2026-11-01"), ord("2026-11-02"), ord("2026-11-30", { amountOre: 5900 })],
    });
    const r = buildStoreReport(src, "s-1", "2026-11");
    expect(r.weeks.map((w) => w.key)).toEqual([
      "2026-W44",
      "2026-W45",
      "2026-W46",
      "2026-W47",
      "2026-W48",
      "2026-W49",
    ]);
    expect(r.weeks[0]!.partial).toBe(true);
    expect(r.weeks[0]!.label).toBe(`v.${NBSP}44 (1 nov.)`);
    expect(r.weeks[1]!.label).toBe(`v.${NBSP}45 (2–8 nov.)`);
    expect(r.weeks[1]!.partial).toBe(false);
    expect(r.weeks[5]!.partial).toBe(true);
    expect(r.weeks.reduce((s, w) => s + w.revenueOre, 0)).toBe(r.sales.revenueOre);
    expect(r.weeks.reduce((s, w) => s + w.orders, 0)).toBe(3);
  });

  it("topptitlar: intäkt, sedan antal, sedan namn; andel i bp; begränsat antal", () => {
    const src = sources({
      orders: [
        ord("2026-11-02", { titleId: "t-a", amountOre: 5000 }),
        ord("2026-11-02", { titleId: "t-b", amountOre: 2500 }),
        ord("2026-11-03", { titleId: "t-b", amountOre: 2500 }),
        ord("2026-11-03", { titleId: "t-c", amountOre: 5000 }),
      ],
    });
    const r = buildStoreReport(src, "s-1", "2026-11", { topTitles: 2 });
    expect(r.topTitles.map((t) => t.name)).toEqual(["Prismatic Evolutions", "30th Celebration"]);
    expect(r.topTitles[0]!.shareBp).toBe(3333);
    expect(r.topTitles[0]!.evidence.scope).toEqual({
      period: monthPeriod("2026-11"),
      storeId: "s-1",
      titleId: "t-b",
    });
  });

  it("snittorder avrundas och saknas utan order", () => {
    const r = buildStoreReport(
      sources({
        orders: [ord("2026-11-02", { amountOre: 101 }), ord("2026-11-02", { amountOre: 100 })],
      }),
      "s-1",
      "2026-11",
    );
    expect(r.sales.averageOrderOre).toBe(101);
    expect(buildStoreReport(sources(), "s-1", "2026-11").sales.averageOrderOre).toBeNull();
  });
});

describe("jämförelse och slutsats", () => {
  const withMonths = (oct: number[], nov: number[]) =>
    sources({
      orders: [
        ...oct.map((a, i) => ord(`2026-10-${String(i + 1).padStart(2, "0")}`, { amountOre: a })),
        ...nov.map((a, i) =>
          ord(`2026-11-${String(i + 1).padStart(2, "0")}`, {
            amountOre: a,
            titleId: i === 0 ? "t-a" : "t-b",
          }),
        ),
      ],
    });

  it("ökning: procent, nytt belopp och den mest sålda titelns andel", () => {
    const r = buildStoreReport(withMonths([10_000], [9_000, 2_000]), "s-1", "2026-11");
    expect(r.comparison.revenueChangeBp).toBe(1000);
    expect(r.comparison.ordersDiff).toBe(1);
    expect(r.conclusion.ruleId).toBe("store.up");
    expect(plain(r.conclusion.text)).toBe(
      "Försäljningen ökade 10 % till 110 kr jämfört med oktober, och 30th Celebration stod för 82 % av intäkten.",
    );
    expect(r.conclusion.evidence.titleIds).toEqual(["t-a"]);
  });

  it("minskning", () => {
    const r = buildStoreReport(withMonths([20_000], [10_000]), "s-1", "2026-11");
    expect(r.conclusion.ruleId).toBe("store.down");
    expect(plain(r.conclusion.text)).toBe(
      "Försäljningen minskade 50 % till 100 kr jämfört med oktober.",
    );
  });

  it("i nivå: förändring under 2 %", () => {
    const r = buildStoreReport(withMonths([10_000], [10_100]), "s-1", "2026-11");
    expect(r.conclusion.ruleId).toBe("store.flat");
    expect(plain(r.conclusion.text)).toBe(
      "Försäljningen låg i nivå med oktober: 101 kr på 1 order.",
    );
  });

  it("ingen försäljning förra månaden", () => {
    const r = buildStoreReport(withMonths([], [10_000]), "s-1", "2026-11");
    expect(r.comparison.revenueChangeBp).toBeNull();
    expect(r.comparison.text).toBe("Ingen försäljning i oktober att jämföra med.");
    expect(r.conclusion.ruleId).toBe("store.first");
  });

  it("ingen försäljning alls, men hyra", () => {
    const r = buildStoreReport(
      sources({ agreements: [agreement("s-1", "2026-01-01", null, { monthlyRentOre: 50_000 })] }),
      "s-1",
      "2026-11",
    );
    expect(r.conclusion.ruleId).toBe("store.no_sales");
    expect(plain(r.conclusion.text)).toBe(
      "Ingen försäljning i november 2026; ersättningen blir 500 kr.",
    );
  });

  it("januari jämförs med december föregående år", () => {
    const src = sources({
      orders: [ord("2025-12-10", { amountOre: 1000 }), ord("2026-01-10", { amountOre: 2000 })],
    });
    const r = buildStoreReport(src, "s-1", "2026-01");
    expect(r.comparison.month).toBe("2025-12");
    expect(r.conclusion.text).toContain("jämfört med december 2025");
  });

  it("hälsning och okänd butik", () => {
    expect(
      buildStoreReport(sources(), "s-1", "2026-11", { greeting: "Tack för ett bra samarbete!" })
        .greeting,
    ).toBe("Tack för ett bra samarbete!");
    expect(() => buildStoreReport(sources(), "s-okänd", "2026-11")).toThrow(/okänd/);
  });
});

describe("sekretess: butiksrapporten innehåller aldrig inköp, marginal, vinst eller andra butiker", () => {
  // Distinkta tal så att de syns om de läcker: inköpspris 135,79 kr, andra butikens order 77,77 kr.
  const src = sources({
    orders: [
      ord("2026-11-02", { titleId: "t-a", amountOre: 4900 }),
      ord("2026-11-03", { titleId: "t-b", amountOre: 5900 }),
      ord("2026-11-04", { titleId: "t-c", amountOre: 6900 }),
      ord("2026-10-04", { titleId: "t-a", amountOre: 4900 }),
      ord("2026-11-05", { machineId: "m-2", amountOre: 7777 }),
      ord("2026-11-06", { machineId: "m-2", amountOre: 7777 }),
    ],
    placements: [
      placement("m-1", "s-1", "2025-01-01", null),
      placement("m-2", "s-2", "2025-01-01", null),
    ],
    prices: [price("t-a", 13_579, "2025-01-01"), price("t-b", 2_468, "2025-01-01")],
    agreements: [
      agreement("s-1", "2025-01-01", null, { commissionBp: 1000, monthlyRentOre: 30_000 }),
      agreement("s-2", "2025-01-01", null, { commissionBp: 1500, monthlyRentOre: 91_919 }),
    ],
  });
  const report = buildStoreReport(src, "s-1", "2026-11");
  const json = JSON.stringify(report);

  function keys(value: unknown, out: string[] = []): string[] {
    if (Array.isArray(value)) value.forEach((v) => keys(v, out));
    else if (value && typeof value === "object") {
      for (const [k, v] of Object.entries(value)) {
        out.push(k);
        keys(v, out);
      }
    }
    return out;
  }

  it("inga fält för inköp, marginal, vinst eller saknade priser, inte heller nästlat", () => {
    const all = keys(JSON.parse(json));
    expect(all.length).toBeGreaterThan(50);
    for (const k of all)
      expect(k).not.toMatch(/cost|margin|profit|unpriced|purchase|inkop|inköp|vinst|marginal/i);
  });

  it("inga ord om inköp, vinst eller marginal i texterna", () => {
    expect(json).not.toMatch(/inköp|vinst|marginal|lönsam/i);
  });

  it("inga inköpsbelopp", () => {
    // 135,79 kr per pack (13579 öre) och 24,68 kr (2468 öre) och summan 16 047 öre.
    for (const needle of ["13579", "135,79", "2468", "24,68", "16047", "160,47"]) {
      expect(json).not.toContain(needle);
    }
  });

  it("inga andra butikers namn, id, belopp eller avtal", () => {
    for (const needle of [
      "Mobilia",
      "Väla",
      '"s-2"',
      '"s-3"',
      "m-2",
      "7777",
      "77,77",
      "15554",
      "91919",
      "919,19",
      "1500",
    ]) {
      expect(json).not.toContain(needle);
    }
    const storeIds = json.match(/"storeId":"[^"]*"/g) ?? [];
    expect(storeIds.length).toBeGreaterThan(5);
    for (const s of storeIds) expect(s).toBe('"storeId":"s-1"');
  });

  it("butikens egna siffror finns med", () => {
    expect(report.sales.revenueOre).toBe(4900 + 5900 + 6900);
    expect(report.sales.orders).toBe(3);
    expect(report.compensation.totalOre).toBe(490 + 590 + 690 + 30_000);
  });

  it("assertStoreReportSafe stoppar ett nästlat inköpsfält och en annan butik", () => {
    const withCost = {
      ...report,
      weeks: [{ ...report.weeks[0]!, extra: { deep: [{ costOre: 1 }] } }],
    } as unknown as StoreReport;
    expect(() => assertStoreReportSafe(withCost)).toThrow(/costOre/);
    const other = {
      ...report,
      sales: {
        ...report.sales,
        evidence: {
          ...report.sales.evidence,
          scope: { ...report.sales.evidence.scope, storeId: "s-2" },
        },
      },
    } as StoreReport;
    expect(() => assertStoreReportSafe(other)).toThrow(/annan butik/);
    const text = {
      ...report,
      comparison: { ...report.comparison, text: "Vinsten blev 10 kr." },
    } as StoreReport;
    expect(() => assertStoreReportSafe(text)).toThrow(/otillåten text/);
  });

  it("namn som råkar innehålla ett förbjudet ord stoppar inte rapporten", () => {
    const named = sources({ ...src, stores: [{ id: "s-1", name: "Vinsta centrum" }] });
    expect(buildStoreReport(named, "s-1", "2026-11").store.name).toBe("Vinsta centrum");
  });

  it("en titel eller automat med 'vinst', 'inköp' eller 'marginal' i namnet stoppar inte rapporten", () => {
    const named = sources({
      ...src,
      titles: [
        { id: "t-a", name: "Vinstpaketet" },
        { id: "t-b", name: "Inköpsrea" },
        { id: "t-c", name: "Marginal Edition" },
      ],
      machines: [{ id: "m-1", name: "Vinstautomaten", code: "BL-001" }],
    });
    const r = buildStoreReport(named, "s-1", "2026-11");
    expect(r.topTitles.map((t) => t.name)).toContain("Vinstpaketet");
    // Namnen citeras i slutsatsen och underlagen utan att kontrollen slår till.
    expect(JSON.stringify(r)).toContain("Vinstautomaten");
    expect(() => assertStoreReportSafe(r)).not.toThrow();
    // Ordet utanför ett namn stoppas fortfarande, även när namnet står i samma text.
    const leaked = {
      ...r,
      conclusion: { ...r.conclusion, text: `${r.conclusion.text} Vinsten blev 10 kr.` },
    } as StoreReport;
    expect(() => assertStoreReportSafe(leaked)).toThrow(/otillåten text/);
  });

  it("ingen moms ändrar inget i sekretessen", () => {
    expect(buildStoreReport({ ...src, settings: NO_TAX }, "s-1", "2026-11").sales.vatOre).toBe(0);
  });
});

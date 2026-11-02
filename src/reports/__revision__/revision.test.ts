/**
 * Oberoende revision av rapportunderlagen (fas 6). Alla förväntade värden nedan är
 * handräknade (uträkningen står i kommentarerna) och jämförs mot rapportfunktionerna.
 * Körs även med TZ=UTC och TZ=Asia/Shanghai:
 *   TZ=UTC npx vitest run -c src/reports/testing/vitest.tz.config.ts src/reports/__revision__
 */

import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { CALC_VERSION, keyMetrics, storeCompensation, type Period } from "@/domain";
import {
  assertStoreReportSafe,
  buildAccountantReport,
  buildAccountantWorkbook,
  buildPartnerReport,
  buildSie4Text,
  buildStoreReport,
  decodeCp437,
  exportSie4,
  KRONOR_FORMAT,
  type Evidence,
  type ReportSources,
  type StoreReport,
} from "../index";
import { agreement, NO_TAX, ord, placement, price } from "../testing/fixtures";

const N = " "; // hårt mellanslag (tusental, "kr", "%")
const M = "−"; // minustecken
const NOV: Period = { start: "2026-11-01", end: "2026-11-30" };

function base(p: Partial<ReportSources>): ReportSources {
  return {
    orders: [],
    prices: [],
    agreements: [],
    placements: [],
    settings: NO_TAX,
    stores: [
      { id: "s-1", name: "Nordstan" },
      { id: "s-2", name: "Mobilia" },
      { id: "s-3", name: "Väla" },
    ],
    machines: [
      { id: "m-1", name: "Automat 1", code: "BL-001" },
      { id: "m-2", name: "Automat 2", code: "BL-002" },
      { id: "m-3", name: "Automat 3", code: "BL-003" },
    ],
    titles: [
      { id: "t-a", name: "30th Celebration" },
      { id: "t-b", name: "Prismatic Evolutions" },
      { id: "t-c", name: "Surging Sparks" },
    ],
    ...p,
  };
}

/** Kontrollerar att varje underlag är komplett, rekursivt. Returnerar antalet underlag. */
function checkEvidence(value: unknown, path = "r"): number {
  let n = 0;
  if (Array.isArray(value)) {
    value.forEach((v, i) => (n += checkEvidence(v, `${path}[${i}]`)));
    return n;
  }
  if (value === null || typeof value !== "object") return 0;
  for (const [k, v] of Object.entries(value)) {
    if (k === "evidence") {
      const e = v as Evidence;
      expect(typeof e.rule, `${path}.evidence.rule`).toBe("string");
      expect(e.rule.length, `${path}.evidence.rule`).toBeGreaterThan(5);
      expect(e.scope.period.start <= e.scope.period.end, `${path}.evidence.scope`).toBe(true);
      expect(Number.isSafeInteger(e.orderCount), `${path}.evidence.orderCount`).toBe(true);
      for (const f of e.figures) {
        expect(Number.isSafeInteger(f.value), `${path}.evidence.figures ${f.label}`).toBe(true);
      }
      n++;
    } else n += checkEvidence(v, `${path}.${k}`);
  }
  return n;
}

// ---------------------------------------------------------------------------------------
// Scenario 1–3: butiksrapporten
// ---------------------------------------------------------------------------------------

/**
 * Nordstan (s-1): avtal A1 t.o.m. 9 nov. provision 10 %, avtal A2 från 10 nov. provision
 * 12 % + hyra 1 000 kr/mån. Automat 2 står i Mobilia (s-2) t.o.m. 14 nov., sedan i
 * Nordstan. Väla (s-3) har bara hyra 500 kr/mån och ingen försäljning.
 * Inköpspriser 17,77 och 33,33 kr (får aldrig synas i butiksrapporten).
 */
function storeSources(): ReportSources {
  return base({
    placements: [
      placement("m-1", "s-1", "2026-01-01", null),
      placement("m-2", "s-2", "2026-01-01", "2026-11-14"),
      placement("m-2", "s-1", "2026-11-15", null),
      placement("m-3", "s-3", "2026-01-01", null),
    ],
    agreements: [
      agreement("s-1", "2026-01-01", "2026-11-09", { commissionBp: 1000 }),
      agreement("s-1", "2026-11-10", null, { commissionBp: 1200, monthlyRentOre: 100_000 }),
      agreement("s-2", "2026-01-01", null, { commissionBp: 1500, monthlyRentOre: 77_700 }),
      agreement("s-3", "2026-01-01", null, { monthlyRentOre: 50_000 }),
    ],
    prices: [price("t-a", 1777, "2026-01-01"), price("t-b", 3333, "2026-01-01")],
    orders: [
      // Oktober: Nordstan 2 × 49 kr; Mobilia 99 kr.
      ord("2026-10-15", { id: "oct1", externalId: "201", machineId: "m-1" }),
      ord("2026-10-16", { id: "oct2", externalId: "202", machineId: "m-1" }),
      ord("2026-10-20", { id: "oct3", externalId: "203", machineId: "m-2", amountOre: 9900 }),
      // November, Nordstan.
      ord("2026-11-03", { id: "n1", externalId: "301", machineId: "m-1" }),
      ord("2026-11-09", {
        id: "n2",
        externalId: "302",
        machineId: "m-1",
        titleId: "t-b",
        amountOre: 5900,
      }),
      ord("2026-11-10", { id: "n3", externalId: "303", machineId: "m-1" }),
      ord("2026-11-20", { id: "n4", externalId: "304", machineId: "m-1", amountOre: 1205 }),
      ord("2026-11-30", { id: "n5", externalId: "305", machineId: "m-1", amountOre: 1205 }),
      // November, Mobilia (automat 2 före flytten, sista dagen i Mobilia är 14 nov.).
      ord("2026-11-05", { id: "x1", externalId: "306", machineId: "m-2", amountOre: 9900 }),
      ord("2026-11-14", {
        id: "x2",
        externalId: "307",
        machineId: "m-2",
        titleId: "t-b",
        amountOre: 9900,
      }),
    ],
  });
}

describe("Revision scenario 1: butiksrapport med provision, avtalsbyte, delmånadshyra och flytt", () => {
  const r = buildStoreReport(storeSources(), "s-1", "2026-11", { greeting: "Tack!" });

  it("försäljning: 4 900 + 5 900 + 4 900 + 1 205 + 1 205 = 18 110 öre på 5 order", () => {
    expect(r.sales.revenueOre).toBe(18_110);
    expect(r.sales.grossOre).toBe(18_110);
    expect(r.sales.vatOre).toBe(0);
    expect(r.sales.orders).toBe(5);
    expect(r.sales.averageOrderOre).toBe(3622); // round(18 110 / 5)
    expect(r.greeting).toBe("Tack!");
    expect(r.sales.evidence.orderCount).toBe(5);
    expect(r.sales.evidence.scope).toEqual({ period: NOV, storeId: "s-1" });
  });

  it("jämförelse: oktober 9 800 öre → round(8 310 × 10 000 / 9 800) = 8 480 bp", () => {
    expect(r.comparison.month).toBe("2026-10");
    expect(r.comparison.revenueOre).toBe(9800);
    expect(r.comparison.orders).toBe(2);
    expect(r.comparison.revenueChangeBp).toBe(8480);
    expect(r.comparison.ordersDiff).toBe(3);
    expect(r.comparison.text).toBe(`+85${N}% mot oktober (98${N}kr på 2${N}order).`);
  });

  it("veckor: v. 44 (1 nov.) … v. 49 (30 nov.), delvisa i kanterna", () => {
    expect(r.weeks.map((w) => [w.week, w.partial, w.orders, w.revenueOre])).toEqual([
      [44, true, 0, 0],
      [45, false, 1, 4900],
      [46, false, 2, 10_800],
      [47, false, 1, 1205],
      [48, false, 0, 0],
      [49, true, 1, 1205],
    ]);
    expect(r.weeks[1]!.label).toBe(`v.${N}45 (2–8 nov.)`);
    expect(r.weeks.reduce((s, w) => s + w.revenueOre, 0)).toBe(r.sales.revenueOre);
  });

  it("topptitlar: 30th Celebration 12 210 öre = 6 742 bp, Prismatic 5 900 = 3 258 bp", () => {
    expect(r.topTitles.map((t) => [t.titleId, t.orders, t.revenueOre, t.shareBp])).toEqual([
      ["t-a", 4, 12_210, 6742],
      ["t-b", 1, 5900, 3258],
    ]);
  });

  it("automater: automat 2 stod i butiken 15–30 nov. (16 dagar) utan försäljning", () => {
    expect(r.machines.map((m) => [m.machineId, m.placedDays, m.orders, m.revenueOre])).toEqual([
      ["m-1", 30, 5, 18_110],
      ["m-2", 16, 0, 0],
    ]);
  });

  it("ersättning steg för steg: 1 080 + 878 + 70 000 = 71 958 öre", () => {
    const c = r.compensation;
    expect(c.model).toBe("commission_and_rent");
    // A1: 490 + 590 = 1 080 (underlag 10 800). A2: 588 + 145 + 145 = 878 (underlag 7 310;
    // 12 % av summan vore 877,2 → 877, så avrundningen per order ska nämnas).
    // Hyra: round(100 000 × 21 / 30) = 70 000.
    expect(c.steps.map((s) => [s.kind, s.amountOre])).toEqual([
      ["commission", 1080],
      ["commission", 878],
      ["rent", 70_000],
      ["total", 71_958],
    ]);
    expect(c.steps[0]!.label).toBe(`Provision 10${N}% (1–9 nov. 2026)`);
    expect(c.steps[0]!.calculation).toBe(
      `10${N}% av 108,00${N}kr exkl. moms (2${N}order) = 10,80${N}kr`,
    );
    expect(c.steps[1]!.calculation).toBe(
      `12${N}% av 73,10${N}kr exkl. moms (3${N}order) = 8,78${N}kr (avrundat per order; 12,0${N}% av summan vore 8,77${N}kr)`,
    );
    expect(c.steps[2]!.label).toBe("Hyra (delmånad)");
    expect(c.steps[2]!.calculation).toBe(
      `1${N}000,00${N}kr per månad × 21 av 30 dagar (10–30 nov. 2026) = 700,00${N}kr`,
    );
    expect(c.steps[3]!.calculation).toBe(
      `Provision 19,58${N}kr + hyra 700,00${N}kr = 719,58${N}kr`,
    );
    expect([c.commissionOre, c.rentOre, c.totalOre]).toEqual([1958, 70_000, 71_958]);
    expect(c.rentParts).toEqual([
      { monthlyRentOre: 100_000, start: "2026-11-10", end: "2026-11-30", days: 21 },
    ]);
    // Samma tal som beräkningslagret.
    const dom = storeCompensation({ ...storeSources(), period: NOV });
    expect(dom.stores.find((s) => s.storeId === "s-1")!.totalOre).toBe(71_958);
    expect(c.steps[1]!.evidence.figures).toEqual([
      { label: "Underlag exkl. moms", value: 7310, unit: "ore" },
      { label: "Provisionssats", value: 1200, unit: "bp" },
      { label: "Provision", value: 878, unit: "ore" },
    ]);
  });

  it("slutsats i en mening med siffror", () => {
    expect(r.conclusion.ruleId).toBe("store.up");
    expect(r.conclusion.text).toBe(
      `Försäljningen ökade 85${N}% till 181,10${N}kr jämfört med oktober, och 30th Celebration stod för 67${N}% av intäkten.`,
    );
    expect(r.conclusion.evidence.titleIds).toEqual(["t-a"]);
  });

  it("sekretess: serialiserat innehåller inga inköp, vinster eller andra butiker", () => {
    const json = JSON.stringify(r);
    for (const bad of [
      "Mobilia",
      "s-2",
      "s-3",
      "Väla",
      "9900",
      "99,00",
      "19800",
      "777", // inköpspris 1 777, hyra Mobilia 77 700
      "17,77",
      "3333",
      "33,33",
      "10441", // butikens inköp 4 × 1 777 + 3 333
      "7108",
      `15${N}%`, // Mobilias provision
      "cost",
      "margin",
      "profit",
      "unpriced",
      "nköp",
      "inst",
      "arginal",
    ]) {
      expect(json.includes(bad), `innehåller "${bad}"`).toBe(false);
    }
    expect(() =>
      assertStoreReportSafe({
        ...r,
        sales: { ...r.sales, evidence: { ...r.sales.evidence, figures: [] } },
        weeks: [{ ...r.weeks[0]!, deep: { nested: { marginBp: 1 } } } as never],
      } as StoreReport),
    ).toThrow();
    expect(() =>
      assertStoreReportSafe({
        ...r,
        comparison: {
          ...r.comparison,
          evidence: { ...r.comparison.evidence, scope: { period: NOV, storeId: "s-2" } },
        },
      }),
    ).toThrow();
  });

  it("varje resultat har underlag", () => {
    expect(checkEvidence(r)).toBeGreaterThanOrEqual(
      1 +
        1 +
        1 +
        r.weeks.length +
        r.topTitles.length +
        r.machines.length +
        1 +
        r.compensation.steps.length,
    );
  });
});

describe("Revision scenario 2: butik med bara hyra och ingen försäljning", () => {
  const r = buildStoreReport(storeSources(), "s-3", "2026-11");

  it("ersättningen är hela månadshyran och slutsatsen säger det", () => {
    expect(r.sales.orders).toBe(0);
    expect(r.sales.averageOrderOre).toBeNull();
    expect(r.compensation.model).toBe("rent");
    expect(r.compensation.steps.map((s) => [s.kind, s.label, s.amountOre])).toEqual([
      ["rent", "Hyra", 50_000],
      ["total", "Ersättning totalt", 50_000],
    ]);
    expect(r.compensation.steps[0]!.calculation).toBe(
      `500,00${N}kr per månad, hela månaden = 500,00${N}kr`,
    );
    expect(r.comparison.revenueChangeBp).toBeNull();
    expect(r.conclusion.ruleId).toBe("store.no_sales");
    expect(r.conclusion.text).toBe(
      `Ingen försäljning i november 2026; ersättningen blir 500${N}kr.`,
    );
    expect(r.machines.map((m) => [m.machineId, m.placedDays, m.orders])).toEqual([["m-3", 30, 0]]);
    expect(r.topTitles).toEqual([]);
    const json = JSON.stringify(r);
    for (const bad of ["Nordstan", "Mobilia", "s-1", "s-2", "71958", "70000"])
      expect(json.includes(bad), bad).toBe(false);
  });

  it("okänd butik ger fel i stället för en tom rapport", () => {
    expect(() => buildStoreReport(storeSources(), "s-404", "2026-11")).toThrow();
  });
});

describe("Revision scenario 3: moms 25 %, order utan avtal och hyra vägd över två avtal", () => {
  // Mobilia: inget avtal 1–2 nov., B1 3–15 nov. hyra 30 000 kr/mån, B2 från 16 nov.
  // hyra 45 000 kr/mån + provision 5 %. Två order à 49 kr (inkl. 25 % moms).
  const src = base({
    settings: { vatRateBp: 2500, cardFeeBp: 0 },
    placements: [placement("m-2", "s-2", "2026-01-01", null)],
    agreements: [
      agreement("s-2", "2026-11-03", "2026-11-15", { monthlyRentOre: 3_000_000 }),
      agreement("s-2", "2026-11-16", null, { commissionBp: 500, monthlyRentOre: 4_500_000 }),
    ],
    orders: [
      ord("2026-11-02", { id: "p1", externalId: "1", machineId: "m-2" }),
      ord("2026-11-20", { id: "p2", externalId: "2", machineId: "m-2" }),
    ],
  });
  const r = buildStoreReport(src, "s-2", "2026-11");

  it("moms 4 900 × 2 500 / 12 500 = 980 per order; intäkt exkl. moms 7 840", () => {
    expect([r.sales.grossOre, r.sales.vatOre, r.sales.revenueOre]).toEqual([9800, 1960, 7840]);
  });

  it("provision på belopp exkl. moms: 5 % av 3 920 = 196; hyra (3 000 000 × 13 + 4 500 000 × 15) / 30 = 3 550 000", () => {
    const c = r.compensation;
    expect(c.steps.map((s) => [s.kind, s.amountOre])).toEqual([
      ["commission", 196],
      ["no_agreement", 0],
      ["rent", 3_550_000],
      ["total", 3_550_196],
    ]);
    expect(c.steps[1]!.evidence.dates).toEqual(["2026-11-02"]);
    expect(c.steps[1]!.evidence.orderCount).toBe(1);
    expect(c.steps[2]!.calculation).toBe(
      `(30${N}000,00${N}kr × 13 dagar + 45${N}000,00${N}kr × 15 dagar) / 30 dagar = 35${N}500,00${N}kr`,
    );
    expect(c.totalOre).toBe(
      storeCompensation({ ...src, period: NOV }).stores.find((s) => s.storeId === "s-2")!.totalOre,
    );
  });

  it("utan försäljning förra månaden: ingen jämförelse", () => {
    expect(r.conclusion.ruleId).toBe("store.first");
    expect(r.conclusion.text).toBe(
      `Försäljningen blev 78,40${N}kr på 2${N}order; i oktober fanns ingen försäljning att jämföra med.`,
    );
  });
});

describe("Revision scenario 7: gränsen för 'i nivå med' (2 %)", () => {
  const mk = (nov: number) =>
    buildStoreReport(
      base({
        placements: [placement("m-1", "s-1", "2026-01-01", null)],
        agreements: [agreement("s-1", "2026-01-01", null, { commissionBp: 1000 })],
        orders: [
          ord("2026-10-10", { id: "a", externalId: "1", amountOre: 10_000 }),
          ord("2026-11-10", { id: "b", externalId: "2", amountOre: nov }),
        ],
      }),
      "s-1",
      "2026-11",
    );

  it("+150 bp är i nivå med, +200 bp är en ökning", () => {
    const flat = mk(10_150);
    expect(flat.conclusion.ruleId).toBe("store.flat");
    expect(flat.conclusion.text).toBe(
      `Försäljningen låg i nivå med oktober: 101,50${N}kr på 1${N}order.`,
    );
    const up = mk(10_200);
    expect(up.conclusion.ruleId).toBe("store.up");
    expect(up.comparison.revenueChangeBp).toBe(200);
    const down = mk(9_799); // −201 bp
    expect(down.conclusion.ruleId).toBe("store.down");
    expect(down.conclusion.text).toBe(
      `Försäljningen minskade 2${N}% till 97,99${N}kr jämfört med oktober.`,
    );
  });
});

// ---------------------------------------------------------------------------------------
// Scenario 4: bokföringsrapporten, SIE 4 och Excel
// ---------------------------------------------------------------------------------------

/**
 * Moms 25 %, kortavgift 2,5 %. Nordstan: provision 10 % + hyra 62 kr. Väla: bara hyra
 * 500 kr, ingen försäljning. Automat 2 är inte placerad. Ordernummer 100 (31 okt.), 101,
 * 102, 104, 105 (1 dec.), 106, 110. Titel t-c saknar inköpspris.
 */
function accountantSources(): ReportSources {
  return base({
    settings: { vatRateBp: 2500, cardFeeBp: 250 },
    placements: [
      placement("m-1", "s-1", "2026-01-01", null),
      placement("m-3", "s-3", "2026-01-01", null),
    ],
    agreements: [
      agreement("s-1", "2026-01-01", null, { commissionBp: 1000, monthlyRentOre: 6200 }),
      agreement("s-3", "2026-01-01", null, { monthlyRentOre: 50_000 }),
    ],
    prices: [price("t-a", 2000, "2026-01-01")],
    orders: [
      ord("2026-10-31", { id: "e100", externalId: "100" }),
      ord("2026-11-01", { id: "e101", externalId: "101" }),
      ord("2026-11-01", { id: "e102", externalId: "102", amountOre: 5900 }),
      ord("2026-11-02", { id: "e104", externalId: "104", titleId: "t-c" }),
      ord("2026-12-01", { id: "e105", externalId: "105" }),
      ord("2026-11-15", { id: "e106", externalId: "106", machineId: "m-2", amountOre: 12_900 }),
      ord("2026-11-30", { id: "e110", externalId: "110", machineId: null }),
    ],
  });
}

const ACCOUNTS = [
  { key: "sales", account: "3001", name: "Försäljning" },
  { key: "vat_out", account: "2611", name: "Utgående moms 25 %" },
  { key: "settlement", account: "1580", name: "Avräkning kortinlösen" },
  { key: "card_fees", account: "6570", name: "Kortavgifter (entré)" },
  { key: "store_commission", account: "6090", name: "Provision Örebro" },
  { key: "rent", account: "5010", name: "Lokalhyra" },
  { key: "store_payable", account: "2440", name: "Skuld Ängelholm" },
  { key: "cogs", account: "4010", name: "Varuinköp" },
  { key: "inventory", account: "1460", name: "Lager Åre" },
];

describe("Revision scenario 4: bokföringsrapport med moms, avgifter, luckor och SIE/Excel", () => {
  const r = buildAccountantReport(accountantSources(), NOV);

  it("totaler: per order moms = belopp / 5, avgift = round(belopp × 2,5 %)", () => {
    // 4 900 → moms 980, netto 3 920, avgift 123 (122,5). 5 900 → 1 180, 4 720, 148 (147,5).
    // 12 900 → 2 580, 10 320, 323 (322,5). Fem order: 4 900 × 3 + 5 900 + 12 900 = 33 500.
    const t = r.totals;
    expect([t.orders, t.grossOre, t.vatOre, t.netOre, t.feesOre]).toEqual([
      5, 33_500, 6700, 26_800, 840,
    ]);
    // Inköp: fyra order av t-a à 20 kr; t-c saknar pris.
    expect([t.costOre, t.pricedOrders, t.unpricedOrders, t.unpricedNetOre]).toEqual([
      8000, 4, 1, 3920,
    ]);
    // Provision: Nordstan 392 + 472 + 392 = 1 256. Hyra 6 200 + 50 000.
    expect([t.commissionOre, t.rentOre, t.compensationOre]).toEqual([1256, 56_200, 57_456]);
  });

  it("per dag: 30 dagar, 1 nov. = 10 800 / 2 160 / 8 640 / 271", () => {
    expect(r.days).toHaveLength(30);
    const d1 = r.days[0]!;
    expect([d1.date, d1.orders, d1.grossOre, d1.vatOre, d1.netOre, d1.feesOre]).toEqual([
      "2026-11-01",
      2,
      10_800,
      2160,
      8640,
      271,
    ]);
    expect(r.days.filter((d) => d.orders > 0).map((d) => d.date)).toEqual([
      "2026-11-01",
      "2026-11-02",
      "2026-11-15",
      "2026-11-30",
    ]);
  });

  it("per butik: Nordstan, Väla (bara hyra), automater utan butik", () => {
    expect(
      r.stores.map((s) => [
        s.kind,
        s.storeId,
        s.orders,
        s.grossOre,
        s.vatOre,
        s.netOre,
        s.feesOre,
        s.costOre,
        s.unpricedOrders,
        s.commissionOre,
        s.rentOre,
        s.compensationOre,
      ]),
    ).toEqual([
      ["store", "s-1", 3, 15_700, 3140, 12_560, 394, 4000, 1, 1256, 6200, 7456],
      ["store", "s-3", 0, 0, 0, 0, 0, 0, 0, 0, 50_000, 50_000],
      ["no-store", null, 2, 17_800, 3560, 14_240, 446, 4000, 0, 0, 0, 0],
    ]);
  });

  it("per automat: automat 1 i Nordstan, automat 2 utan butik, okopplad", () => {
    const row = (id: string | null) => r.machines.find((m) => m.machineId === id)!;
    expect([row("m-1").orders, row("m-1").grossOre, row("m-1").storeNames]).toEqual([
      3,
      15_700,
      ["Nordstan"],
    ]);
    expect([row("m-2").orders, row("m-2").grossOre, row("m-2").costOre]).toEqual([1, 12_900, 2000]);
    expect(row(null).kind).toBe("no-machine");
    expect([row(null).orders, row(null).grossOre]).toEqual([1, 4900]);
    expect(r.machines.reduce((s, m) => s + m.grossOre, 0)).toBe(33_500);
  });

  it("avstämning: 101–110, luckor 103 och 107–109, 105 ligger utanför perioden", () => {
    const n = r.reconciliation.numbers!;
    expect([n.first, n.last, n.count, n.span, n.missing]).toEqual([101, 110, 5, 10, 4]);
    expect(n.gaps).toEqual([
      { from: 103, to: 103, count: 1 },
      { from: 107, to: 109, count: 3 },
    ]);
    expect(n.outsidePeriod).toEqual(["105"]);
    expect(r.reconciliation.ok).toBe(false);
    expect(r.reconciliation.checks.every((c) => c.ok)).toBe(true);
    expect(r.reconciliation.evidence.externalIds).toEqual(["103", "107", "108", "109"]);
    expect(r.unpricedTitles.map((u) => [u.titleId, u.orders, u.netOre])).toEqual([
      ["t-c", 1, 3920],
    ]);
  });

  it("slutsats: luckorna nämns med siffror", () => {
    expect(r.conclusion.ruleId).toBe("accountant.gaps");
    expect(r.conclusion.text).toBe(
      `Försäljningen november 2026 var 335${N}kr inkl. moms (268${N}kr exkl. moms, moms 25${N}%) på 5${N}order; 4 ordernummer saknas i serien 101–110 (103 och 107–109) och behöver kontrolleras i källan.`,
    );
  });

  it("varje rad har underlag", () => {
    expect(checkEvidence(r)).toBeGreaterThanOrEqual(
      2 + r.days.length + r.stores.length + r.machines.length + r.unpricedTitles.length + 1,
    );
  });

  const sieOpts = {
    company: "Binderlab Göteborg AB",
    orgNumber: "559000-1234",
    ledgerAccounts: ACCOUNTS,
    fiscalYear: { start: "2026-01-01", end: "2026-12-31" },
    verificationSeries: "A",
  };

  it("SIE 4: hela filen, handräknad", () => {
    const tr = (rows: [string, string][]) => [
      "{",
      ...rows.map(([a, b]) => `   #TRANS ${a} {} ${b}`),
      "}",
    ];
    const expected = [
      "#FLAGGA 0",
      "#FORMAT PC8",
      "#SIETYP 4",
      `#PROGRAM "Binderlab" "${CALC_VERSION}"`,
      "#GEN 20261130",
      '#FNAMN "Binderlab Göteborg AB"',
      "#ORGNR 559000-1234",
      "#RAR 0 20260101 20261231",
      "#VALUTA SEK",
      '#KONTO 1460 "Lager Åre"',
      '#KONTO 1580 "Avräkning kortinlösen"',
      '#KONTO 2440 "Skuld Ängelholm"',
      '#KONTO 2611 "Utgående moms 25 %"',
      '#KONTO 3001 "Försäljning"',
      '#KONTO 4010 "Varuinköp"',
      '#KONTO 5010 "Lokalhyra"',
      '#KONTO 6090 "Provision Örebro"',
      '#KONTO 6570 "Kortavgifter (entré)"',
      '#VER "A" "1" 20261101 "Försäljning 1 nov. 2026 (2 order)"',
      ...tr([
        ["1580", "108.00"],
        ["3001", "-86.40"],
        ["2611", "-21.60"],
        ["6570", "2.71"],
        ["1580", "-2.71"],
      ]),
      '#VER "A" "2" 20261102 "Försäljning 2 nov. 2026 (1 order)"',
      ...tr([
        ["1580", "49.00"],
        ["3001", "-39.20"],
        ["2611", "-9.80"],
        ["6570", "1.23"],
        ["1580", "-1.23"],
      ]),
      '#VER "A" "3" 20261115 "Försäljning 15 nov. 2026 (1 order)"',
      ...tr([
        ["1580", "129.00"],
        ["3001", "-103.20"],
        ["2611", "-25.80"],
        ["6570", "3.23"],
        ["1580", "-3.23"],
      ]),
      '#VER "A" "4" 20261130 "Försäljning 30 nov. 2026 (1 order)"',
      ...tr([
        ["1580", "49.00"],
        ["3001", "-39.20"],
        ["2611", "-9.80"],
        ["6570", "1.23"],
        ["1580", "-1.23"],
      ]),
      '#VER "A" "5" 20261130 "Butiksersättning Nordstan november 2026"',
      ...tr([
        ["6090", "12.56"],
        ["5010", "62.00"],
        ["2440", "-74.56"],
      ]),
      '#VER "A" "6" 20261130 "Butiksersättning Väla november 2026"',
      ...tr([
        ["5010", "500.00"],
        ["2440", "-500.00"],
      ]),
      '#VER "A" "7" 20261130 "Inköpsvärde sålda pack november 2026"',
      ...tr([
        ["4010", "80.00"],
        ["1460", "-80.00"],
      ]),
    ];
    const text = buildSie4Text(r, sieOpts);
    expect(text).toBe(expected.join("\r\n") + "\r\n");
  });

  it("SIE 4: CP437 för å ä ö Å Ä Ö é och balanserade verifikationer", () => {
    const buf = exportSie4(r, sieOpts);
    const bytes = [...buf];
    const has = (s: number[]) => bytes.some((_, i) => s.every((b, j) => bytes[i + j] === b));
    expect(has([0x47, 0x94, 0x74])).toBe(true); // "Göt"
    expect(has([0x56, 0x84, 0x6c])).toBe(true); // "Väl"
    expect(has([0x65, 0x6e, 0x74, 0x72, 0x82])).toBe(true); // "entré"
    expect(has([0x55, 0x74, 0x67, 0x86, 0x65])).toBe(true); // "Utgåe"
    expect(has([0x8f, 0x72, 0x65])).toBe(true); // "Åre"
    expect(has([0x8e, 0x6e, 0x67])).toBe(true); // "Äng"
    expect(has([0x99, 0x72, 0x65])).toBe(true); // "Öre"
    expect(bytes.every((b) => b !== 0xc3)).toBe(true); // ingen UTF-8
    const text = decodeCp437(buf);
    expect(text).toBe(buildSie4Text(r, sieOpts));
    // Balans: summera #TRANS per #VER i öre.
    let sum = 0;
    let vers = 0;
    for (const line of text.split("\r\n")) {
      const m = /^ {3}#TRANS \d+ \{\} (-?)(\d+)\.(\d{2})$/.exec(line);
      if (m) sum += (m[1] ? -1 : 1) * (Number(m[2]) * 100 + Number(m[3]));
      if (line === "}") {
        expect(sum).toBe(0);
        vers++;
      }
    }
    expect(vers).toBe(7);
  });

  it("SIE 4 med moms 0: ingen momsrad", () => {
    const r0 = buildAccountantReport(
      { ...accountantSources(), settings: { vatRateBp: 0, cardFeeBp: 0 } },
      NOV,
    );
    const text = buildSie4Text(r0, sieOpts);
    expect(text).not.toContain("#TRANS 2611");
    expect(text).toContain(
      '#VER "A" "1" 20261101 "Försäljning 1 nov. 2026 (2 order)"\r\n{\r\n   #TRANS 1580 {} 108.00\r\n   #TRANS 3001 {} -108.00\r\n}',
    );
  });

  it("Excel: läses tillbaka med blad, frysta rubriker, talformat och handräknade värden", async () => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await buildAccountantWorkbook(r)) as unknown as ArrayBuffer);
    expect(wb.worksheets.map((w) => w.name)).toEqual([
      "Sammanfattning",
      "Per dag",
      "Per butik",
      "Per automat",
      "Avstämning",
    ]);
    for (const ws of wb.worksheets) {
      expect(ws.views[0]).toMatchObject({ state: "frozen", ySplit: 1 });
    }
    const day = wb.getWorksheet("Per dag")!;
    expect(day.rowCount).toBe(32);
    expect(day.getRow(2).values).toEqual([undefined, "2026-11-01", 2, 108, 21.6, 86.4, 2.71]);
    expect(day.getRow(2).getCell(3).numFmt).toBe(KRONOR_FORMAT);
    expect(day.getRow(32).values).toEqual([undefined, "Summa", 5, 335, 67, 268, 8.4]);
    const store = wb.getWorksheet("Per butik")!;
    const vala = store.getRow(3).values as unknown[];
    expect(vala.slice(1)).toEqual(["Väla", 0, 0, 0, 0, 0, 0, 0, 500, 500]);
    const rec = wb.getWorksheet("Avstämning")!;
    const cells: unknown[] = [];
    rec.eachRow((row) => cells.push(...(row.values as unknown[])));
    expect(cells).toContain("103 och 107–109");
    expect(cells).toContain("105");
  });
});

// ---------------------------------------------------------------------------------------
// Scenario 5–6: delägarrapporten
// ---------------------------------------------------------------------------------------

/**
 * Nordstan provision 10 % + hyra 62 kr sedan 2025. Inköp t-a 20 kr, 25 kr från 16 nov. 2026.
 * Nov. 2025: 1 order. Okt. 2026: 2 order. Nov. 2026: 4 order av t-a + 1 av t-c (utan pris).
 */
function partnerSources(): ReportSources {
  return base({
    placements: [placement("m-1", "s-1", "2025-01-01", null)],
    agreements: [
      agreement("s-1", "2025-01-01", null, { commissionBp: 1000, monthlyRentOre: 6200 }),
    ],
    prices: [price("t-a", 2000, "2025-01-01"), price("t-a", 2500, "2026-11-16")],
    orders: [
      ord("2025-11-10", { id: "h1", externalId: "1" }),
      ord("2026-10-05", { id: "q1", externalId: "2" }),
      ord("2026-10-25", { id: "q2", externalId: "3" }),
      ord("2026-11-05", { id: "r1", externalId: "4" }),
      ord("2026-11-10", { id: "r2", externalId: "5" }),
      ord("2026-11-20", { id: "r3", externalId: "6" }),
      ord("2026-11-25", { id: "r4", externalId: "7", amountOre: 5900 }),
      ord("2026-11-28", { id: "r5", externalId: "8", titleId: "t-c" }),
    ],
  });
}

describe("Revision scenario 5: delägarrapport med jämförelser, utveckling, lager och fördelning", () => {
  const r = buildPartnerReport(partnerSources(), "2026-11", {
    owners: [
      { id: "a", name: "Anna", shareBp: 3333 },
      { id: "b", name: "Bertil", shareBp: 3333 },
      { id: "c", name: "Cecilia", shareBp: 3334 },
    ],
    stock: [
      { titleId: "t-a", quantity: 10 },
      { titleId: "t-c", quantity: 3 },
    ],
  });

  it("resultat: 20 600 − 9 000 − 0 − (2 060 + 6 200) = 3 340; marginal 1 621 bp", () => {
    const x = r.result;
    expect([x.orders, x.pricedOrders, x.revenueOre, x.costOre, x.feesOre]).toEqual([
      5, 4, 20_600, 9000, 0,
    ]);
    expect([x.commissionOre, x.rentOre, x.compensationOre, x.profitOre, x.marginBp]).toEqual([
      2060, 6200, 8260, 3340, 1621,
    ]);
    // 4 900 / 25 500 = 1 921,6 bp → 1 922
    expect([x.unpricedOrders, x.unpricedRevenueOre, x.unpricedShareBp]).toEqual([1, 4900, 1922]);
  });

  it("per titel: hyran fördelas med största rest; t-c:s andel 1 191 blir ej fördelad hyra", () => {
    // 6 200 × 4 900 / 25 500 = 1 191,37; 6 200 × 5 900 / 25 500 = 1 434,51. Golv: 6 198.
    // Resterande 2 öre: 25 nov. (0,51) och 5 nov. (första av lika rester 0,37).
    const t = (k: string) => r.titles.find((x) => x.key === k)!;
    expect([t("t-a").rentOre, t("t-a").profitOre]).toEqual([5009, 4531]);
    const un = r.titles.find((x) => x.kind === "unallocated")!;
    expect([un.rentOre, un.profitOre]).toEqual([1191, -1191]);
    expect(r.titles.reduce((s, x) => s + x.profitOre, 0)).toBe(3340);
    expect(r.machines.reduce((s, x) => s + x.profitOre, 0)).toBe(3340);
    expect(r.machines.find((m) => m.key === "m-1")!.profitOre).toBe(4531);
  });

  it("förra månaden: vinst −1 380, marginal −1 408 bp, förändring +34 203 bp", () => {
    const p = r.previousMonth!;
    expect([p.month, p.orders, p.revenueOre, p.profitOre, p.marginBp]).toEqual([
      "2026-10",
      2,
      9800,
      -1380,
      -1408,
    ]);
    expect([p.revenueChangeBp, p.profitChangeBp, p.marginDiffBp]).toEqual([11_020, 34_203, 3029]);
  });

  it("samma månad i fjol: vinst 4 900 − 2 000 − 490 − 6 200 = −3 790", () => {
    const p = r.sameMonthLastYear!;
    expect([p.month, p.revenueOre, p.profitOre, p.marginBp, p.profitChangeBp]).toEqual([
      "2025-11",
      4900,
      -3790,
      -7735,
      18_813,
    ]);
  });

  it("utveckling: 12 månader dec. 2025–nov. 2026, månader utan order bär hyran", () => {
    expect(r.trend.months).toHaveLength(12);
    expect(r.trend.months[0]!.month).toBe("2025-12");
    expect(r.trend.limitedHistory).toBe(false);
    expect([r.trend.months[0]!.revenueOre, r.trend.months[0]!.profitOre]).toEqual([0, -6200]);
    expect(r.trend.months[11]!.profitOre).toBe(3340);
  });

  it("lagervärde: 10 × 25 kr (priset 30 nov.) = 250 kr; t-c utan pris", () => {
    const inv = r.inventory!;
    expect([inv.asOf, inv.totalValueOre, inv.quantity, inv.unpricedQuantity]).toEqual([
      "2026-11-30",
      25_000,
      13,
      3,
    ]);
  });

  it("händelser enligt regler, i datumordning", () => {
    expect(r.events.map((e) => [e.date, e.kind])).toEqual([
      ["2026-11-16", "price_change"],
      ["2026-11-28", "first_sale"],
      ["2026-11-30", "unpriced_orders"],
      ["2026-11-30", "record_high"],
    ]);
    expect(r.events[0]!.text).toBe(
      `Inköpspriset för 30th Celebration ändrades från 20,00${N}kr till 25,00${N}kr den 16 november 2026.`,
    );
    // Rekordet gäller intäkten för alla order (25 500 öre), samma tal som Hem visar som Intäkt.
    // Revisionen räknade först bara prissatta order (20 600); beslutat 2 nov.: intäkt = alla order.
    expect(r.events[3]!.text).toBe(`Högsta intäkten på 12 månader: 255${N}kr.`);
  });

  it("vinstfördelning exakt på öret: 1 113 + 1 113 + 1 114 = 3 340", () => {
    const s = r.profitSplit!;
    expect(s.owners.map((o) => [o.id, o.amountOre])).toEqual([
      ["a", 1113],
      ["b", 1113],
      ["c", 1114],
    ]);
    expect(s.owners.reduce((a, o) => a + o.amountOre, 0)).toBe(3340);
  });

  it("slutsats: vinst, marginal, förändring och förbehåll för saknade priser", () => {
    expect(r.conclusion.ruleId).toBe("partner.profit_up");
    expect(r.conclusion.text).toBe(
      `Vinsten blev 33,40${N}kr (marginal 16,2${N}%), +47,20${N}kr (+342${N}%) mot oktober, men 19${N}% av intäkten saknar inköpspris och ingår inte.`,
    );
  });

  it("varje resultat har underlag", () => {
    expect(checkEvidence(r)).toBeGreaterThanOrEqual(
      1 + 1 + 2 + 12 + r.machines.length + r.titles.length + 1 + 2 + r.events.length + 1,
    );
  });

  it("utan historik: inga jämförelser, utvecklingen markerar månader utan data, inget rekord", () => {
    const h = buildPartnerReport(partnerSources(), "2026-11", { historyStart: "2026-10-01" });
    expect(h.sameMonthLastYear).toBeNull();
    expect(h.previousMonth).not.toBeNull();
    expect(h.trend.limitedHistory).toBe(true);
    expect(h.trend.months.filter((m) => m.hasData).map((m) => m.month)).toEqual([
      "2026-10",
      "2026-11",
    ]);
    expect(h.events.some((e) => e.kind === "record_high")).toBe(false);
    const none = buildPartnerReport(partnerSources(), "2026-11", { historyStart: null });
    expect(none.previousMonth).toBeNull();
    expect(none.sameMonthLastYear).toBeNull();
    expect(none.conclusion.ruleId).toBe("partner.profit");
  });
});

describe("Revision scenario 6: förlustmånad fördelas exakt", () => {
  const r = buildPartnerReport(partnerSources(), "2026-10", {
    owners: [
      { id: "a", name: "Anna", shareBp: 3333 },
      { id: "b", name: "Bertil", shareBp: 6667 },
    ],
  });

  it("−1 380 × 33,33 % = −459,954 → −459 (mot noll); största andelen får −921", () => {
    expect(r.result.profitOre).toBe(-1380);
    expect(r.profitSplit!.owners.map((o) => o.amountOre)).toEqual([-459, -921]);
    expect(r.profitSplit!.text.startsWith(`Förlusten ${M}13,80${N}kr fördelas`)).toBe(true);
    expect(r.conclusion.ruleId).toBe("partner.loss");
    expect(r.conclusion.text).toBe(
      `Oktober 2026 gick med förlust: ${M}13,80${N}kr på 98${N}kr intäkt.`,
    );
  });

  it("ägarandelar som inte summerar till 100 % ger fel", () => {
    expect(() =>
      buildPartnerReport(partnerSources(), "2026-10", {
        owners: [{ id: "a", name: "Anna", shareBp: 9999 }],
      }),
    ).toThrow();
  });
});

describe("Revision: delägarrapportens intäkt ska vara samma tal som panelens nyckeltal", () => {
  // docs/berakningar.md avsnitt 6: Intäkt = Σ nettointäkt (ALLA order); keyMetrics ger 25 500
  // för november (4 900 × 4 + 5 900). Rapporten ska visa samma svar som panelen.
  it("intäkten i utvecklingen och jämförelserna räknas på alla order", () => {
    const src = partnerSources();
    const panel = keyMetrics({ ...src, period: NOV });
    expect(panel.revenueOre).toBe(25_500);
    const r = buildPartnerReport(src, "2026-11");
    expect(r.trend.months[11]!.revenueOre).toBe(panel.revenueOre);
  });

  it("en månad där alla order saknar inköpspris är inte 'lägsta intäkten' när försäljningen var hög", () => {
    // Sex månader maj–okt. 2026 med en order à 49 kr, november 10 order à 49 kr av t-c (utan pris).
    const src = base({
      placements: [placement("m-1", "s-1", "2026-01-01", null)],
      agreements: [agreement("s-1", "2026-01-01", null, { commissionBp: 1000 })],
      prices: [price("t-a", 2000, "2026-01-01")],
      orders: [
        ...["05", "06", "07", "08", "09", "10"].map((m, i) =>
          ord(`2026-${m}-10`, { id: `h${i}`, externalId: String(i + 1) }),
        ),
        ...Array.from({ length: 10 }, (_, i) =>
          ord(`2026-11-${String(i + 10)}`, {
            id: `u${i}`,
            externalId: String(100 + i),
            titleId: "t-c",
          }),
        ),
      ],
    });
    const r = buildPartnerReport(src, "2026-11", { trendMonths: 7 });
    expect(r.events.some((e) => e.kind === "record_low")).toBe(false);
  });
});

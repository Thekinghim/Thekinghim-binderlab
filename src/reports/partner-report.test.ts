import { describe, expect, it } from "vitest";
import { DomainError, keyMetrics, monthPeriod, profitability } from "@/domain";
import { buildPartnerReport } from "./partner-report";
import { agreement, octoberExample, ord, placement, price, sources } from "./testing/fixtures";

const plain = (s: string) => s.replace(/ /g, " ");

describe("resultat", () => {
  it("handräkningen i docs/berakningar.md avsnitt 3: vinst 76,60 kr, marginal 25,2 %", () => {
    const r = buildPartnerReport(octoberExample(), "2026-10");
    expect(r.result).toMatchObject({
      orders: 6,
      revenueOre: 30_400,
      costOre: 13_500,
      feesOre: 0,
      commissionOre: 3040,
      rentOre: 6200,
      compensationOre: 9240,
      profitOre: 7660,
      marginBp: 2520,
      unpricedOrders: 0,
    });
    expect(r.conclusion.ruleId).toBe("partner.profit");
    expect(plain(r.conclusion.text)).toBe(
      "Vinsten blev 76,60 kr på 304 kr intäkt (marginal 25,2 %).",
    );
  });

  it("raderna per automat och titel summerar till resultatet", () => {
    const src = octoberExample();
    const r = buildPartnerReport(src, "2026-10");
    expect(r.machines.reduce((s, m) => s + m.profitOre, 0)).toBe(r.result.profitOre);
    expect(r.titles.reduce((s, t) => s + t.profitOre, 0)).toBe(r.result.profitOre);
    expect(r.machines[0]!.name).toBe("Nordstan entré (BL-001)");
    expect(r.titles[0]!.name).toBe("30th Celebration");
    const p = profitability({ ...src, period: r.period }, "machine");
    expect(r.machines.map((m) => m.profitOre)).toEqual(p.rows.map((x) => x.profitOre));
  });

  it("utan historik före månaden: ingen jämförelse, utvecklingen markerar tomma månader", () => {
    const r = buildPartnerReport(octoberExample(), "2026-10");
    expect(r.previousMonth).toBeNull();
    expect(r.sameMonthLastYear).toBeNull();
    expect(r.trend.months).toHaveLength(12);
    expect(r.trend.months[0]!.month).toBe("2025-11");
    expect(r.trend.months[11]!).toMatchObject({ month: "2026-10", hasData: true, profitOre: 7660 });
    expect(r.trend.months.filter((m) => m.hasData)).toHaveLength(1);
    expect(r.trend.limitedHistory).toBe(true);
  });

  it("jämförelse mot förra månaden och samma månad i fjol när historik finns", () => {
    const base = octoberExample();
    const src = {
      ...base,
      orders: [
        ...base.orders,
        ord("2026-09-10", { amountOre: 4900 }),
        ord("2025-10-10", { amountOre: 4900 }),
        ord("2025-10-11", { amountOre: 4900 }),
      ],
      prices: [...base.prices, { titleId: "t-a", unitCostOre: 2000, validFrom: "2025-01-01" }],
    };
    const r = buildPartnerReport(src, "2026-10");
    // September: 49,00 − 20,00 − 4,90 − 62,00 = −37,90 kr.
    expect(r.previousMonth).toMatchObject({ month: "2026-09", revenueOre: 4900, profitOre: -3790 });
    expect(r.previousMonth!.profitChangeBp).toBe(Math.round(((7660 + 3790) * 10_000) / 3790));
    expect(r.sameMonthLastYear).toMatchObject({ month: "2025-10", revenueOre: 9800, orders: 2 });
    expect(r.sameMonthLastYear!.marginDiffBp).toBe(2520 - r.sameMonthLastYear!.marginBp!);
    expect(r.trend.limitedHistory).toBe(false);
    expect(r.conclusion.ruleId).toBe("partner.profit_up");
    expect(plain(r.conclusion.text)).toBe(
      "Vinsten blev 76,60 kr (marginal 25,2 %), +114,50 kr (+302 %) mot september.",
    );
  });

  it("utvecklingens sista månad = resultatet; 6 månader går att välja; 5 och 13 ger fel", () => {
    const r = buildPartnerReport(octoberExample(), "2026-10", { trendMonths: 6 });
    expect(r.trend.months.map((m) => m.month)).toEqual([
      "2026-05",
      "2026-06",
      "2026-07",
      "2026-08",
      "2026-09",
      "2026-10",
    ]);
    expect(r.trend.months[5]!.revenueOre).toBe(r.result.totalRevenueOre);
    expect(() => buildPartnerReport(octoberExample(), "2026-10", { trendMonths: 5 })).toThrow(
      DomainError,
    );
    expect(() => buildPartnerReport(octoberExample(), "2026-10", { trendMonths: 13 })).toThrow(
      DomainError,
    );
  });

  it("förlust och ingen försäljning", () => {
    const loss = sources({
      orders: [ord("2026-11-02")],
      prices: [price("t-a", 2000, "2025-01-01")],
      agreements: [agreement("s-1", "2025-01-01", null, { monthlyRentOre: 100_000 })],
    });
    const r = buildPartnerReport(loss, "2026-11");
    expect(r.result.profitOre).toBe(4900 - 2000 - 100_000);
    expect(r.conclusion.ruleId).toBe("partner.loss");
    expect(plain(r.conclusion.text)).toBe(
      "November 2026 gick med förlust: −971 kr på 49 kr intäkt.",
    );
    const none = buildPartnerReport(sources(), "2026-11");
    expect(none.conclusion.ruleId).toBe("partner.no_sales");
    expect(none.conclusion.text).toBe("Ingen försäljning i november 2026.");
  });

  it("förbehåll i slutsatsen när minst 5 % av intäkten saknar inköpspris", () => {
    const src = sources({
      orders: [
        ord("2026-11-02", { amountOre: 9000 }),
        ord("2026-11-03", { titleId: "t-c", amountOre: 1000 }),
      ],
      prices: [price("t-a", 2000, "2025-01-01")],
    });
    const r = buildPartnerReport(src, "2026-11");
    expect(r.result.unpricedShareBp).toBe(1000);
    expect(plain(r.conclusion.text)).toBe(
      "Vinsten blev 70 kr på 100 kr intäkt (marginal 77,8 %), men 10 % av intäkten saknar inköpspris och ingår inte.",
    );
  });
});

describe("vinstfördelning enligt ägarandelar", () => {
  const owners = [
    { id: "a", name: "Anna", shareBp: 6000 },
    { id: "b", name: "Bo", shareBp: 3000 },
    { id: "c", name: "Cia", shareBp: 1000 },
  ];
  const withProfit = (profitOre: number) =>
    sources({
      orders: [ord("2026-11-02", { amountOre: profitOre + 1000 })],
      prices: [price("t-a", 1000, "2025-01-01")],
    });

  it("999,99 kr 60/30/10: avkortat per ägare, öret till största andelen, summan exakt", () => {
    const r = buildPartnerReport(withProfit(99_999), "2026-11", { owners });
    expect(r.profitSplit!.profitOre).toBe(99_999);
    expect(r.profitSplit!.owners.map((o) => o.amountOre)).toEqual([60_001, 29_999, 9_999]);
    expect(r.profitSplit!.owners.reduce((s, o) => s + o.amountOre, 0)).toBe(99_999);
    expect(plain(r.profitSplit!.text)).toBe(
      "Vinsten 999,99 kr fördelas: Anna 60 % = 600,01 kr, Bo 30 % = 299,99 kr och Cia 10 % = 99,99 kr.",
    );
  });

  it("50/50 med udda öre och förlust", () => {
    const half = [
      { id: "x", name: "X", shareBp: 5000 },
      { id: "y", name: "Y", shareBp: 5000 },
    ];
    const r = buildPartnerReport(withProfit(100_001), "2026-11", { owners: half });
    expect(r.profitSplit!.owners.map((o) => o.amountOre)).toEqual([50_001, 50_000]);
    const loss = sources({
      orders: [ord("2026-11-02", { amountOre: 1000 })],
      prices: [price("t-a", 1333, "2025-01-01")],
    });
    const l = buildPartnerReport(loss, "2026-11", { owners: half });
    expect(l.profitSplit!.profitOre).toBe(-333);
    expect(l.profitSplit!.owners.map((o) => o.amountOre)).toEqual([-167, -166]);
    expect(l.profitSplit!.text.startsWith("Förlusten")).toBe(true);
  });

  it("andelar som inte summerar till 100 % ger fel; utan ägare ingen fördelning", () => {
    expect(() =>
      buildPartnerReport(withProfit(100), "2026-11", {
        owners: [{ id: "a", name: "A", shareBp: 9000 }],
      }),
    ).toThrow(/10000 bp/);
    expect(buildPartnerReport(withProfit(100), "2026-11").profitSplit).toBeNull();
  });
});

describe("lagervärde", () => {
  it("antal × inköpspriset som gällde månadens sista dag; titlar utan pris räknas separat", () => {
    const src = sources({
      prices: [
        price("t-a", 2000, "2025-01-01"),
        price("t-a", 2500, "2026-11-30"),
        price("t-b", 3000, "2026-12-01"),
      ],
    });
    const r = buildPartnerReport(src, "2026-11", {
      stock: [
        { titleId: "t-a", quantity: 10 },
        { titleId: "t-a", quantity: 2 },
        { titleId: "t-b", quantity: 5 },
      ],
    });
    expect(r.inventory).toMatchObject({
      asOf: "2026-11-30",
      totalValueOre: 12 * 2500,
      quantity: 17,
      unpricedQuantity: 5,
    });
    expect(r.inventory!.lines[0]).toMatchObject({
      titleId: "t-a",
      quantity: 12,
      unitCostOre: 2500,
      valueOre: 30_000,
    });
    expect(r.inventory!.lines[1]).toMatchObject({
      titleId: "t-b",
      unitCostOre: null,
      valueOre: null,
    });
    expect(buildPartnerReport(src, "2026-11").inventory).toBeNull();
  });
});

describe("viktiga händelser", () => {
  const src = sources({
    orders: [
      ord("2026-10-02", { titleId: "t-a" }),
      ord("2026-11-02", { titleId: "t-a" }),
      ord("2026-11-20", { titleId: "t-b", amountOre: 4900, machineId: "m-3" }),
      ord("2026-11-21", { titleId: "t-c" }),
    ],
    prices: [
      price("t-a", 2000, "2025-01-01"),
      price("t-a", 2200, "2026-11-10"),
      price("t-b", 4800, "2026-11-01"),
    ],
    placements: [
      placement("m-1", "s-1", "2025-01-01", null),
      placement("m-2", "s-2", "2025-01-01", null),
      placement("m-3", "s-2", "2025-01-01", "2026-11-14"),
      placement("m-3", "s-1", "2026-11-15", null),
    ],
    agreements: [
      agreement("s-1", "2025-01-01", "2026-11-15", { commissionBp: 1000 }),
      agreement("s-1", "2026-11-16", null, { commissionBp: 1200 }),
      agreement("s-3", "2025-01-01", null, { monthlyRentOre: 20_000 }),
    ],
  });
  const r = buildPartnerReport(src, "2026-11", {
    events: [{ date: "2026-11-05", text: "Automaten servades." }],
  });
  const kinds = r.events.map((e) => e.kind);

  it("hittar händelserna med regler", () => {
    expect(kinds).toContain("new_price");
    expect(kinds).toContain("price_change");
    expect(kinds).toContain("machine_moved");
    expect(kinds).toContain("agreement_change");
    expect(kinds).toContain("first_sale");
    expect(kinds).toContain("loss_title");
    expect(kinds).toContain("unpriced_orders");
    expect(kinds).toContain("unallocated_rent");
    expect(kinds).toContain("idle_machine");
    expect(kinds).toContain("manual");
    expect(kinds).not.toContain("machine_removed");
    expect(kinds).not.toContain("agreement_end");
  });

  it("texterna är konkreta, med siffror och datum", () => {
    const text = (k: string) => plain(r.events.find((e) => e.kind === k)!.text);
    expect(text("price_change")).toBe(
      "Inköpspriset för 30th Celebration ändrades från 20,00 kr till 22,00 kr den 10 november 2026.",
    );
    expect(text("machine_moved")).toBe(
      "Reserv (BL-003) flyttade från Mobilia till Nordstan den 15 november 2026.",
    );
    expect(text("agreement_change")).toBe(
      "Nya villkor för Nordstan från 16 november 2026: provision 12 % (tidigare provision 10 %).",
    );
    expect(text("first_sale")).toBe(
      "Prismatic Evolutions såldes för första gången den 20 november 2026 (1 order under månaden).",
    );
    expect(text("idle_machine")).toBe(
      "Mobilia plan 2 (BL-002) i Mobilia sålde inget under november 2026.",
    );
    expect(text("unallocated_rent")).toBe(
      "Väla hade ingen försäljning men hyran 200 kr dras ändå.",
    );
    expect(text("unpriced_orders")).toBe(
      "1 order (49 kr, 33 % av intäkten) saknar inköpspris och ingår inte i vinsten: Surging Sparks.",
    );
    expect(text("loss_title")).toContain("Prismatic Evolutions går med förlust");
  });

  it("sorteras på datum och bär underlag", () => {
    const dates = r.events.map((e) => e.date);
    expect([...dates].sort()).toEqual(dates);
    const price = r.events.find((e) => e.kind === "price_change")!;
    expect(price.evidence.titleIds).toEqual(["t-a"]);
    expect(price.evidence.dates).toEqual(["2026-11-10"]);
    expect(price.evidence.figures.map((f) => f.value)).toEqual([2000, 2200]);
  });

  it("rekordmånad kräver minst sex månader med data", () => {
    const months = ["2026-05", "2026-06", "2026-07", "2026-08", "2026-09", "2026-10"];
    const hist = sources({
      orders: [...months.map((m) => ord(`${m}-10`)), ord("2026-11-10"), ord("2026-11-11")],
      prices: [price("t-a", 2000, "2025-01-01")],
    });
    const high = buildPartnerReport(hist, "2026-11");
    expect(plain(high.events.find((e) => e.kind === "record_high")!.text)).toBe(
      "Högsta intäkten på 7 månader: 98 kr.",
    );
    const short = buildPartnerReport({ ...hist, orders: hist.orders.slice(2) }, "2026-11");
    expect(short.events.some((e) => e.kind === "record_high")).toBe(false);
  });

  it("automat som tas bort och avtal som upphör utan efterföljare", () => {
    const s = sources({
      placements: [placement("m-1", "s-1", "2025-01-01", "2026-11-20")],
      agreements: [agreement("s-1", "2025-01-01", "2026-11-20", { commissionBp: 1000 })],
    });
    const e = buildPartnerReport(s, "2026-11").events.map((x) => x.kind);
    expect(e).toContain("machine_removed");
    expect(e).toContain("agreement_end");
  });
});

describe("intäkten är samma tal som panelens (keyMetrics), även med order utan inköpspris", () => {
  // Oktober: 2 order à 49 kr med pris. November: 4 order à 49 kr med pris och 2 à 59 kr utan.
  const src = sources({
    agreements: [
      agreement("s-1", "2025-01-01", null, { commissionBp: 1000, monthlyRentOre: 5000 }),
    ],
    prices: [price("t-a", 2000, "2025-01-01")],
    orders: [
      ord("2026-10-05"),
      ord("2026-10-06"),
      ...["03", "04", "05", "06"].map((d) => ord(`2026-11-${d}`)),
      ord("2026-11-07", { titleId: "t-c", amountOre: 5900 }),
      ord("2026-11-08", { titleId: "t-c", amountOre: 5900 }),
    ],
  });
  const r = buildPartnerReport(src, "2026-11", { trendMonths: 6 });
  const panel = (m: string) => keyMetrics({ ...src, period: monthPeriod(m) });

  it("resultatet: total intäkt 31 400 = panelen; vinstens underlag 19 600 + utan pris 11 800", () => {
    expect(r.result.totalRevenueOre).toBe(31_400);
    expect(r.result.totalRevenueOre).toBe(panel("2026-11").revenueOre);
    expect([r.result.revenueOre, r.result.unpricedRevenueOre]).toEqual([19_600, 11_800]);
    expect(r.result.profitOre).toBe(panel("2026-11").profitOre);
    expect(r.result.marginBp).toBe(panel("2026-11").marginBp);
  });

  it("varje månad i utvecklingen har panelens intäkt, vinst och marginal", () => {
    for (const m of r.trend.months) {
      const k = panel(m.month);
      expect([m.revenueOre, m.profitOre, m.marginBp], m.month).toEqual([
        k.revenueOre,
        k.profitOre,
        k.marginBp,
      ]);
      expect(m.pricedRevenueOre + m.unpricedRevenueOre).toBe(m.revenueOre);
    }
  });

  it("jämförelsen visar panelens intäkt och förändring: 9 800 → 31 400 = +22 041 bp", () => {
    const p = r.previousMonth!;
    expect([p.totalRevenueOre, p.totalRevenueChangeBp]).toEqual([9800, 22_041]);
    // Vinstens underlag jämförs för sig: 9 800 → 19 600 = +10 000 bp.
    expect([p.revenueOre, p.revenueChangeBp]).toEqual([9800, 10_000]);
    expect(plain(p.text)).toContain("intäkt 98 kr (nu +220 %)");
  });

  it("slutsatsen nämner panelens intäkt", () => {
    const solo = buildPartnerReport(src, "2026-11", { historyStart: "2026-11-01" });
    expect(solo.conclusion.ruleId).toBe("partner.profit");
    expect(plain(solo.conclusion.text)).toMatch(/^Vinsten blev .* på 314 kr intäkt/);
  });

  it("rekord räknas på panelens intäkt: en månad med bara order utan pris är inte 'lägsta'", () => {
    const hist = sources({
      prices: [price("t-a", 2000, "2025-01-01")],
      orders: [
        ...["05", "06", "07", "08", "09", "10"].map((m) => ord(`2026-${m}-10`)),
        ...Array.from({ length: 3 }, (_, i) => ord(`2026-11-1${i}`, { titleId: "t-c" })),
      ],
    });
    const x = buildPartnerReport(hist, "2026-11", { trendMonths: 7 });
    expect(x.events.some((e) => e.kind === "record_low")).toBe(false);
    const high = x.events.find((e) => e.kind === "record_high")!;
    expect(plain(high.text)).toBe("Högsta intäkten på 7 månader: 147 kr.");
    expect(high.evidence.figures[0]!.value).toBe(
      keyMetrics({ ...hist, period: monthPeriod("2026-11") }).revenueOre,
    );
  });
});

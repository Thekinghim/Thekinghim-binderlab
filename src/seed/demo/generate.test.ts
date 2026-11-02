/**
 * Demogeneratorn utan databas: determinism, omfattning, mönster (veckodag,
 * säsong, släppkurva), slutsålda perioder, lagrets konsistens, utbetalningarnas
 * avvikelse och att --stor ger minst 100 000 order.
 */

import { describe, expect, it } from "vitest";

import { dayOfWeek } from "@/domain/dates";
import { parseAwishCsv } from "@/import/adapters/awish-csv";
import { parsePayoutFile } from "@/server/accounting/payout-csv";

import {
  DEMO_BIG_RELEASE,
  DEMO_LARGE_MIN_ORDERS,
  DEMO_LARGE_SCALE,
  DEMO_MACHINES,
  DEMO_PAYOUT,
  DEMO_PERIOD,
  DEMO_STORES,
  DEMO_TITLES,
  DEMO_TITLES_WITHOUT_PRICE,
} from "./catalog";
import { demoOrderFiles, demoPayoutFiles, planIncidents } from "./files";
import { generateDemo, ordersByMonth, salePriceOn } from "./generate";

const gen = generateDemo();

describe("demo: omfattning", () => {
  it("är deterministisk", () => {
    const again = generateDemo();
    expect(again.orders.length).toBe(gen.orders.length);
    expect(again.orders.slice(0, 50)).toEqual(gen.orders.slice(0, 50));
    expect(again.orders.at(-1)).toEqual(gen.orders.at(-1));
    expect(again.stockEvents.length).toBe(gen.stockEvents.length);
  });

  it("8–12 automater i 6–8 butiker, minst nio månader, feb–okt plus 1–2 nov", () => {
    expect(DEMO_MACHINES.length).toBeGreaterThanOrEqual(8);
    expect(DEMO_MACHINES.length).toBeLessThanOrEqual(12);
    expect(DEMO_STORES.length).toBeGreaterThanOrEqual(6);
    expect(DEMO_STORES.length).toBeLessThanOrEqual(8);
    const months = [...ordersByMonth(gen.orders).keys()];
    expect(months).toEqual([
      "2026-02",
      "2026-03",
      "2026-04",
      "2026-05",
      "2026-06",
      "2026-07",
      "2026-08",
      "2026-09",
      "2026-10",
      "2026-11",
    ]);
    expect(gen.orders[0]?.businessDate).toBe(DEMO_PERIOD.start);
    expect(gen.orders.at(-1)?.businessDate).toBe(DEMO_PERIOD.end);
    expect(new Set(gen.orders.map((o) => o.machineCode)).size).toBe(DEMO_MACHINES.length);
  });

  it("rimliga summor: 12 000–20 000 order, snitt 140–200 kr", () => {
    const revenue = gen.orders.reduce((n, o) => n + o.amountOre, 0);
    expect(gen.orders.length).toBeGreaterThan(12_000);
    expect(gen.orders.length).toBeLessThan(20_000);
    const avg = revenue / gen.orders.length;
    expect(avg).toBeGreaterThan(14_000);
    expect(avg).toBeLessThan(20_000);
    // Varje månad växer i stort (fler automater, säsong): oktober är bäst.
    const byMonth = [...ordersByMonth(gen.orders)].map(([m, l]) => [m, l.length] as const);
    const best = byMonth.reduce((a, b) => (b[1] > a[1] ? b : a));
    expect(best[0]).toBe("2026-10");
  });

  it("ordernummer i tidsordning och priser enligt katalogen", () => {
    for (let i = 1; i < gen.orders.length; i++) {
      const a = gen.orders[i - 1]!;
      const b = gen.orders[i]!;
      expect(Number(b.externalId)).toBe(Number(a.externalId) + 1);
      expect(b.paidAtMs).toBeGreaterThanOrEqual(a.paidAtMs);
    }
    const titles = new Map(DEMO_TITLES.map((t) => [t.name, t]));
    for (const o of gen.orders) {
      expect(o.amountOre).toBe(salePriceOn(titles.get(o.title)!, o.businessDate));
    }
  });
});

describe("demo: mönster", () => {
  it("lördagar säljer mer än tisdagar", () => {
    const perDow = new Map<number, number>();
    for (const o of gen.orders) {
      const d = dayOfWeek(o.businessDate);
      perDow.set(d, (perDow.get(d) ?? 0) + 1);
    }
    expect(perDow.get(6)!).toBeGreaterThan(perDow.get(2)! * 1.5);
  });

  it("säsong: oktober säljer mer per automatdag än juli i samma automat", () => {
    const count = (month: string) =>
      gen.orders.filter((o) => o.machineCode === "NA-01" && o.businessDate.startsWith(month))
        .length / 31;
    expect(count("2026-10")).toBeGreaterThan(count("2026-07") * 1.2);
  });

  it("släppkurva: efterfrågan på storsläppet är störst första veckan", () => {
    const title = DEMO_TITLES.find((t) => t.name === DEMO_BIG_RELEASE)!;
    const sales = gen.orders.filter((o) => o.title === DEMO_BIG_RELEASE);
    expect(sales[0]!.businessDate >= title.availableFrom).toBe(true);
    // Efterfrågan = sålt + förlorat (första veckan är utbudet begränsat).
    const demand = (from: string, to: string) =>
      sales.filter((o) => o.businessDate >= from && o.businessDate <= to).length +
      gen.lostSales.filter((l) => l.title === DEMO_BIG_RELEASE && l.date >= from && l.date <= to)
        .length;
    expect(demand("2026-09-19", "2026-09-25")).toBeGreaterThan(demand("2026-10-10", "2026-10-16"));
  });

  it("prisändringar mitt i perioden syns i orderna", () => {
    const prices = (name: string) =>
      [...new Set(gen.orders.filter((o) => o.title === name).map((o) => o.amountOre))].sort();
    expect(prices("Scarlet & Violet 151")).toEqual([19_900, 21_900]);
    expect(prices("Prismatic Evolution")).toEqual([19_900, 22_900]);
    expect(DEMO_TITLES_WITHOUT_PRICE).toHaveLength(2);
    for (const name of DEMO_TITLES_WITHOUT_PRICE) {
      expect(gen.orders.some((o) => o.title === name)).toBe(true);
    }
  });

  it("automaten flyttar och automaten med fel slutar sälja", () => {
    const moved = gen.orders.filter((o) => o.machineCode === "NA-05");
    expect(moved.some((o) => o.businessDate < "2026-06-15")).toBe(true);
    expect(moved.some((o) => o.businessDate >= "2026-06-15")).toBe(true);
    const faulty = gen.orders.filter((o) => o.machineCode === "NA-07");
    expect(faulty.every((o) => o.businessDate < "2026-10-31")).toBe(true);
  });
});

describe("demo: lager och slutsålt", () => {
  it("förlorad försäljning finns: storsläppet och restnoteringen i juli", () => {
    expect(gen.lostSales.length).toBeGreaterThan(150);
    expect(gen.stockoutDays).toBeGreaterThan(50);
    expect(gen.lostSales.filter((l) => l.title === DEMO_BIG_RELEASE).length).toBeGreaterThan(30);
    expect(
      gen.lostSales.filter((l) => l.title === "Prismatic Evolution" && l.date.startsWith("2026-07"))
        .length,
    ).toBeGreaterThan(10);
  });

  it("saldot blir aldrig negativt (händelser + försäljning i tidsordning)", () => {
    type Step = { ms: number; key: string; kind: string; q: number; order: number };
    const steps: Step[] = [];
    gen.stockEvents.forEach((e, i) => {
      const loc = e.location.kind === "warehouse" ? "C" : e.location.code;
      steps.push({
        ms: e.occurredAtMs,
        key: `${loc}|${e.title}`,
        kind: e.kind,
        q: e.quantity,
        order: i,
      });
    });
    gen.orders.forEach((o, i) =>
      steps.push({
        ms: o.paidAtMs,
        key: `${o.machineCode}|${o.title}`,
        kind: "sale",
        q: -1,
        order: 1e9 + i,
      }),
    );
    steps.sort((a, b) => a.ms - b.ms || a.order - b.order);
    const level = new Map<string, number>();
    for (const s of steps) {
      const next = s.kind === "count" ? s.q : (level.get(s.key) ?? 0) + s.q;
      expect(next, `${s.key} ${new Date(s.ms).toISOString()}`).toBeGreaterThanOrEqual(0);
      level.set(s.key, next);
    }
    for (const [key, n] of gen.machineLevels) {
      expect(level.get(key) ?? 0, key).toBe(n);
    }
  });

  it("inköpsorder: levererade, en på väg och utkast i dag", () => {
    const statuses = new Set(gen.purchaseOrders.map((p) => p.status));
    expect(statuses).toEqual(new Set(["received", "ordered", "draft"]));
    const receipts = gen.stockEvents.filter((e) => e.kind === "receipt");
    const received = gen.purchaseOrders.filter((p) => p.status === "received");
    expect(receipts.length).toBe(received.reduce((n, p) => n + p.lines.length, 0));
  });
});

describe("demo: filer", () => {
  it("varje månadsfil läses av Awish-importens tolk med alla rader", () => {
    const files = demoOrderFiles(gen.orders);
    expect(files.reduce((n, f) => n + f.orders, 0)).toBe(gen.orders.length);
    const file = files[0]!;
    const parsed = parseAwishCsv({
      context: {
        organizationId: "00000000-0000-0000-0000-000000000001",
        dataSourceId: "00000000-0000-0000-0000-000000000002",
        sourceTimezone: "Asia/Shanghai",
        config: {},
        secretRef: null,
      },
      file: { name: file.name, content: file.bytes },
    });
    expect(parsed.errors).toEqual([]);
    expect(parsed.rows.length).toBe(file.orders);
    expect(parsed.rows.reduce((n, r) => n + r.amountOre, 0)).toBe(file.revenueOre);
  });

  it("utbetalningar per månad: alla stämmer utom avvikelsemånaden", () => {
    const incidents = planIncidents(gen.orders);
    expect(incidents.filter((i) => i.refundedOre > 0)).toHaveLength(2);
    const files = demoPayoutFiles(gen.orders, incidents);
    expect(files.payouts.map((p) => p.month)).toEqual([
      "2026-02",
      "2026-03",
      "2026-04",
      "2026-05",
      "2026-06",
      "2026-07",
      "2026-08",
      "2026-09",
      "2026-10",
    ]);
    for (const p of files.payouts) {
      const expected = p.salesOre - p.refundsOre;
      if (p.month === DEMO_PAYOUT.deviationMonth) {
        expect(p.missing).toHaveLength(DEMO_PAYOUT.missingOrders);
        expect(p.amountOre).toBeLessThan(expected);
      } else {
        expect(p.amountOre).toBe(expected);
      }
    }
    const parsed = parsePayoutFile(files.payoutsCsv.bytes);
    expect(parsed.errors).toEqual([]);
    expect(parsed.payouts.map((p) => p.amountOre)).toEqual(files.payouts.map((p) => p.amountOre));
    const lines = parsePayoutFile(files.linesCsv.bytes);
    expect(lines.format).toBe("lines");
    expect(lines.errors).toEqual([]);
    expect(lines.lines).toHaveLength(files.linesCsv.lines);
  });
});

describe("demo: --stor", () => {
  it(`minst ${DEMO_LARGE_MIN_ORDERS} order med samma mönster`, () => {
    const large = generateDemo({ scale: DEMO_LARGE_SCALE });
    expect(large.orders.length).toBeGreaterThanOrEqual(DEMO_LARGE_MIN_ORDERS);
    expect(new Set(large.orders.map((o) => o.externalId)).size).toBe(large.orders.length);
  });
});

/**
 * Oberoende revision av Att göra (src/analytics/todos) och Värt att veta (src/analytics/insights).
 *
 * Alla förväntade värden är uträknade för hand från specifikationen (se kommentarerna vid
 * varje fall), inte avlästa från koden. "Nu" är måndag 2 nov. 2026 11:00 svensk tid (CET).
 * Moms 0, kortavgift 0, provision 10 % (test-helpers: automat m1 i butik s1).
 */

import { describe, expect, it } from "vitest";
import { computeInsights, evaluateInsights, type Insight } from "@/analytics/insights";
import {
  applyDismissals,
  computeTodos,
  type Evidence,
  type ReportDeliveryRef,
  type ReportRecipientRef,
  type TodoInput,
  type TodoItem,
} from "@/analytics/todos";
import { daily, input, machine, many, order, title } from "../test-helpers";
import type { AnalyticsOrder } from "../types";

const NOW = "2026-11-02T10:00:00Z"; // mån 2 nov. 11:00 i Stockholm
const TOMORROW = "2026-11-03T10:00:00Z";

/** Hårda mellanslag → vanliga, så att texterna kan jämföras läsbart. */
const plain = (s: string) => s.replace(/[  ]/g, " ");
const byKind = (todos: TodoItem[], kind: TodoItem["kind"]) => todos.filter((t) => t.kind === kind);
const find = (todos: TodoItem[], key: string) => {
  const t = todos.find((x) => x.key === key);
  if (!t) throw new Error(`Saknar punkten ${key}. Fanns: ${todos.map((x) => x.key).join(", ")}`);
  return t;
};
const fig = (e: Evidence, key: string) => e.figures.find((f) => f.key === key)?.value;

/** Underlaget ska finnas, vara sorterat och unikt, och peka på något konkret. */
function expectEvidence(e: Evidence): void {
  expect(e.rule.length).toBeGreaterThan(10);
  expect(e.figures.length).toBeGreaterThan(0);
  const lists = [e.orderIds, e.dates, e.titleIds, e.machineIds, e.storeIds, e.recipientIds];
  expect(lists.some((l) => l.length > 0)).toBe(true);
  for (const l of lists) {
    expect([...new Set(l)].sort()).toEqual(l);
  }
  for (const f of e.figures) expect(Number.isSafeInteger(f.value)).toBe(true);
}

// ===========================================================================
// Fall 1: Påfyllning (2,5 dagar, 14 dagar t.o.m. i går, kortat fönster, nivå, kronor i risk)
// ===========================================================================

describe("Revision 1: påfyllning", () => {
  // Fönster 19 okt.–1 nov. (14 dagar). Dagens order (2 nov.) ska INTE påverka takten.
  //  t1 Black Bolt: 3/dag = 42 pack, 205 800 kr-öre. Lager 7 → 7 × 14 / 42 = 2,33 dagar < 2,5 → flaggas.
  //     tiondelar = golv(980/42) = 23 → "2,3"; nivå soon (≥ 1 dag); dagar kvar = golv(98/42) = 2
  //     i risk = 14 700 öre/dag × (7 − 7/3) = 68 600 öre
  //  t2 Mystery Pack: 2/dag = 28 pack. Lager 5 → exakt 2,5 dagar → flaggas INTE.
  //  t3 30th Celebration: 2/dag = 28 pack. Lager 4 → 2,0 dagar → flaggas; i risk = 9 800 × 5 = 49 000.
  //  m9 (ur drift sedan 31 okt.) med slut lager → ingen punkt.
  //  m2 startade 29 okt.: fönstret kortas till 29 okt.–1 nov. (4 dagar), 2/dag = 8 pack.
  //     Lager 4 → 4 × 4 / 8 = 2,0 dagar → flaggas. Utan kortning (8/14 per dag) hade det räckt 7 dagar.
  const base = (): TodoInput =>
    input({
      titles: [
        title("t1", "Black Bolt"),
        title("t2", "Mystery Pack"),
        title("t3", "30th Celebration"),
      ],
      machines: [
        machine("m1", "Automat 1"),
        machine("m2", "Automat 2", { activeFrom: "2026-10-29" }),
        machine("m9", "Automat 9", { activeTo: "2026-10-31" }),
      ],
      orders: [
        ...daily("t1", "m1", "2026-10-19", 14, 3),
        ...daily("t2", "m1", "2026-10-19", 14, 2),
        ...daily("t3", "m1", "2026-10-19", 14, 2),
        ...many(5, { titleId: "t1", machineId: "m1", businessDate: "2026-11-02" }),
        ...daily("t2", "m2", "2026-10-29", 4, 2),
        ...daily("t1", "m9", "2026-10-19", 13, 3),
      ],
      placements: [
        { machineId: "m1", storeId: "s1", from: "2026-01-01", to: null },
        { machineId: "m2", storeId: "s1", from: "2026-10-29", to: null },
      ],
      stock: [
        { machineId: "m1", titleId: "t1", onHand: 7, lastRestockedAt: "2026-10-30T08:00:00Z" },
        { machineId: "m1", titleId: "t2", onHand: 5 },
        { machineId: "m1", titleId: "t3", onHand: 4 },
        { machineId: "m2", titleId: "t2", onHand: 4 },
        { machineId: "m9", titleId: "t1", onHand: 0 },
      ],
    });

  it("flaggar under 2,5 dagar, inte exakt 2,5, inte automater ur drift; sorterar på kronor i risk", () => {
    const refill = byKind(computeTodos(base(), NOW), "refill");
    // t1 (68 600) > t3 (49 000) = m2/t2 (8 pack × 4 900 / 4 dagar = 9 800/dag × 5 = 49 000) → nyckelordning
    expect(refill.map((t) => t.key)).toEqual(["refill:m1:t1", "refill:m1:t3", "refill:m2:t2"]);

    const t1 = find(refill, "refill:m1:t1");
    expect(t1.level).toBe("soon");
    expect(t1.atStakeOre).toBe(68_600);
    expect(t1.daysLeft).toBe(2);
    expect(plain(t1.title)).toBe("Fyll på Black Bolt i Automat 1");
    expect(plain(t1.detail)).toContain("7 pack kvar räcker ca 2,3 dagar vid 3,0 pack per dag");
    expect(t1.action?.label).toBe("Registrera påfyllning");
    expect(t1.action?.params).toEqual({ machineId: "m1", titleId: "t1" });
    expect(t1.evidence.period).toEqual({ start: "2026-10-19", end: "2026-11-01" });
    expect(t1.evidence.orderIds).toHaveLength(42); // dagens 5 order ingår inte
    expect(fig(t1.evidence, "unitsInWindow")).toBe(42);
    expect(fig(t1.evidence, "windowDays")).toBe(14);
    expect(fig(t1.evidence, "revenueInWindowOre")).toBe(205_800);
    expectEvidence(t1.evidence);

    const t3 = find(refill, "refill:m1:t3");
    expect(t3.atStakeOre).toBe(49_000);
    expect(fig(t3.evidence, "daysLeftTenths")).toBe(20);

    const m2 = find(refill, "refill:m2:t2");
    expect(m2.evidence.period).toEqual({ start: "2026-10-29", end: "2026-11-01" });
    expect(fig(m2.evidence, "windowDays")).toBe(4);
    expect(fig(m2.evidence, "unitsInWindow")).toBe(8);
    expect(m2.atStakeOre).toBe(49_000);
  });

  it("nivå 'now' under 1 dag; slut lager → 7 dagars intäkt i risk", () => {
    const withStock = (onHand: number) => ({
      ...base(),
      stock: [{ machineId: "m1", titleId: "t1", onHand }],
    });
    // 2 pack: 2 × 14 × 10 / 42 = 6,67 → 6 tiondelar < 10 → now
    const two = find(computeTodos(withStock(2), NOW), "refill:m1:t1");
    expect(two.level).toBe("now");
    expect(two.daysLeft).toBe(0);
    // 0 pack: i risk = 14 700 × 7 = 102 900
    const zero = find(computeTodos(withStock(0), NOW), "refill:m1:t1");
    expect(zero.level).toBe("now");
    expect(zero.atStakeOre).toBe(102_900);
    expect(plain(zero.title)).toBe("Black Bolt är slut i Automat 1");
  });

  it("avbockning håller nästa dag, men inte efter ny påfyllning", () => {
    const today = computeTodos(base(), NOW);
    const t1 = find(today, "refill:m1:t1");
    const dismissals = [{ key: t1.key, fingerprint: t1.fingerprint }];
    // 3 nov.: fönster 20 okt.–2 nov. = 13 × 3 + 5 = 44 pack; lager 7 → 2,2 dagar, fortfarande 'soon'.
    const next = computeTodos(base(), TOMORROW);
    expect(applyDismissals(next, dismissals).map((t) => t.key)).not.toContain("refill:m1:t1");
    const restocked: TodoInput = {
      ...base(),
      stock: [
        { machineId: "m1", titleId: "t1", onHand: 7, lastRestockedAt: "2026-11-03T07:00:00Z" },
      ],
    };
    expect(
      applyDismissals(computeTodos(restocked, TOMORROW), dismissals).map((t) => t.key),
    ).toContain("refill:m1:t1");
  });
});

// ===========================================================================
// Fall 2: Automat som inte sålt på över 48 timmar
// ===========================================================================

describe("Revision 2: automat som inte sålt", () => {
  // m2: 1 order/dag 18–30 okt. utan tid + sista 31 okt. 09:59Z (10:59 svensk tid) → 48 h 1 min → flaggas.
  //     takt 14 dagar t.o.m. 31 okt.: 14 pack, 68 600 öre → i risk 68 600 × 7 / 14 = 34 300.
  // m3: sista 31 okt. 10:00Z → exakt 48 h → flaggas INTE.
  // m4: ur drift (activeTo 31 okt.) → ingen punkt.  m6: arkiverad → ingen punkt.
  // m5: i drift sedan 30 okt., aldrig sålt (3 dagar) → flaggas.
  const orders: AnalyticsOrder[] = [
    ...daily("t1", "m2", "2026-10-18", 13, 1),
    order({
      id: "o-m2-last",
      titleId: "t1",
      machineId: "m2",
      businessDate: "2026-10-31",
      orderedAt: "2026-10-31T09:59:00Z",
    }),
    order({
      titleId: "t1",
      machineId: "m3",
      businessDate: "2026-10-31",
      orderedAt: "2026-10-31T10:00:00Z",
    }),
    order({
      titleId: "t1",
      machineId: "m4",
      businessDate: "2026-10-20",
      orderedAt: "2026-10-20T10:00:00Z",
    }),
    order({
      titleId: "t1",
      machineId: "m6",
      businessDate: "2026-10-20",
      orderedAt: "2026-10-20T10:00:00Z",
    }),
    order({
      titleId: "t1",
      machineId: "m1",
      businessDate: "2026-11-02",
      orderedAt: "2026-11-02T08:00:00Z",
    }),
  ];
  const data = (): TodoInput =>
    input({
      titles: [title("t1", "Black Bolt")],
      machines: [
        machine("m1", "Automat 1"),
        machine("m2", "Automat 2"),
        machine("m3", "Automat 3"),
        machine("m4", "Automat 4", { activeTo: "2026-10-31" }),
        machine("m5", "Automat 5", { activeFrom: "2026-10-30" }),
        machine("m6", "Automat 6", { archived: true }),
      ],
      orders,
      prices: [{ titleId: "t1", unitCostOre: 2_000, validFrom: "2026-01-01" }],
    });

  it("flaggar över 48 h med senaste ordertid i svensk tid; exakt 48 h och inaktiva flaggas inte", () => {
    const stale = byKind(computeTodos(data(), NOW), "stale-machine");
    expect(stale.map((t) => t.key).sort()).toEqual(["stale-machine:m2", "stale-machine:m5"]);

    const m2 = find(stale, "stale-machine:m2");
    expect(plain(m2.title)).toBe("Automat 2 har inte sålt på 48 timmar");
    expect(plain(m2.detail)).toBe(
      "Senaste order 31 okt. 10:59 (Black Bolt). Den brukar sälja 1,0 pack och 49 kr per dag.",
    );
    expect(m2.atStakeOre).toBe(34_300);
    expect(m2.level).toBe("now");
    expect(m2.fingerprint).toBe("o-m2-last");
    expect(m2.evidence.orderIds).toContain("o-m2-last");
    expect(m2.evidence.machineIds).toEqual(["m2"]);
    expect(fig(m2.evidence, "silentHours")).toBe(48);
    expect(m2.link.startsWith("/automater/m2")).toBe(true);
    expectEvidence(m2.evidence);

    const m5 = find(stale, "stale-machine:m5");
    expect(plain(m5.title)).toBe("Automat 5 har inte sålt något sedan driftstart");
    expectEvidence(m5.evidence);
  });

  it("49 h efter senaste order: '49 timmar'; 72 h: '3 dygn'", () => {
    const at = (iso: string) => plain(find(computeTodos(data(), iso), "stale-machine:m3").title);
    expect(at("2026-11-02T11:00:00Z")).toBe("Automat 3 har inte sålt på 49 timmar");
    expect(at("2026-11-03T10:00:00Z")).toBe("Automat 3 har inte sålt på 3 dygn");
  });
});

// ===========================================================================
// Fall 3: Dubbla eller felstavade titlar
// ===========================================================================

describe("Revision 3: dubbletter", () => {
  // Black Bolt (3 order) / Black bolt (1 order, 1 nov.) → slå ihop t2 in i t1.
  //   i risk = 4 900 × 7 / 30 = 1 143,3 → 1 143
  // Surging Sparks / Surgin Sparks → felstavning (1 tecken) → föreslås.
  // Pokémon 151 / Pokemon 151 → lika efter normalisering; lika antal order → behåll lägst id (t9).
  // Mystery Pack / Mystery pack premium → extra ord → INTE.
  // Series 1 / Series 2 → olika siffror → INTE.
  // Arkiverad "Black Bolt" → tas inte med.
  const data = (): TodoInput =>
    input({
      titles: [
        title("t1", "Black Bolt"),
        title("t2", "Black bolt"),
        title("t3", "Mystery Pack"),
        title("t4", "Mystery pack premium"),
        title("t5", "Surging Sparks"),
        title("t6", "Surgin Sparks"),
        title("t7", "Series 1"),
        title("t8", "Series 2"),
        title("t9", "Pokémon 151"),
        title("ta", "Pokemon 151"),
        title("tz", "Black Bolt", { archived: true }),
      ],
      orders: [
        ...many(3, { titleId: "t1", businessDate: "2026-10-30" }),
        order({ titleId: "t2", businessDate: "2026-11-01" }),
        ...many(2, { titleId: "t5", businessDate: "2026-10-30" }),
        order({ titleId: "t6", businessDate: "2026-10-30" }),
      ],
    });

  it("föreslår rätt par och slår ihop den mindre in i den större", () => {
    const dups = byKind(computeTodos(data(), NOW), "duplicate-title");
    expect(dups.map((t) => t.key).sort()).toEqual([
      "duplicate-title:t1:t2",
      "duplicate-title:t5:t6",
      "duplicate-title:t9:ta",
    ]);
    const bb = find(dups, "duplicate-title:t1:t2");
    expect(plain(bb.title)).toBe('Slå ihop "Black bolt" med "Black Bolt"');
    expect(bb.action?.params).toEqual({ fromTitleId: "t2", intoTitleId: "t1" });
    expect(bb.atStakeOre).toBe(1_143);
    expect(bb.level).toBe("later");
    expect(bb.evidence.titleIds).toEqual(["t1", "t2"]);
    expect(bb.evidence.orderIds).toHaveLength(4);
    expectEvidence(bb.evidence);

    expect(find(dups, "duplicate-title:t5:t6").action?.params).toEqual({
      fromTitleId: "t6",
      intoTitleId: "t5",
    });
    expect(find(dups, "duplicate-title:t9:ta").action?.params).toEqual({
      fromTitleId: "ta",
      intoTitleId: "t9",
    });
  });
});

// ===========================================================================
// Fall 4: Saknat inköpspris och avbockningens livslängd
// ===========================================================================

describe("Revision 4: titlar utan inköpspris", () => {
  // Fönster 4 okt.–2 nov. (30 dagar).
  //  30th Celebration: 6 order med pris.  Mystery Pack: 4 order utan pris (+1 gammal 1 sep., utanför).
  //  Black Bolt: 1 order utan pris.  All intäkt = 11 × 4 900 = 53 900.
  //  Mystery Pack: 19 600 / 53 900 = 3 636 bp → "36 %", nivå soon (≥ 10 %), i risk 19 600 × 7/30 = 4 573.
  //  Black Bolt: 4 900 / 53 900 = 909 bp → "9 %", nivå later, i risk 1 143.
  const data = (): TodoInput =>
    input({
      titles: [
        title("tA", "30th Celebration"),
        title("tB", "Mystery Pack"),
        title("tC", "Black Bolt"),
      ],
      prices: [{ titleId: "tA", unitCostOre: 2_000, validFrom: "2026-01-01" }],
      orders: [
        ...daily("tA", "m1", "2026-10-27", 6, 1),
        ...daily("tB", "m1", "2026-10-29", 4, 1),
        order({ titleId: "tB", businessDate: "2026-09-01" }),
        order({ titleId: "tC", businessDate: "2026-11-01" }),
      ],
    });

  it("andel av intäkten, nivå, länk till /inkopspriser och underlag", () => {
    const mp = byKind(computeTodos(data(), NOW), "missing-price");
    expect(mp.map((t) => t.key)).toEqual(["missing-price:tB", "missing-price:tC"]);
    const b = find(mp, "missing-price:tB");
    expect(b.level).toBe("soon");
    expect(b.atStakeOre).toBe(4_573);
    expect(plain(b.detail)).toContain("Mystery Pack står för 36 % av intäkten");
    expect(plain(b.detail)).toContain("196 kr, 4 order");
    expect(b.link).toBe("/inkopspriser?titel=tB");
    expect(b.evidence.orderIds).toHaveLength(4);
    expect(fig(b.evidence, "shareBp")).toBe(3_636);
    expect(fig(b.evidence, "totalRevenueOre")).toBe(53_900);
    expectEvidence(b.evidence);
    const c = find(mp, "missing-price:tC");
    expect(c.level).toBe("later");
    expect(fig(c.evidence, "shareBp")).toBe(909);
    expect(c.atStakeOre).toBe(1_143);
  });

  it("punkten försvinner när priset läggs in", () => {
    const priced: TodoInput = {
      ...data(),
      prices: [
        { titleId: "tA", unitCostOre: 2_000, validFrom: "2026-01-01" },
        { titleId: "tB", unitCostOre: 2_000, validFrom: "2026-01-01" },
      ],
    };
    expect(computeTodos(priced, NOW).map((t) => t.key)).not.toContain("missing-price:tB");
  });

  it("avbockning gäller tills orsaken ändras: titel som sålt utan pris i över 30 dagar ska vara dold även i morgon", () => {
    // Mystery Pack säljer 1 per dag utan pris sedan 1 sep. Orsaken (inget pris) är oförändrad
    // från 2 nov. till 3 nov.; avbockningen ska därför fortsätta gälla.
    const longRunning: TodoInput = {
      ...data(),
      orders: [
        ...daily("tA", "m1", "2026-09-01", 64, 1),
        ...daily("tB", "m1", "2026-09-01", 64, 1), // 1 sep.–3 nov.
      ],
    };
    const today = find(computeTodos(longRunning, NOW), "missing-price:tB");
    const dismissals = [{ key: today.key, fingerprint: today.fingerprint }];
    const tomorrow = applyDismissals(computeTodos(longRunning, TOMORROW), dismissals);
    expect(tomorrow.map((t) => t.key)).not.toContain("missing-price:tB");
  });
});

// ===========================================================================
// Fall 5: Rapporter som ska skickas denna månad
// ===========================================================================

describe("Revision 5: rapporter", () => {
  const recipients: ReportRecipientRef[] = [
    { id: "r1", name: "Anna", kind: "store", storeId: "s1", active: true }, // inget utskick → punkt
    { id: "r2", name: "Bo", kind: "accountant", storeId: null, active: true }, // skickad → klar
    { id: "r3", name: "Cia", kind: "partner", storeId: null, active: true }, // misslyckad → punkt
    { id: "r4", name: "Dan", kind: "accountant", storeId: null, active: false }, // inaktiv
    { id: "r5", name: "Eva", kind: "store", storeId: "s2", active: true }, // ingen automat i okt.
    { id: "r6", name: "Fia", kind: "store", storeId: "s1", active: true }, // köad → klar
    { id: "r7", name: "Gun", kind: "partner", storeId: null, active: true }, // bara sept. → punkt
  ];
  const oct = { periodStart: "2026-10-01", periodEnd: "2026-10-31" } as const;
  const deliveries: ReportDeliveryRef[] = [
    {
      id: "d2",
      recipientId: "r2",
      reportKind: "accountant_statement",
      ...oct,
      storeId: null,
      status: "sent",
    },
    {
      id: "d3",
      recipientId: "r3",
      reportKind: "owner_statement",
      ...oct,
      storeId: null,
      status: "failed",
      sentAt: "2026-11-01T09:00:00Z",
    },
    {
      id: "d6",
      recipientId: "r6",
      reportKind: "store_statement",
      ...oct,
      storeId: "s1",
      status: "queued",
    },
    {
      id: "d7",
      recipientId: "r7",
      reportKind: "owner_statement",
      periodStart: "2026-09-01",
      periodEnd: "2026-09-30",
      storeId: null,
      status: "delivered",
    },
  ];
  const data = (reportDueDay: number | null = null): TodoInput =>
    input({
      stores: [
        { id: "s1", name: "ICA Nära" },
        { id: "s2", name: "Coop Forum" },
      ],
      placements: [
        { machineId: "m1", storeId: "s1", from: "2026-01-01", to: null },
        { machineId: "m2", storeId: "s2", from: "2026-11-01", to: null },
      ],
      reportRecipients: recipients,
      reportDeliveries: deliveries,
      options: { reportDueDay },
    });

  it("förra månadens rapport till varje aktiv mottagare som inte fått den", () => {
    const rep = byKind(computeTodos(data(), NOW), "report-due");
    expect(rep.map((t) => t.key)).toEqual([
      "report-due:r1:2026-10",
      "report-due:r3:2026-10",
      "report-due:r7:2026-10",
    ]);
    const r1 = find(rep, "report-due:r1:2026-10");
    expect(plain(r1.title)).toBe("Skicka butiksrapporten för oktober till Anna (ICA Nära)");
    expect(plain(r1.detail)).toBe("Ska skickas senast 30 nov. (28 dagar kvar).");
    expect(r1.level).toBe("later");
    expect(r1.daysLeft).toBe(28);
    expect(r1.evidence.recipientIds).toEqual(["r1"]);
    expect(r1.evidence.period).toEqual({ start: "2026-10-01", end: "2026-10-31" });
    expectEvidence(r1.evidence);
    const r3 = find(rep, "report-due:r3:2026-10");
    expect(plain(r3.detail)).toContain("Senaste utskicket misslyckades 1 nov.");
    expect(plain(r3.title)).toBe("Skicka ägarrapporten för oktober till Cia");
  });

  it("reportDueDay 5: 3 dagar kvar → 'soon'; efter 5 nov. → 'now'", () => {
    const soon = find(computeTodos(data(5), NOW), "report-due:r1:2026-10");
    expect(soon.daysLeft).toBe(3);
    expect(soon.level).toBe("soon");
    const late = find(computeTodos(data(5), "2026-11-06T10:00:00Z"), "report-due:r1:2026-10");
    expect(late.level).toBe("now");
    expect(plain(late.detail)).toContain("Skulle ha skickats senast 5 nov.");
  });
});

// ===========================================================================
// Fall 6: Sortering efter brådska över alla regler, och oberoende av processens tidszon
// ===========================================================================

describe("Revision 6: sortering och tidszon", () => {
  const data = (): TodoInput =>
    input({
      titles: [title("t1", "Black Bolt"), title("t3", "30th Celebration")],
      machines: [machine("m1", "Automat 1"), machine("m2", "Automat 2")],
      placements: [
        { machineId: "m1", storeId: "s1", from: "2026-01-01", to: null },
        { machineId: "m2", storeId: "s1", from: "2026-01-01", to: null },
      ],
      prices: [
        { titleId: "t1", unitCostOre: 2_000, validFrom: "2026-01-01" },
        { titleId: "t3", unitCostOre: 2_000, validFrom: "2026-01-01" },
      ],
      orders: [
        ...daily("t1", "m1", "2026-10-19", 14, 3),
        ...daily("t3", "m1", "2026-10-19", 14, 2),
        ...daily("t1", "m2", "2026-10-18", 13, 1),
        order({
          titleId: "t1",
          machineId: "m2",
          businessDate: "2026-10-31",
          orderedAt: "2026-10-31T09:59:00Z",
        }),
      ],
      stock: [
        { machineId: "m1", titleId: "t1", onHand: 0 }, // now, 102 900
        { machineId: "m1", titleId: "t3", onHand: 4 }, // soon, 49 000
      ],
      reportRecipients: [
        { id: "r1", name: "Anna", kind: "store", storeId: "s1", active: true }, // later
      ],
    });

  it("now (störst belopp först) → soon → later", () => {
    const keys = computeTodos(data(), NOW).map((t) => t.key);
    // refill now 102 900 > stale now 34 300 > refill soon 49 000 > rapport later
    expect(keys).toEqual([
      "refill:m1:t1",
      "stale-machine:m2",
      "refill:m1:t3",
      "report-due:r1:2026-10",
    ]);
  });

  it("samma resultat i UTC, Asia/Shanghai och America/Los_Angeles som i Stockholm", () => {
    const original = process.env.TZ;
    try {
      const fixed = data(); // samma order-id i alla körningar
      const reference = JSON.stringify(computeTodos(fixed, NOW));
      for (const tz of ["UTC", "Asia/Shanghai", "America/Los_Angeles", "Pacific/Kiritimati"]) {
        process.env.TZ = tz;
        expect(JSON.stringify(computeTodos(fixed, NOW))).toBe(reference);
      }
    } finally {
      process.env.TZ = original;
    }
  });
});

// ===========================================================================
// Fall 7: Värt att veta – alla regler i ett scenario, plus fall där de inte ska slå till
// ===========================================================================

describe("Revision 7: Värt att veta", () => {
  // Period mån 26 okt.–sön 1 nov., jämförelse 19–25 okt. Alla order 49 kr, provision 10 %.
  //  Mystery Pack (tM): 10 → 15 pack: +50 %, diff 5 → ökning. Poäng 5 000 + 1 000 + 25 = 6 025.
  //  Black Bolt (tB):  20 → 12 pack: −40 %, diff 8 → minskning. Poäng 5 000 + 800 + 32 = 5 832.
  //     Inköp 45 kr: kvar = 49 − 4,90 − 45 = −0,90 kr/pack → förlust. Poäng 9 000 + 12 = 9 012.
  //  Noise (tN): 4 → 12 pack: under 10 i jämförelsen → ingen förändringsregel.
  //  Koncentration: tM 73 500 / 191 100 = 3 846 bp → "38 %". Poäng 4 000 + 269 = 4 269.
  //  Bästa dag lör 31 okt.: 16 order, 78 400 öre; snittdag 27 300; kvot 28 718 bp. Poäng 4 372.
  //  Automat 2 sålde 1/dag 5–18 okt. (14 pack på 14 dagar) och sedan inget: 14 dagar tyst,
  //  1 × 14 = 14 pack uteblivna. Poäng 8 000 + 10 × 14 = 8 140.
  const P = { start: "2026-10-26", end: "2026-11-01" } as const;
  const C = { start: "2026-10-19", end: "2026-10-25" } as const;
  const days = [
    "2026-10-26",
    "2026-10-27",
    "2026-10-28",
    "2026-10-29",
    "2026-10-30",
    "2026-10-31",
    "2026-11-01",
  ] as const;
  const spread = (titleId: string, counts: number[], dates: readonly string[]) =>
    counts.flatMap((n, i) =>
      many(n, {
        titleId,
        machineId: "m1",
        businessDate: dates[i] as `${number}-${number}-${number}`,
      }),
    );
  const cdays = [
    "2026-10-19",
    "2026-10-20",
    "2026-10-21",
    "2026-10-22",
    "2026-10-23",
    "2026-10-24",
    "2026-10-25",
  ] as const;
  const build = (over: Partial<{ tMnow: number[] }> = {}) =>
    input({
      titles: [title("tM", "Mystery Pack"), title("tB", "Black Bolt"), title("tN", "Noise")],
      machines: [machine("m1", "Automat 1"), machine("m2", "Automat 2")],
      placements: [
        { machineId: "m1", storeId: "s1", from: "2026-01-01", to: null },
        { machineId: "m2", storeId: "s1", from: "2026-01-01", to: null },
      ],
      prices: [
        { titleId: "tM", unitCostOre: 2_000, validFrom: "2026-01-01" },
        { titleId: "tB", unitCostOre: 4_500, validFrom: "2026-01-01" },
        { titleId: "tN", unitCostOre: 2_000, validFrom: "2026-01-01" },
      ],
      orders: [
        ...spread("tM", over.tMnow ?? [2, 2, 2, 2, 2, 3, 2], days),
        ...spread("tB", [2, 2, 2, 2, 2, 1, 1], days),
        ...spread("tN", [0, 0, 0, 0, 0, 12, 0], days),
        ...spread("tM", [2, 2, 2, 2, 2, 0, 0], cdays),
        ...spread("tB", [3, 3, 3, 3, 3, 3, 2], cdays),
        ...spread("tN", [1, 1, 1, 1, 0, 0, 0], cdays),
        ...daily("tB", "m2", "2026-10-05", 14, 1),
      ],
    });

  it("väljer de fyra med högst poäng, med rätt texter och underlag", () => {
    const all = evaluateInsights(build(), P, C);
    const score = (k: string) => all.find((i) => i.key === k)?.score;
    expect(score("loss-title:tB")).toBe(9_012);
    expect(score("stale-machine:m2")).toBe(8_140);
    expect(score("title-up:tM")).toBe(6_025);
    expect(score("title-down:tB")).toBe(5_832);
    expect(score("best-day:2026-10-31")).toBe(4_372);
    expect(score("concentration:tM")).toBe(4_269);
    expect(all.some((i) => i.kind === "weekday-pattern")).toBe(false); // 7 dagar < 28

    const shown = computeInsights(build(), P, C);
    expect(shown.map((i) => i.key)).toEqual([
      "loss-title:tB",
      "stale-machine:m2",
      "title-up:tM",
      "title-down:tB",
    ]);
    const text = (k: string) => plain(all.find((i) => i.key === k)?.text ?? "");
    expect(text("loss-title:tB")).toBe("Black Bolt går med förlust: −0,90 kr per pack");
    expect(text("stale-machine:m2")).toBe("Automat 2 har inte sålt på 14 dagar");
    expect(text("title-up:tM")).toBe("Mystery Pack säljer 50 % mer än förra veckan");
    expect(text("title-down:tB")).toBe("Black Bolt säljer 40 % mindre än förra veckan");
    expect(text("concentration:tM")).toBe("Mystery Pack står för 38 % av intäkten");
    expect(text("best-day:2026-10-31")).toBe("Lördag 31 okt. var bästa dagen med 784 kr");

    for (const i of all) {
      expectEvidence(i.evidence);
      expect(i.link.startsWith("/")).toBe(true);
      expect(i.score).toBeGreaterThanOrEqual(0);
      expect(i.score).toBeLessThanOrEqual(10_000);
    }
    const best = all.find((i) => i.kind === "best-day") as Insight;
    expect(best.evidence.orderIds).toHaveLength(16);
    expect(plain(best.detail)).toContain("2,9 gånger en genomsnittlig dag (273 kr)");
  });

  it("ökning slår inte till vid 4 packs skillnad (10 → 14)", () => {
    const all = evaluateInsights(build({ tMnow: [2, 2, 2, 2, 2, 2, 2] }), P, C);
    expect(all.some((i) => i.key === "title-up:tM")).toBe(false);
  });

  it("koncentration: 20 order och 3 titlar → ja; 19 order → nej; 2 titlar → nej", () => {
    const w = { start: "2026-10-26", end: "2026-11-01" };
    const mk = (a: number, b: number, c: number) =>
      input({
        titles: [title("a", "30th Celebration"), title("b", "B"), title("c", "C")],
        orders: [
          ...many(a, { titleId: "a", businessDate: "2026-10-27" }),
          ...many(b, { titleId: "b", businessDate: "2026-10-28" }),
          ...many(c, { titleId: "c", businessDate: "2026-10-29" }),
        ],
      });
    const conc = (i: TodoInput) => evaluateInsights(i, w).filter((x) => x.kind === "concentration");
    const yes = conc(mk(10, 5, 5));
    expect(yes.map((x) => plain(x.text))).toEqual(["30th Celebration står för 50 % av intäkten"]);
    expect(conc(mk(9, 5, 5))).toEqual([]);
    expect(conc(mk(15, 5, 0))).toEqual([]);
  });

  it("veckodagsmönster: 28 dagar och 40 order → ja (+180 %); 39 order → nej", () => {
    // 5 okt. (mån)–1 nov. (sön): 1 order/dag (28) + 3 extra varje lördag (12) = 40.
    // Lördag i snitt 4 × 4 900 = 19 600; snittdag 196 000 / 28 = 7 000 → +180 %.
    const w = { start: "2026-10-05", end: "2026-11-01" };
    const sats = ["2026-10-10", "2026-10-17", "2026-10-24", "2026-10-31"] as const;
    const mk = (skipOne: boolean) =>
      input({
        titles: [title("a", "A")],
        orders: [
          ...daily("a", "m1", "2026-10-05", 28, 1).slice(skipOne ? 1 : 0),
          ...sats.flatMap((d) => many(3, { titleId: "a", businessDate: d })),
        ],
      });
    const wd = (i: TodoInput) => evaluateInsights(i, w).filter((x) => x.kind === "weekday-pattern");
    expect(wd(mk(false)).map((x) => plain(x.text))).toEqual([
      "Lördagar ger 180 % mer intäkt än en genomsnittlig dag",
    ]);
    expect(wd(mk(true))).toEqual([]);
  });

  it("förlust: exakt 0 kr kvar slår till, 0,01 kr kvar och 2 order gör det inte", () => {
    const w = { start: "2026-10-26", end: "2026-11-01" };
    const mk = (cost: number, n: number) =>
      input({
        titles: [title("a", "Black Bolt")],
        prices: [{ titleId: "a", unitCostOre: cost, validFrom: "2026-01-01" }],
        orders: many(n, { titleId: "a", businessDate: "2026-10-27" }),
      });
    const loss = (i: TodoInput) => evaluateInsights(i, w).filter((x) => x.kind === "loss-title");
    // 4 900 − 490 − 4 410 = 0
    expect(loss(mk(4_410, 3)).map((x) => plain(x.text))).toEqual([
      "Black Bolt går jämnt ut: 0,00 kr kvar per pack",
    ]);
    expect(loss(mk(4_409, 3))).toEqual([]);
    expect(loss(mk(4_500, 2))).toEqual([]);
  });

  it("stillastående: 1 dag tyst → nej; låg takt (1 pack på 14 dagar) → nej", () => {
    const w = { start: "2026-10-26", end: "2026-11-01" };
    const mk = (orders: AnalyticsOrder[]) =>
      input({ titles: [title("a", "A")], machines: [machine("m1", "Automat 1")], orders });
    const st = (i: TodoInput) => evaluateInsights(i, w).filter((x) => x.kind === "stale-machine");
    expect(st(mk(daily("a", "m1", "2026-10-18", 14, 3)))).toEqual([]); // sista 31 okt.
    expect(st(mk([order({ titleId: "a", machineId: "m1", businessDate: "2026-10-20" })]))).toEqual(
      [],
    );
    expect(st(mk(daily("a", "m1", "2026-10-17", 14, 3))).map((x) => plain(x.text))).toEqual([
      "Automat 1 har inte sålt på 2 dagar",
    ]);
  });

  it("bästa dag: 4 order den dagen → nej", () => {
    const w = { start: "2026-10-26", end: "2026-11-01" };
    const i = input({
      titles: [title("a", "A")],
      orders: [
        ...many(4, { titleId: "a", businessDate: "2026-10-31" }),
        order({ titleId: "a", businessDate: "2026-10-27" }),
      ],
    });
    expect(evaluateInsights(i, w).filter((x) => x.kind === "best-day")).toEqual([]);
  });

  it("samma iakttagelser oberoende av processens tidszon", () => {
    const original = process.env.TZ;
    try {
      const fixed = build(); // samma order-id i alla körningar
      const reference = JSON.stringify(computeInsights(fixed, P, C));
      for (const tz of ["UTC", "Asia/Shanghai", "America/Los_Angeles"]) {
        process.env.TZ = tz;
        expect(JSON.stringify(computeInsights(fixed, P, C))).toBe(reference);
      }
    } finally {
      process.env.TZ = original;
    }
  });
});

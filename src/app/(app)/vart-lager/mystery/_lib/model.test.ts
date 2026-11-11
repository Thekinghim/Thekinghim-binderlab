import { describe, expect, it } from "vitest";

import {
  averageCost,
  batchesForPacks,
  checkDraft,
  defaultPlace,
  listText,
  maxBatches,
  mysteryCalc,
  packPlan,
  recipeOdds,
  shortages,
  type Recipe,
  type SlotFacts,
} from "./model";

/** Mystery Pack Plus 179 kr: 14 per omgång, två HIT-rader (3 av 14). */
const PLUS: Recipe = {
  id: "r1",
  titleId: "mp",
  version: 1,
  validFrom: "2026-11-08",
  batchSize: 14,
  note: null,
  items: [
    { titleId: "pf", name: "Phantasmal Flames", quantity: 4, hit: false },
    { titleId: "dr", name: "Delta Reign", quantity: 3, hit: false },
    { titleId: "ds", name: "Destined Rivals", quantity: 2, hit: false },
    { titleId: "ss", name: "Surging Sparks", quantity: 2, hit: false },
    { titleId: "ah", name: "Ascended Heroes", quantity: 2, hit: true },
    { titleId: "pe", name: "Prismatic Evolutions", quantity: 1, hit: true },
  ],
};

describe("recipeOdds", () => {
  it("räknar chans till hit och per rad i baspunkter", () => {
    const odds = recipeOdds(PLUS);
    expect(odds.hits).toBe(3);
    expect(odds.hitBp).toBe(2143); // 3/14 = 21,43 %
    expect(odds.items.map((i) => i.bp)).toEqual([2857, 2143, 1429, 1429, 1429, 714]);
  });

  it("utan hit är chansen 0", () => {
    const odds = recipeOdds({ batchSize: 2, items: [{ ...PLUS.items[0]!, quantity: 2 }] });
    expect(odds.hits).toBe(0);
    expect(odds.hitBp).toBe(0);
  });
});

describe("averageCost", () => {
  const prices = new Map([
    ["pf", 6000],
    ["dr", 5500],
    ["ds", 7000],
    ["ss", 6500],
    ["ah", 12000],
    ["pe", 15000],
  ]);

  it("snittet per pack är summan för omgången delat med storleken", () => {
    // 4×60 + 3×55 + 2×70 + 2×65 + 2×120 + 1×150 = 1 065 kr → 76,07 kr per pack.
    const cost = averageCost(PLUS, prices);
    expect(cost.perBatchOre).toBe(106_500);
    expect(cost.perPackOre).toBe(7607);
    expect(cost.missing).toEqual([]);
  });

  it("saknar en del pris finns inget snitt, och delen nämns", () => {
    const partial = new Map(prices);
    partial.delete("dr");
    const cost = averageCost(PLUS, partial);
    expect(cost.perPackOre).toBeNull();
    expect(cost.missing).toEqual(["Delta Reign"]);
  });
});

describe("maxBatches", () => {
  it("räknar hela omgångar och nämner delen som tar slut först", () => {
    const stock = { pf: 20, dr: 6, ds: 10, ss: 10, ah: 10, pe: 5 };
    const cap = maxBatches(PLUS, stock);
    expect(cap.batches).toBe(2); // 6 Delta Reign räcker till 2 omgångar
    expect(cap.limiting?.name).toBe("Delta Reign");
  });

  it("lika: den som står först i innehållet", () => {
    const cap = maxBatches(PLUS, { pf: 4, dr: 3, ds: 2, ss: 2, ah: 2, pe: 1 });
    expect(cap.batches).toBe(1);
    expect(cap.limiting?.name).toBe("Phantasmal Flames");
  });

  it("saknas en del helt (eller är minus) går det inte att packa", () => {
    const cap = maxBatches(PLUS, { pf: 40, dr: 30, ds: 20, ss: 20, ah: -3 });
    expect(cap.batches).toBe(0);
    expect(cap.limiting?.name).toBe("Ascended Heroes");
  });

  it("utan rader: 0 och ingen begränsning", () => {
    expect(maxBatches({ items: [] }, {})).toEqual({ batches: 0, limiting: null });
  });
});

describe("packPlan och shortages", () => {
  it("två omgångar tar dubbelt och lägger till 28", () => {
    const plan = packPlan(PLUS, 2);
    expect(plan.packs).toBe(28);
    expect(plan.takes.map((t) => t.quantity)).toEqual([8, 6, 4, 4, 4, 2]);
    expect(plan.takes.reduce((n, t) => n + t.quantity, 0)).toBe(plan.packs);
  });

  it("visar vad som fattas och hur många", () => {
    const missing = shortages(PLUS, 2, { pf: 8, dr: 4, ds: 4, ss: 4, ah: 4 });
    expect(missing).toEqual([
      { titleId: "dr", name: "Delta Reign", quantity: 2 },
      { titleId: "pe", name: "Prismatic Evolutions", quantity: 2 },
    ]);
    expect(listText(missing)).toBe("2 Delta Reign och 2 Prismatic Evolutions");
  });
});

describe("batchesForPacks", () => {
  it("avrundar uppåt och håller sig inom 1–10", () => {
    expect(batchesForPacks(28, 14)).toBe(2);
    expect(batchesForPacks(15, 14)).toBe(2);
    expect(batchesForPacks(0, 14)).toBe(1);
    expect(batchesForPacks(500, 14)).toBe(10);
  });
});

describe("defaultPlace", () => {
  const places = [
    { id: "hem", name: "Hemma", isDefault: true },
    { id: "kontor", name: "Kontoret", isDefault: false },
  ];

  it("väljer lagret med flest delar", () => {
    const pick = defaultPlace(PLUS, places, { hem: { pf: 2 }, kontor: { pf: 4, dr: 3 } });
    expect(pick?.id).toBe("kontor");
  });

  it("lika: standardlagret", () => {
    expect(defaultPlace(PLUS, [...places].reverse(), {})?.id).toBe("hem");
  });
});

describe("checkDraft", () => {
  const items = PLUS.items.map((i) => ({ titleId: i.titleId, quantity: i.quantity, hit: i.hit }));

  it("godkänner när summan är omgångens storlek", () => {
    expect(checkDraft(14, items)).toEqual({ ok: true, sum: 14, error: null });
  });

  it("säger hur många som fattas eller är för många", () => {
    expect(checkDraft(15, items).error).toBe("1 kvar att lägga till.");
    expect(checkDraft(13, items).error).toBe("1 för många.");
  });

  it("minst en rad, ingen dubblett, ingen tom rad", () => {
    expect(checkDraft(14, []).error).toBe("Lägg till minst en titel.");
    expect(checkDraft(8, [items[0]!, items[0]!]).error).toBe("Samma titel står två gånger.");
    expect(checkDraft(4, [{ titleId: "", quantity: 4, hit: false }]).error).toBe(
      "Välj en titel på varje rad.",
    );
  });
});

describe("mysteryCalc", () => {
  /** Mystery pack premium: ägarens recept, 14 per omgång. */
  const items = [
    { titleId: "fusion", name: "Fusion Strike", quantity: 4 },
    { titleId: "celebration", name: "30th Celebration", quantity: 3 },
    { titleId: "flames", name: "Phantasmal Flames", quantity: 4 },
    { titleId: "prismatic", name: "Prismatic Evolution", quantity: 1 },
    { titleId: "heroes", name: "Ascended Heroes", quantity: 1 },
    { titleId: "hit", name: "Hit", quantity: 1, hit: true },
  ];
  const prices = {
    fusion: 22_000,
    celebration: 25_000,
    flames: 15_000,
    prismatic: 30_000,
    heroes: 20_000,
    hit: 25_200,
  };
  const fees = { vatRateBp: 0, cardFeeBp: 0 };

  it("kostnad per omgång och pack, pris, vinst och marginal", () => {
    const calc = mysteryCalc(14, items, prices, 29_900, fees);
    expect(calc).toMatchObject({
      complete: true,
      quantity: 14,
      perBatchOre: 298_200,
      perPackOre: 21_300,
      salePriceOre: 29_900,
      profitOre: 8_600,
      marginBp: 2_876,
      missing: [],
    });
    expect(calc.lines[0]).toEqual({
      titleId: "fusion",
      name: "Fusion Strike",
      quantity: 4,
      hit: false,
      unitCostOre: 22_000,
      totalOre: 88_000,
    });
    expect(calc.lines.at(-1)?.hit).toBe(true);
  });

  it("samma kostnad per pack som averageCost (en formel)", () => {
    const recipe = { batchSize: 14, items: items.map((i) => ({ ...i, hit: i.hit === true })) };
    expect(mysteryCalc(14, items, prices, null, fees).perPackOre).toBe(
      averageCost(recipe, new Map(Object.entries(prices))).perPackOre,
    );
  });

  it("vad händer om: byt en Fusion Strike mot en Phantasmal Flames", () => {
    const draft = items.map((i) =>
      i.titleId === "fusion"
        ? { ...i, quantity: 3 }
        : i.titleId === "flames"
          ? { ...i, quantity: 5 }
          : i,
    );
    const calc = mysteryCalc(14, draft, prices, 29_900, fees);
    // 70 kr billigare omgång → 5 kr per pack.
    expect(calc.perBatchOre).toBe(291_200);
    expect(calc.perPackOre).toBe(20_800);
    expect(calc.profitOre).toBe(9_100);
  });

  it("antalen går inte jämnt ut: ingen kostnad per pack visas", () => {
    const draft = items.map((i) => (i.titleId === "fusion" ? { ...i, quantity: 5 } : i));
    const calc = mysteryCalc(14, draft, prices, 29_900, fees);
    expect(calc).toMatchObject({
      complete: false,
      quantity: 15,
      perPackOre: null,
      perBatchOre: null,
      profitOre: null,
    });
  });

  it("en del saknar pris: namnet står under saknas, ingen vinst", () => {
    const calc = mysteryCalc(14, items, { ...prices, hit: undefined as never }, 29_900, fees);
    expect(calc.missing).toEqual(["Hit"]);
    expect(calc.perPackOre).toBeNull();
    expect(calc.profitOre).toBeNull();
  });

  it("inget köp än: kostnaden visas men ingen vinst", () => {
    const calc = mysteryCalc(14, items, prices, null, fees);
    expect(calc.perPackOre).toBe(21_300);
    expect(calc.profitOre).toBeNull();
    expect(calc.marginBp).toBeNull();
  });

  it("moms och kortavgift dras som i liggaren", () => {
    const calc = mysteryCalc(14, items, prices, 29_900, { vatRateBp: 2_500, cardFeeBp: 250 });
    // moms 59,80, netto 239,20, kortavgift 7,48 → 239,20 − 7,48 − 213 = 18,72.
    expect(calc.profitOre).toBe(1_872);
  });

  it("ogiltiga antal i utkastet (tomt fält) räknas som 0", () => {
    const draft = items.map((i) => (i.titleId === "hit" ? { ...i, quantity: Number.NaN } : i));
    expect(mysteryCalc(14, draft, prices, null, fees)).toMatchObject({
      quantity: 13,
      complete: false,
    });
  });
});

describe("minusFix (påfyllt utan att trycka Packa)", () => {
  it("−14 med 14 per omgång: packa 1 omgång", async () => {
    const { minusFix } = await import("./model");
    expect(minusFix(-14, 14)).toEqual({ kind: "pack", batches: 1, packs: 14 });
    expect(minusFix(-28, 14)).toEqual({ kind: "pack", batches: 2, packs: 28 });
  });

  it("−1 eller −15: räkna om lagret", async () => {
    const { minusFix } = await import("./model");
    expect(minusFix(-1, 14)).toEqual({ kind: "count" });
    expect(minusFix(-15, 14)).toEqual({ kind: "count" });
  });

  it("fler omgångar än Packa klarar, eller okänd omgång: räkna om", async () => {
    const { minusFix, MAX_BATCHES } = await import("./model");
    expect(minusFix(-14 * (MAX_BATCHES + 1), 14)).toEqual({ kind: "count" });
    expect(minusFix(-14, null)).toEqual({ kind: "count" });
  });

  it("0 eller mer: inget att rätta", async () => {
    const { minusFix } = await import("./model");
    expect(minusFix(0, 14)).toBeNull();
    expect(minusFix(9, 14)).toBeNull();
  });

  it("länkarna: packa i just det lagret, och inventeringen av det", async () => {
    const { packInPlaceHref, countHref } = await import("./model");
    expect(packInPlaceHref("t1", "p1", 14)).toBe("/vart-lager/mystery/t1?packa=14&lager=p1#packa");
    expect(countHref("p1")).toBe("/vart-lager/inventering?lager=p1");
  });
});

describe("Packa N omgångar före en dag (räknat från facken)", () => {
  const TODAY = "2026-11-10"; // tisdag
  const facts = (over: Partial<SlotFacts> = {}): SlotFacts => ({
    machineId: "m1",
    label: "BL-001",
    onHand: 9,
    sold: 42, // 3 om dagen i 14 dagar
    everSold: true,
    ...over,
  });
  const load = async () => {
    const model = await import("./model");
    const { mysteryBatchesToPack } = await import("@/domain");
    const { sv } = await import("@/i18n/sv");
    const { en } = await import("@/i18n/en");
    const plan = (
      list: SlotFacts[],
      packedAtHome = 0,
      weekShareOf?: (id: string) => readonly number[] | null,
    ) =>
      mysteryBatchesToPack({
        batchSize: 14,
        planPacks: 56,
        packedAtHome,
        slots: model.slotInputs(list, TODAY, weekShareOf),
        today: TODAY,
      });
    return { ...model, plan, sv, en };
  };

  it("som i prod: 1 automat, 9 pack i facket, 3 om dagen ger 1 omgång före fredag", async () => {
    const { plan, packSentence, sv } = await load();
    const p = plan([facts()]);
    expect(p).toMatchObject({ batches: 1, packs: 14, before: "2026-11-13" });
    expect(packSentence(p, sv)).toEqual({
      text: "Packa 1 omgång före fredag. BL-001 är tom om ca 3 dagar.",
      tone: "act",
    });
  });

  it("en omgång packad hemma: '1 omgång ligger klar hemma'", async () => {
    const { plan, packSentence, sv } = await load();
    const s = packSentence(plan([facts()], 14), sv);
    expect(s?.tone).toBe("calm");
    expect(s?.text).toBe("1 omgång ligger klar hemma. BL-001 är tom om ca 3 dagar.");
  });

  it("facket räcker längre än veckan: 'Inget att packa den här veckan.'", async () => {
    const { plan, packSentence, sv } = await load();
    expect(packSentence(plan([facts({ onHand: 14, sold: 14 })]), sv)).toEqual({
      text: "Inget att packa den här veckan.",
      tone: "calm",
    });
  });

  it("tomt fack: 'Packa 1 omgång nu. BL-001 är tom.'", async () => {
    const { plan, packSentence, sv } = await load();
    expect(packSentence(plan([facts({ onHand: 0 })]), sv)?.text).toBe(
      "Packa 1 omgång nu. BL-001 är tom.",
    );
  });

  it("ny automat utan historik: 'Ny automat BL-004: packa 1 omgång.'", async () => {
    const { plan, packSentence, sv } = await load();
    const p = plan([facts({ label: "BL-004", onHand: null, sold: 0, everSold: false })]);
    expect(packSentence(p, sv)?.text).toBe("Ny automat BL-004: packa 1 omgång.");
  });

  it("ny automat och ett fack till: antalet gäller båda, inte bara den nya", async () => {
    const { plan, packSentence, sv } = await load();
    const p = plan([
      facts({ machineId: "m4", label: "BL-004", onHand: null, sold: 0, everSold: false }),
      facts(),
    ]);
    expect(packSentence(p, sv)?.text).toBe(
      "Packa 2 omgångar nu. BL-004 är ny och tom. 1 automat till blir tom i veckan.",
    );
  });

  it("tom i morgon: packa i dag", async () => {
    const { plan, packSentence, sv } = await load();
    expect(packSentence(plan([facts({ onHand: 3 })]), sv)?.text).toBe(
      "Packa 1 omgång i dag. BL-001 är tom i morgon.",
    );
  });

  it("två automater: en omgång var, den som blir tom först nämns", async () => {
    const { plan, packSentence, sv } = await load();
    const p = plan([facts(), facts({ machineId: "m2", label: "BL-002", onHand: 12 })]);
    expect(p?.batches).toBe(2);
    expect(packSentence(p, sv)?.text).toBe(
      "Packa 2 omgångar före fredag. BL-001 är tom om ca 3 dagar. 1 automat till blir tom i veckan.",
    );
  });

  it("veckoformen flyttar dagen (helgen säljer mer)", async () => {
    const { plan } = await load();
    // 12 pack, 2 om dagen: sista packet säljs söndag 15 nov., facket står tomt måndag 16.
    const flat = plan([facts({ onHand: 12, sold: 28 })]);
    expect(flat?.before).toBe("2026-11-16");
    // Automaten säljer bara på lördagar (14 den dagen): slut redan lördag 14, tomt söndag 15.
    // Samma anrop som Att göra och besöksplanen (sellOut från i går), plus en dag.
    const weekend = plan([facts({ onHand: 12, sold: 28 })], 0, () => [0, 0, 0, 0, 0, 1, 0]);
    expect(weekend?.before).toBe("2026-11-15");
  });

  it("minus hemma OCH tomt fack: ett besked med summan, inte två likadana (R2-9)", async () => {
    const { plan, mergedPack, sv, en } = await load();
    const p = plan([facts({ onHand: 0 })]);
    const args = { places: [{ id: "p1" }], inPlaces: { p1: -14 }, batchSize: 14, plan: p };
    expect(mergedPack({ ...args, t: sv })).toEqual({
      placeId: "p1",
      fixBatches: 1,
      slotBatches: 1,
      batches: 2,
      packs: 28,
      text: "Packa 2 omgångar nu. 1 rättar minuset. 1 ska till automaten. BL-001 är tom.",
    });
    expect(mergedPack({ ...args, t: en })?.text).toBe(
      "Pack 2 batches now. 1 fixes the minus. 1 is for the machine. BL-001 is empty.",
    );
    // Facket blir tomt om några dagar: samma besked, med dagen.
    expect(mergedPack({ ...args, plan: plan([facts()]), t: sv })?.text).toBe(
      "Packa 2 omgångar nu. 1 rättar minuset. 1 ska till automaten. BL-001 är tom om ca 3 dagar.",
    );
    // Inget minus, ett udda minus (−1) eller inget att packa: inget att slå ihop.
    expect(mergedPack({ ...args, inPlaces: { p1: 0 }, t: sv })).toBeNull();
    expect(mergedPack({ ...args, inPlaces: { p1: -1 }, t: sv })).toBeNull();
    expect(
      mergedPack({ ...args, plan: plan([facts({ onHand: 60, sold: 14 })]), t: sv }),
    ).toBeNull();
  });

  it("ny automat (5 dagar i drift): takten räknas på dagarna sedan start, som i Att göra", async () => {
    const { plan } = await load();
    // 10 sålda på 5 dagar = 2 om dagen (inte 10/14). 6 pack: slut torsdag 12, tomt fredag 13.
    const p = plan([facts({ onHand: 6, sold: 10, activeFrom: "2026-11-05" })]);
    expect(p?.before).toBe("2026-11-13");
  });

  it("aldrig strängen 'packa 56 st'", async () => {
    const { plan, packSentence, sv, en } = await load();
    for (const t of [sv, en]) {
      for (const p of [
        plan([facts()]),
        plan([facts()], 14),
        plan([]),
        plan([facts({ onHand: 0 })]),
      ]) {
        expect(packSentence(p, t)?.text ?? "").not.toMatch(/56|st\b/);
      }
    }
  });

  it("engelska för delägaren", async () => {
    const { plan, packSentence, en } = await load();
    expect(packSentence(plan([facts()]), en)?.text).toBe(
      "Pack 1 batch before Friday. BL-001 is empty in about 3 days.",
    );
    expect(packSentence(plan([facts()], 14), en)?.text).toBe(
      "1 batch is packed and ready. BL-001 is empty in about 3 days.",
    );
    expect(packSentence(plan([]), en)?.text).toBe("Nothing to pack this week.");
  });

  it("utan fack-underlag (planens antal) visas ingen mening", async () => {
    const { packSentence, sv } = await load();
    const { mysteryBatchesToPack } = await import("@/domain");
    expect(packSentence(mysteryBatchesToPack({ batchSize: 14, planPacks: 56 }), sv)).toBeNull();
    expect(packSentence(null, sv)).toBeNull();
  });
});

describe("wholeBatchesDown (färdiga omgångar per lager)", () => {
  it("räknar bara hela omgångar, och aldrig under 0", async () => {
    const { wholeBatchesDown } = await import("./model");
    expect(wholeBatchesDown(7, 14)).toBe(0);
    expect(wholeBatchesDown(14, 14)).toBe(14);
    expect(wholeBatchesDown(20, 14)).toBe(14);
    expect(wholeBatchesDown(28, 14)).toBe(28);
    expect(wholeBatchesDown(-14, 14)).toBe(0);
    expect(wholeBatchesDown(14, 0)).toBe(0);
  });
});

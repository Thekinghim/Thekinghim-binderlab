import { describe, expect, it } from "vitest";

import {
  awishStockCheck,
  CHECK_ORDER,
  crashed,
  homeLine,
  hygieneCheck,
  MAX_FINDINGS,
  parseChecks,
  selfCheckDue,
  profitConsistency,
  refillPushCheck,
  settlementCheck,
  summarize,
  syncFreshnessCheck,
  type AwishMachineRead,
  type ProfitPeriodFigures,
  type RefillRow,
} from ".";

const NOW = new Date("2026-11-07T04:37:00Z");
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();

// ---------------------------------------------------------------------------
// 1. Samma vinst överallt
// ---------------------------------------------------------------------------

function period(over: Partial<ProfitPeriodFigures> = {}): ProfitPeriodFigures {
  return {
    label: "Senaste 30 dagarna",
    off: [
      { label: "Lönsamhet nyckeltal", profitOre: 1_248_000, marginBp: 3120 },
      { label: "Hem nyckeltal", profitOre: 1_248_000, marginBp: 3120 },
      { label: "Lönsamhet per titel", profitOre: 1_248_000 },
      { label: "Automater nyckeltal", profitOre: 1_248_000, marginBp: 3120 },
    ],
    on: [
      { label: "Lönsamhet nyckeltal", profitOre: 1_000_000, marginBp: 2500 },
      { label: "Butiker rader", profitOre: 1_000_000 },
    ],
    shares: [{ label: "avräkningsmotorn", amountOre: 248_000 }],
    ...over,
  };
}

describe("samma vinst överallt", () => {
  it("lika på öret och andelen stämmer: går igenom", () => {
    const r = profitConsistency([period()]);
    expect(r.status).toBe("pass");
    expect(r.findings).toEqual([]);
    expect(r.summary).toMatch(/^Alla sidor visar samma vinst och marginal \(5 jämförelser\)/);
    expect(r.figures.find((f) => f.label.endsWith("butikernas andel"))?.value).toBe(248_000);
  });

  it("en sida skiljer en krona: fel med båda talen", () => {
    const p = period();
    const r = profitConsistency([
      { ...p, off: [...p.off.slice(0, 3), { label: "Automater nyckeltal", profitOre: 1_247_900 }] },
    ]);
    expect(r.status).toBe("fail");
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]!.text).toBe(
      "Senaste 30 dagarna, utan butikernas andel: Automater nyckeltal visar 12 479,00 kr, Lönsamhet nyckeltal 12 480,00 kr (−1,00 kr).",
    );
  });

  it("vinst i automater utan butik: en varning (koppla automaten), inget fel", () => {
    const r = profitConsistency([
      period({ noStoreProfitOre: 17_400 }),
      period({ label: "November", noStoreProfitOre: 5_800 }),
    ]);
    expect(r.status).toBe("warn");
    expect(r.findings).toEqual([
      {
        level: "warn",
        text: "Senaste 30 dagarna: 174,00 kr vinst i automater utan butik syns inte på Butiker. Koppla automaten till en butik.",
        link: "/automater",
      },
    ]);
  });

  it("dokumenterad tolerans för en källa som avrundar per rad", () => {
    const p = period();
    const off = [
      ...p.off,
      { label: "Per rad", profitOre: 1_248_090, toleranceOre: 100, toleranceReason: "kr per rad" },
    ];
    expect(profitConsistency([{ ...p, off }]).status).toBe("pass");
    const worse = [...p.off, { label: "Per rad", profitOre: 1_248_101, toleranceOre: 100 }];
    expect(profitConsistency([{ ...p, off: worse }]).status).toBe("fail");
  });

  it("olika marginal är ett fel", () => {
    const p = period();
    const off = [p.off[0]!, { label: "Hem nyckeltal", profitOre: 1_248_000, marginBp: 3121 }];
    const r = profitConsistency([{ ...p, off }]);
    expect(r.status).toBe("fail");
    expect(r.findings[0]!.text).toMatch(/marginalen på Hem nyckeltal är 31,2 %/);
  });

  it("andelen (på minus av) som inte är avräkningsmotorns: fel", () => {
    const r = profitConsistency([
      period({ shares: [{ label: "avräkningsmotorn", amountOre: 250_000 }] }),
    ]);
    expect(r.status).toBe("fail");
    expect(r.findings[0]!.text).toMatch(/minus vår del är 2 480,00 kr, men avräkningsmotorn/);
  });

  it("andelen skiljer och perioden har order utan inköpspris: fyndet säger varför", () => {
    const r = profitConsistency([
      period({ shares: [{ label: "avräkningarna", amountOre: 250_000 }], unpricedOrders: 15 }),
    ]);
    expect(r.findings[0]).toMatchObject({
      level: "fail",
      link: "/inkopspriser",
      text: expect.stringMatching(/Troligen 15\u00a0order utan inköpspris: lägg in priserna\.$/),
    });
  });

  it("med andelen: skillnad mellan sidorna i läget på", () => {
    const p = period();
    const r = profitConsistency([
      { ...p, on: [p.on[0]!, { label: "Butiker rader", profitOre: 1_100_000 }] },
    ]);
    expect(r.findings[0]!.text).toMatch(/^Senaste 30 dagarna, med butikernas andel: Butiker rader/);
  });
});

// ---------------------------------------------------------------------------
// 2. Awish = appen
// ---------------------------------------------------------------------------

function machine(over: Partial<AwishMachineRead> = {}): AwishMachineRead {
  return {
    machineId: "m1",
    label: "BL-001",
    readAt: minutesAgo(4),
    titles: [
      {
        titleId: "t1",
        titleName: "151",
        awishUnits: 6,
        appUnits: 6,
        changedSince: 0,
        countedSince: false,
      },
    ],
    ...over,
  };
}

describe("Awish = appen", () => {
  it("samma antal: går igenom", () => {
    expect(awishStockCheck({ machines: [machine()], now: NOW }).status).toBe("pass");
  });

  it("försäljning och påfyllning efter läsningen räknas in", () => {
    const m = machine({
      titles: [
        {
          titleId: "t1",
          titleName: "151",
          awishUnits: 6,
          appUnits: 14,
          changedSince: 8,
          countedSince: false,
        },
        {
          titleId: "t2",
          titleName: "Surging",
          awishUnits: 3,
          appUnits: 2,
          changedSince: -1,
          countedSince: false,
        },
      ],
    });
    expect(awishStockCheck({ machines: [m], now: NOW }).status).toBe("pass");
  });

  it("olika antal: fel per titel", () => {
    const m = machine({
      titles: [
        {
          titleId: "t1",
          titleName: "151",
          awishUnits: 2,
          appUnits: 10,
          changedSince: 0,
          countedSince: false,
        },
      ],
    });
    const r = awishStockCheck({ machines: [m], now: NOW });
    expect(r.status).toBe("fail");
    expect(r.findings[0]!.text).toBe("BL-001 151: Awish 2 pack, appen 10 pack.");
  });

  it("inventerat i appen efter läsningen: jämförs inte", () => {
    const m = machine({
      titles: [
        {
          titleId: "t1",
          titleName: "151",
          awishUnits: 2,
          appUnits: 10,
          changedSince: 0,
          countedSince: true,
        },
      ],
    });
    expect(awishStockCheck({ machines: [m], now: NOW }).status).toBe("pass");
  });

  it("gammal läsning: varning, ingen jämförelse", () => {
    const m = machine({
      readAt: minutesAgo(45),
      titles: [
        {
          titleId: "t1",
          titleName: "151",
          awishUnits: 2,
          appUnits: 10,
          changedSince: 0,
          countedSince: false,
        },
      ],
    });
    const r = awishStockCheck({ machines: [m], now: NOW });
    expect(r.status).toBe("warn");
    expect(r.findings[0]!.text).toMatch(/gammal läsning, facken lästes för 45 min sedan/);
  });

  it("inga kopplade automater: hoppas över", () => {
    expect(awishStockCheck({ machines: [], now: NOW }).status).toBe("skip");
  });
});

// ---------------------------------------------------------------------------
// 3. Påfyllningar nådde Awish
// ---------------------------------------------------------------------------

function refill(over: Partial<RefillRow> = {}): RefillRow {
  return {
    eventId: "e1",
    machineId: "m1",
    machineLabel: "BL-001",
    titleName: "151",
    quantity: 8,
    at: minutesAgo(60),
    pushEnabled: true,
    undone: false,
    ...over,
  };
}

describe("påfyllningar nådde Awish", () => {
  it("push efter påfyllningen: går igenom", () => {
    const r = refillPushCheck({
      refills: [refill()],
      pushes: [{ machineId: "m1", at: minutesAgo(59) }],
      now: NOW,
      pushConfigured: true,
    });
    expect(r.status).toBe("pass");
  });

  it("push före påfyllningen räknas inte", () => {
    const r = refillPushCheck({
      refills: [refill()],
      pushes: [{ machineId: "m1", at: minutesAgo(90) }],
      now: NOW,
      pushConfigured: true,
    });
    expect(r.status).toBe("fail");
    expect(r.findings[0]!.text).toBe(
      "BL-001 151: påfyllningen på 8 pack har inte nått Awish (ingen lyckad push efter den).",
    );
  });

  it("utan loggad push men bekräftad av en läsning efter påfyllningen: nådde Awish", () => {
    const r = refillPushCheck({
      refills: [refill({ confirmedByRead: true })],
      pushes: [],
      now: NOW,
      pushConfigured: true,
    });
    expect(r.status).toBe("pass");
  });

  it("ångrad, för ny, för gammal eller utan push: räknas inte", () => {
    const r = refillPushCheck({
      refills: [
        refill({ undone: true }),
        refill({ at: minutesAgo(1) }),
        refill({ at: minutesAgo(25 * 60) }),
        refill({ pushEnabled: false }),
      ],
      pushes: [],
      now: NOW,
      pushConfigured: true,
    });
    expect(r.status).toBe("pass");
  });

  it("titel utan fack i Awish: varning", () => {
    const r = refillPushCheck({
      refills: [refill({ noSlot: true })],
      pushes: [],
      now: NOW,
      pushConfigured: true,
    });
    expect(r.status).toBe("warn");
  });

  it("push inte påslagen: hoppas över", () => {
    expect(
      refillPushCheck({ refills: [refill()], pushes: [], now: NOW, pushConfigured: false }).status,
    ).toBe("skip");
  });
});

// ---------------------------------------------------------------------------
// 4. Synk färsk
// ---------------------------------------------------------------------------

describe("synk färsk", () => {
  const source = {
    name: "Awish",
    paused: false,
    linkedMachines: 3,
    lastSuccessAt: minutesAgo(3),
    stockReadAt: minutesAgo(4),
    expiry: null,
  };

  it("var femte minut: går igenom", () => {
    const r = syncFreshnessCheck({ sources: [source], now: NOW });
    expect(r.status).toBe("pass");
    expect(r.summary).toBe("Orderna och facken hämtades från Awish för 4 min sedan.");
  });

  it("över 30 min: varning, över 2 h: fel", () => {
    expect(
      syncFreshnessCheck({ sources: [{ ...source, lastSuccessAt: minutesAgo(31) }], now: NOW })
        .status,
    ).toBe("warn");
    const r = syncFreshnessCheck({
      sources: [{ ...source, stockReadAt: minutesAgo(121) }],
      now: NOW,
    });
    expect(r.status).toBe("fail");
    expect(r.findings[0]!.text).toBe("Awish: läsningen av facken lyckades senast för 2 h sedan.");
  });

  it("aldrig lyckats: fel", () => {
    expect(
      syncFreshnessCheck({ sources: [{ ...source, lastSuccessAt: null }], now: NOW }).status,
    ).toBe("fail");
  });

  it("kontot går ut snart: varning; brådskande: fel", () => {
    const soon = {
      level: "soon" as const,
      text: "Awish-kontot går ut 1 dec. 2026 – förläng hos Awish",
    };
    expect(syncFreshnessCheck({ sources: [{ ...source, expiry: soon }], now: NOW }).status).toBe(
      "warn",
    );
    expect(
      syncFreshnessCheck({ sources: [{ ...source, expiry: { ...soon, level: "now" } }], now: NOW })
        .status,
    ).toBe("fail");
  });

  it("pausad eller utan automater: hoppas över", () => {
    expect(syncFreshnessCheck({ sources: [{ ...source, paused: true }], now: NOW }).summary).toBe(
      "Awish-synken är pausad.",
    );
    expect(syncFreshnessCheck({ sources: [], now: NOW }).status).toBe("skip");
  });
});

// ---------------------------------------------------------------------------
// 5. Avräkningar
// ---------------------------------------------------------------------------

describe("avräkningar", () => {
  const row = {
    storeName: "Spelbutiken",
    monthLabel: "oktober 2026",
    storedOre: 50_000,
    live: { ok: true as const, amountOre: 50_000 },
    pageShareOre: 50_000,
  };

  it("lika: går igenom", () => {
    expect(settlementCheck([row]).status).toBe("pass");
  });

  it("avräkningen och sidornas andel skiljer: fel", () => {
    const r = settlementCheck([{ ...row, pageShareOre: 49_000 }]);
    expect(r.status).toBe("fail");
    expect(r.findings[0]!.text).toMatch(/^Spelbutiken, oktober 2026: avräkningen är 500,00 kr/);
  });

  it("bara det sparade beloppet är gammalt: varning", () => {
    expect(settlementCheck([{ ...row, storedOre: 40_000 }]).status).toBe("warn");
  });

  it("går inte att räkna: fel", () => {
    expect(
      settlementCheck([{ ...row, live: { ok: false, message: "Order saknar inköpspris." } }])
        .status,
    ).toBe("fail");
  });

  it("inga obetalda: hoppas över", () => {
    expect(settlementCheck([]).status).toBe("skip");
  });
});

// ---------------------------------------------------------------------------
// 6. Datahygien
// ---------------------------------------------------------------------------

describe("datahygien", () => {
  const clean = {
    ordersWithoutTitle: 0,
    ordersWithoutAmount: 0,
    unpricedTitles: [],
    negativeStock: [],
  };

  it("ren data: går igenom", () => {
    expect(hygieneCheck(clean).status).toBe("pass");
  });

  it("order utan titel, titel utan pris, negativt saldo i automat: fel", () => {
    const r = hygieneCheck({
      ...clean,
      ordersWithoutTitle: 2,
      unpricedTitles: [{ titleId: "t1", name: "151", orders: 3, revenueOre: 23_700 }],
      negativeStock: [{ place: "BL-001", kind: "machine", titleName: "151", quantity: -2 }],
    });
    expect(r.status).toBe("fail");
    expect(r.findings.map((f) => f.text)).toEqual([
      "2 order saknar titel. Koppla varunamnet till en titel.",
      "151 har sålt 3 gånger (237,00 kr) utan inköpspris.",
      "BL-001 151: saldot är -2 pack.",
    ]);
  });

  it("negativt i vårt lager och order på 0 kr: varning", () => {
    const r = hygieneCheck({
      ...clean,
      ordersWithoutAmount: 1,
      negativeStock: [{ place: "Hemma", kind: "warehouse", titleName: "151", quantity: -1 }],
    });
    expect(r.status).toBe("warn");
  });

  it("butik med automat utan avtal: fel (0 kr); några dagar utan avtal: varning", () => {
    const whole = hygieneCheck({
      ...clean,
      agreementGaps: [{ storeId: "s3", storeName: "Hörnan", days: 12, whole: true }],
    });
    expect(whole.status).toBe("fail");
    expect(whole.findings[0]).toEqual({
      level: "fail",
      text: "Hörnan har en automat men inget avtal och räknas som 0 %. Lägg in avtalet.",
      link: "/butiker/s3?vy=avtal",
    });
    const some = hygieneCheck({
      ...clean,
      agreementGaps: [{ storeId: "s1", storeName: "Kiosken", days: 3, whole: false }],
    });
    expect(some.status).toBe("warn");
    expect(some.findings[0]!.text.replace(/\u00a0/g, " ")).toBe(
      "Kiosken saknar avtal 3 dagar och räknas som 0 % de dagarna.",
    );
    expect(some.figures.find((f) => f.label === "Butiker utan avtal")?.value).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Körningen
// ---------------------------------------------------------------------------

describe("körningen", () => {
  it("status och raden på Hem", () => {
    const fail = crashed("synk", "timeout");
    const pass = hygieneCheck({
      ordersWithoutTitle: 0,
      ordersWithoutAmount: 0,
      unpricedTitles: [],
      negativeStock: [],
    });
    expect(summarize([pass])).toEqual({ status: "ok", failed: 0, warnings: 0 });
    const run = summarize([pass, fail, crashed("datahygien", "x")]);
    expect(run).toEqual({ status: "failed", failed: 2, warnings: 0 });
    expect(homeLine(run)).toBe("Kontrollen hittade 2 fel");
    expect(homeLine({ status: "ok", failed: 0 })).toBeNull();
    expect(homeLine(null)).toBeNull();
  });

  it("högst MAX_FINDINGS fynd sparas, resten räknas", () => {
    const r = hygieneCheck({
      ordersWithoutTitle: 0,
      ordersWithoutAmount: 0,
      unpricedTitles: Array.from({ length: MAX_FINDINGS + 5 }, (_, i) => ({
        titleId: `t${i}`,
        name: `Titel ${i}`,
        orders: 1,
        revenueOre: 100,
      })),
      negativeStock: [],
    });
    expect(r.findings).toHaveLength(MAX_FINDINGS);
    expect(r.more).toBe(5);
  });

  it("parseChecks: tillbaka ur jsonb i visningsordning, trasiga rader hoppas över", () => {
    const results = [crashed("datahygien", "x"), crashed("samma_vinst", "y")];
    const parsed = parseChecks([
      ...JSON.parse(JSON.stringify(results)),
      { id: "okänd" },
      null,
      { id: "synk", status: "konstig", findings: [{ text: 1, link: "//evil" }] },
    ]);
    expect(parsed.map((r) => r.id)).toEqual(["samma_vinst", "synk", "datahygien"]);
    expect(parsed[1]!.status).toBe("fail");
    expect(parsed[1]!.findings[0]!.link).toBe("/datakallor");
    expect(CHECK_ORDER).toHaveLength(6);
  });
});

describe("schemat", () => {
  const TZ = "Europe/Stockholm";
  it("vintertid: 03:37 UTC är 04:37 (för tidigt), 04:37 UTC är 05:37 (kör)", () => {
    expect(selfCheckDue(new Date("2026-11-07T03:37:00Z"), TZ, null)).toEqual({
      due: false,
      reason: "not_yet",
    });
    expect(selfCheckDue(new Date("2026-11-07T04:37:00Z"), TZ, null)).toEqual({ due: true });
  });

  it("sommartid: 03:37 UTC är 05:37 (kör), 04:37 UTC samma dag körs inte igen", () => {
    const first = new Date("2026-07-07T03:37:00Z");
    expect(selfCheckDue(first, TZ, null)).toEqual({ due: true });
    expect(selfCheckDue(new Date("2026-07-07T04:37:00Z"), TZ, first)).toEqual({
      due: false,
      reason: "already_ran",
    });
    // Nästa dag igen.
    expect(selfCheckDue(new Date("2026-07-08T03:37:00Z"), TZ, first)).toEqual({ due: true });
  });
});

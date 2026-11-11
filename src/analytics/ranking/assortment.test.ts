import { describe, expect, it } from "vitest";

import { addDays, type IsoDate } from "@/domain";

import {
  bestAssortment,
  perDayText,
  type AssortmentSale,
  type AssortmentSlotPeriod,
  type BestAssortmentInput,
} from "./assortment";

const PERIOD = { start: "2026-10-01" as IsoDate, end: "2026-10-28" as IsoDate }; // 28 dagar
const TODAY = "2026-10-29" as IsoDate; // dagen efter periodens sista hela dag
const TITLES = [
  { id: "151", name: "Pokémon 151" },
  { id: "flair", name: "White Flair" },
  { id: "spark", name: "Surging Sparks" },
  { id: "evo", name: "Prismatic Evolutions" },
  { id: "30th", name: "30th Celebration" },
  { id: "myst", name: "Mystery Pack Plus", mysteryBatchSize: 14 },
];

/** `perDay` pack varje dag i perioden (0,5 = varannan dag). */
function sales(
  machineId: string,
  titleId: string,
  perDay: number,
  profitOre: number | null = 2_000,
  from: IsoDate = PERIOD.start,
  to: IsoDate = PERIOD.end,
): AssortmentSale[] {
  const out: AssortmentSale[] = [];
  let carry = 0;
  for (let d = from; d <= to; d = addDays(d, 1)) {
    carry += perDay;
    while (carry >= 1) {
      out.push({ machineId, titleId, date: d, profitOre });
      carry -= 1;
    }
  }
  return out;
}

function slot(machineId: string, titleId: string, from = "2026-01-01", to: string | null = null) {
  return {
    machineId,
    titleId,
    validFrom: from as IsoDate,
    validTo: to as IsoDate | null,
  } satisfies AssortmentSlotPeriod;
}

function input(over: Partial<BestAssortmentInput>): BestAssortmentInput {
  return {
    machineId: "A",
    period: PERIOD,
    today: TODAY,
    sales: [],
    slotPeriods: [],
    stockoutDays: [],
    titles: TITLES,
    ...over,
  };
}

describe("bestAssortment", () => {
  const ownSlots = ["151", "flair", "spark", "evo"].map((t) => slot("A", t));
  const ownSales = [
    ...sales("A", "151", 4, 2_500),
    ...sales("A", "spark", 2),
    ...sales("A", "evo", 2),
    ...sales("A", "flair", 1, 2_000, "2026-10-05", "2026-10-07"), // 3 pack på 28 dagar
  ];

  it("visar pack och vinst per dag per titel, bäst först", () => {
    const r = bestAssortment(input({ sales: ownSales, slotPeriods: ownSlots }));
    expect(r.rows.map((x) => x.titleId)).toEqual(["151", "evo", "spark", "flair"]);
    expect(r.rows[0]).toMatchObject({
      units: 112,
      stockedDayTenths: 280,
      unitsPerDayMilli: 4_000,
      profitPerDayOre: 10_000,
      enough: true,
      slow: false,
    });
    expect(r.best?.titleId).toBe("151");
    expect(r.tooShort).toBe(false);
  });

  it("föreslår att byta ut den som står still mot det som säljer i andra automater", () => {
    const r = bestAssortment(
      input({
        sales: [...ownSales, ...sales("B", "30th", 6), ...sales("C", "30th", 6)],
        slotPeriods: [...ownSlots, slot("B", "30th"), slot("C", "30th")],
      }),
    );
    expect(r.slow.map((x) => x.titleId)).toEqual(["flair"]);
    expect(r.suggestions).toHaveLength(1);
    expect(r.suggestions[0]!.text).toBe(
      "Byt ut White Flair: säljer 0,1/dag. Prova 30th Celebration: säljer 6/dag i 2 andra automater.",
    );
    expect(r.otherMachines).toBe(2);
  });

  it("föreslår aldrig en titel som redan finns här, eller en som säljer för lite", () => {
    const r = bestAssortment(
      input({
        sales: [...ownSales, ...sales("B", "151", 9), ...sales("B", "30th", 0.15)],
        slotPeriods: [...ownSlots, slot("B", "151"), slot("B", "30th")],
      }),
    );
    // 30th säljer 0,14/dag i B: inte dubbelt så mycket som White Flair (0,107).
    expect(r.suggestions[0]!.tryInstead).toBeNull();
    expect(r.suggestions[0]!.text).toBe("Byt ut White Flair: säljer 0,1/dag.");
  });

  it("föreslår inte en titel som gått ur sortimentet i den andra automaten", () => {
    const r = bestAssortment(
      input({
        sales: [...ownSales, ...sales("B", "30th", 6, 2_000, PERIOD.start, "2026-10-20")],
        slotPeriods: [...ownSlots, slot("B", "30th", "2026-01-01", "2026-10-20")],
      }),
    );
    expect(r.suggestions[0]!.tryInstead).toBeNull();
  });

  it("ordningen är pack per dag: den som säljer bäst står först, även med lägre vinst", () => {
    const r = bestAssortment(
      input({
        sales: [...sales("A", "151", 4, 500), ...sales("A", "spark", 2, 3_000)],
        slotPeriods: ownSlots,
      }),
    );
    // Pokémon 151: 4/dag och 20 kr/dag. Surging Sparks: 2/dag och 60 kr/dag.
    expect(r.rows.slice(0, 2).map((x) => x.titleId)).toEqual(["151", "spark"]);
    expect(r.best?.titleId).toBe("151");
  });

  it("en titel som gick ur sortimentet i går byts inte ut: den är redan borta", () => {
    const r = bestAssortment(
      input({
        sales: ownSales,
        slotPeriods: [
          ...ownSlots.filter((x) => x.titleId !== "flair"),
          slot("A", "flair", "2026-01-01", PERIOD.end),
        ],
      }),
    );
    expect(r.rows.find((x) => x.titleId === "flair")).toMatchObject({
      current: false,
      slow: false,
    });
    expect(r.suggestions).toEqual([]);
  });

  it("en titel som kom in i automaten i dag föreslås inte: den finns redan här", () => {
    const r = bestAssortment(
      input({
        sales: [...ownSales, ...sales("B", "30th", 6)],
        slotPeriods: [...ownSlots, slot("B", "30th"), slot("A", "30th", TODAY)],
      }),
    );
    expect(r.slow.map((x) => x.titleId)).toEqual(["flair"]);
    expect(r.suggestions[0]!.tryInstead).toBeNull();
  });

  it("en äldre period: sortimentet nu gäller, inte sortimentet då", () => {
    // White Flair togs bort och 30th kom in efter perioden: inget att byta, inget att prova.
    const r = bestAssortment(
      input({
        today: "2026-12-01" as IsoDate,
        sales: [...ownSales, ...sales("B", "30th", 6)],
        slotPeriods: [
          ...ownSlots.filter((x) => x.titleId !== "flair"),
          slot("A", "flair", "2026-01-01", "2026-11-10"),
          slot("A", "30th", "2026-11-11"),
          slot("B", "30th"),
        ],
      }),
    );
    expect(r.slow).toEqual([]);
    expect(r.suggestions).toEqual([]);
  });

  it("föreslår inte en titel som själv skulle stå still här", () => {
    // White Flair sålde 0. 30th säljer 0,07/dag i B: mer än 0, men inget att prova.
    const r = bestAssortment(
      input({
        sales: [
          ...ownSales.filter((x) => x.titleId !== "flair"),
          ...sales("B", "30th", 1, 2_000, "2026-10-05", "2026-10-06"),
        ],
        slotPeriods: [...ownSlots, slot("B", "30th")],
      }),
    );
    expect(r.slow.map((x) => x.titleId)).toEqual(["flair"]);
    expect(r.suggestions[0]!.tryInstead).toBeNull();
    expect(r.suggestions[0]!.text).toBe("Byt ut White Flair: säljer 0/dag.");
  });

  it("med en enda automat: det som står still visas, men inget att prova", () => {
    const r = bestAssortment(input({ sales: ownSales, slotPeriods: ownSlots }));
    expect(r.slow).toHaveLength(1);
    expect(r.otherMachines).toBe(0);
    expect(r.suggestions.map((s) => s.tryInstead)).toEqual([null]);
  });

  it("slutsålda dagar räknas inte: en slutsåld storsäljare står inte still", () => {
    // White Flair sålde 3 pack på 3 dagar och var sedan slutsåld resten av perioden.
    const stockoutDays = [];
    for (let d = "2026-10-08" as IsoDate; d <= PERIOD.end; d = addDays(d, 1)) {
      stockoutDays.push({ machineId: "A", titleId: "flair", date: d, weightBp: 10_000 });
    }
    const r = bestAssortment(input({ sales: ownSales, slotPeriods: ownSlots, stockoutDays }));
    const flair = r.rows.find((x) => x.titleId === "flair")!;
    expect(flair.stockedDayTenths).toBe(70);
    expect(flair.enough).toBe(false);
    expect(flair.slow).toBe(false);
    expect(r.slow).toEqual([]);
  });

  it("en titel med 0 sålda på 14 dagar i lager står still även utan median", () => {
    const r = bestAssortment(
      input({ sales: sales("A", "151", 3), slotPeriods: [slot("A", "151"), slot("A", "flair")] }),
    );
    expect(r.medianUnitsPerDayMilli).toBeNull();
    expect(r.slow.map((x) => x.titleId)).toEqual(["flair"]);
    expect(r.suggestions[0]!.text).toBe("Byt ut White Flair: säljer 0/dag.");
  });

  it("för kort period (under 14 dagar): inga omdömen eller förslag", () => {
    const short = { start: "2026-10-22" as IsoDate, end: PERIOD.end };
    const r = bestAssortment(
      input({
        period: short,
        sales: [...ownSales, ...sales("B", "30th", 6)],
        slotPeriods: [...ownSlots, slot("B", "30th")],
      }),
    );
    expect(r).toMatchObject({ days: 7, tooShort: true, best: null, slow: [], suggestions: [] });
    expect(r.rows.find((x) => x.titleId === "151")).toMatchObject({ units: 28, enough: false });
  });

  it("en titel som kom in sent har för lite data och döms inte", () => {
    const r = bestAssortment(
      input({
        sales: ownSales.filter((s) => s.titleId !== "flair"),
        slotPeriods: [
          ...ownSlots.filter((s) => s.titleId !== "flair"),
          slot("A", "flair", "2026-10-20"),
        ],
      }),
    );
    expect(r.rows.find((x) => x.titleId === "flair")).toMatchObject({
      stockedDayTenths: 90,
      enough: false,
      slow: false,
    });
  });

  it("mystery packs byts aldrig ut och föreslås aldrig", () => {
    const r = bestAssortment(
      input({
        sales: [...ownSales, ...sales("B", "myst", 5), ...sales("B", "151", 4)],
        slotPeriods: [...ownSlots, slot("A", "myst"), slot("B", "myst"), slot("B", "151")],
      }),
    );
    const myst = r.rows.find((x) => x.titleId === "myst")!;
    expect(myst).toMatchObject({ mysteryBatch: 14, units: 0, slow: false });
    expect(r.slow.map((x) => x.titleId)).toEqual(["flair"]);
    expect(r.suggestions[0]!.tryInstead).toBeNull();
  });

  it("utan registrerat sortiment räknas titeln från sin första order", () => {
    const r = bestAssortment(
      input({ sales: sales("A", "151", 2, 2_000, "2026-10-08", PERIOD.end) }),
    );
    expect(r.rows[0]).toMatchObject({
      current: true,
      stockedDayTenths: 210,
      unitsPerDayMilli: 2_000,
    });
  });

  it("order utan inköpspris räknas i pack men inte i vinsten", () => {
    const r = bestAssortment(input({ sales: sales("A", "151", 1, null), slotPeriods: ownSlots }));
    expect(r.rows.find((x) => x.titleId === "151")).toMatchObject({
      units: 28,
      unpricedUnits: 28,
      profitPerDayOre: null,
      unitsPerDayMilli: 1_000,
    });
  });

  it("överlappande sortimentsperioder räknas en gång", () => {
    const r = bestAssortment(
      input({
        sales: sales("A", "151", 1),
        slotPeriods: [slot("A", "151", "2026-01-01", "2026-10-10"), slot("A", "151", "2026-10-05")],
      }),
    );
    expect(r.rows[0]!.stockedDayTenths).toBe(280);
  });
});

describe("perDayText", () => {
  it("skriver pack per dag kort", () => {
    expect(perDayText(6_000)).toBe("6");
    expect(perDayText(107)).toBe("0,1");
    expect(perDayText(2_450)).toBe("2,5");
    expect(perDayText(20)).toBe("under 0,1");
    expect(perDayText(0)).toBe("0");
  });
});

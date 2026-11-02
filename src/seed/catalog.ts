/**
 * Seed-datan för utveckling och demo: verksamhetens riktiga försäljning
 * 13 okt – 1 nov 2026 (svensk tid) och tre exempelbutiker.
 *
 * Facit (måste stämma på öret, se src/seed/orders.test.ts och
 * test/db/seed.test.ts):
 * - 460 betalda order, 79 987 kr, snitt 173,88 kr.
 * - Per titel: antal och summa enligt SEED_TITLES.
 * - Bästa dag 26 okt (höstlovets första dag) med 8 300–8 500 kr.
 * - De fyra sista orderna (42777–42780) enligt SEED_LAST_ORDERS.
 *
 * Försäljningspriset per titel anges som ett schema i tidsordning: de första
 * `count` orderna av titeln har det första priset, nästa `count` det andra
 * och så vidare. Tre titlar bytte pris under perioden (30th Celebration
 * sänktes från 185 till 170 kr, Surging Sparks höjdes från 120 till 130 kr,
 * Prismatic Evolution höjdes från 190 till 200 kr). Övriga har ett pris.
 *
 * Inköpspriset för 30th Celebration ändras 27 okt (ny, dyrare leverans till
 * centrallagret samma morgon): 105,00 kr t.o.m. 26 okt, 112,00 kr från 27 okt.
 * Därmed finns en prisändring mitt i perioden att testa vinsten mot.
 * White Flair och Perfect Order saknar inköpspris (räknas inte in i vinsten).
 */

import type { IsoDate } from "@/domain/types";

/** Organisationens och datakällans tidszoner. */
export const ORGANIZATION_TIMEZONE = "Europe/Stockholm";
export const SOURCE_TIMEZONE = "Asia/Shanghai";

export const SEED_ORGANIZATION = { name: "Binderlab", slug: "binderlab" } as const;

export interface SeedUser {
  email: string;
  fullName: string;
  role: "owner" | "viewer";
}

export const SEED_USERS = {
  owner: { email: "agare@binderlab.local", fullName: "Ägare", role: "owner" },
  partner: { email: "delagare@binderlab.local", fullName: "Delägare", role: "viewer" },
} as const satisfies Record<string, SeedUser>;

/** Standardlösenordet för dev-användarna. Används bara mot lokal databas. */
export const DEFAULT_DEV_SEED_PASSWORD = "binderlab-dev";

export const SEED_PERIOD = { start: "2026-10-13", end: "2026-11-01" } as const satisfies {
  start: IsoDate;
  end: IsoDate;
};

/** Ordernummer 42321–42780 i tidsordning. */
export const FIRST_ORDER_NO = 42_321;
export const LAST_ORDER_NO = 42_780;
export const ORDER_COUNT = LAST_ORDER_NO - FIRST_ORDER_NO + 1;

export const EXPECTED_TOTAL_ORE = 7_998_700;
export const BEST_DAY: IsoDate = "2026-10-26";
/** Bästa dagens intäkt ska ligga i [min, max] öre och vara periodens högsta. */
export const BEST_DAY_RANGE_ORE = { min: 830_000, max: 850_000 } as const;
/** Antal order på bästa dagen (övriga fördelas efter veckodag och höstlov). */
export const BEST_DAY_ORDERS = 48;

/** Höstlovet (vecka 44): högre försäljning. */
export const AUTUMN_BREAK = { start: "2026-10-26", end: "2026-11-01" } as const;

/** Öppettider i butikerna (svensk tid): första och sista timmen med försäljning. */
export const OPEN_HOURS = { first: 10, last: 19 } as const;

export interface PriceStep {
  /** Försäljningspris i öre. */
  ore: number;
  /** Antal order (i tidsordning) med det här priset. */
  count: number;
}

export interface SeedTitle {
  /** Titelns namn, samma som "Name" i Awish (blir alias). */
  name: string;
  prices: readonly PriceStep[];
  /** Inköpspris per order (öre) med giltig från-datum. Tom = saknar pris. */
  purchasePrices: readonly { validFrom: IsoDate; unitCostOre: number; note: string }[];
  /** Pack som ligger kvar i centrallagret i slutet (utöver det som fyllts på). */
  warehouseReserve: number;
}

const PRICE_START: IsoDate = "2026-10-01";
const initialPrice = (unitCostOre: number) => ({
  validFrom: PRICE_START,
  unitCostOre,
  note: "Inköpspris vid start",
});

export const SEED_TITLES: readonly SeedTitle[] = [
  {
    name: "30th Celebration",
    prices: [
      { ore: 18_500, count: 65 },
      { ore: 17_000, count: 85 },
    ],
    purchasePrices: [
      initialPrice(10_500),
      { validFrom: "2026-10-27", unitCostOre: 11_200, note: "Ny leverans 27 okt, dyrare inköp" },
    ],
    warehouseReserve: 24,
  },
  {
    name: "Mystery Pack",
    prices: [{ ore: 19_900, count: 62 }],
    purchasePrices: [initialPrice(12_500)],
    warehouseReserve: 18,
  },
  {
    name: "Surging Sparks",
    prices: [
      { ore: 12_000, count: 41 },
      { ore: 13_000, count: 7 },
    ],
    purchasePrices: [initialPrice(7_200)],
    warehouseReserve: 30,
  },
  {
    name: "Prismatic Evolution",
    prices: [
      { ore: 19_000, count: 26 },
      { ore: 20_000, count: 19 },
    ],
    purchasePrices: [initialPrice(12_800)],
    // Slut i centrallagret: allt är utfyllt i automaterna.
    warehouseReserve: 0,
  },
  {
    name: "Ascended Heroes",
    prices: [{ ore: 18_900, count: 43 }],
    purchasePrices: [initialPrice(11_800)],
    warehouseReserve: 12,
  },
  {
    name: "Phantasmal Flames",
    prices: [{ ore: 17_900, count: 20 }],
    purchasePrices: [initialPrice(10_900)],
    warehouseReserve: 10,
  },
  {
    name: "Destin Rivals",
    prices: [{ ore: 16_900, count: 16 }],
    purchasePrices: [initialPrice(10_400)],
    warehouseReserve: 8,
  },
  {
    name: "Black bolt",
    prices: [{ ore: 14_900, count: 20 }],
    purchasePrices: [initialPrice(9_200)],
    warehouseReserve: 14,
  },
  {
    name: "Mega Evolution",
    prices: [{ ore: 15_900, count: 14 }],
    purchasePrices: [initialPrice(9_950)],
    warehouseReserve: 6,
  },
  {
    name: "Paldea Evolved",
    prices: [{ ore: 13_000, count: 9 }],
    purchasePrices: [initialPrice(7_600)],
    warehouseReserve: 4,
  },
  {
    name: "Perfect Order",
    prices: [{ ore: 14_900, count: 15 }],
    purchasePrices: [],
    warehouseReserve: 6,
  },
  {
    name: "White Flair",
    prices: [{ ore: 15_900, count: 10 }],
    purchasePrices: [],
    warehouseReserve: 6,
  },
  {
    name: "Mystery pack premium",
    prices: [{ ore: 24_900, count: 8 }],
    purchasePrices: [initialPrice(16_500)],
    warehouseReserve: 3,
  },
];

/** Titlar som avsiktligt saknar inköpspris. */
export const TITLES_WITHOUT_PRICE = SEED_TITLES.filter((t) => t.purchasePrices.length === 0).map(
  (t) => t.name,
);

/** Facit per titel: antal order och summa i öre. */
export function expectedByTitle(): Map<string, { orders: number; revenueOre: number }> {
  const out = new Map<string, { orders: number; revenueOre: number }>();
  for (const t of SEED_TITLES) {
    let orders = 0;
    let revenueOre = 0;
    for (const p of t.prices) {
      orders += p.count;
      revenueOre += p.ore * p.count;
    }
    out.set(t.name, { orders, revenueOre });
  }
  return out;
}

export interface SeedLastOrder {
  externalId: string;
  title: string;
  amountOre: number;
  /** Svensk tid "YYYY-MM-DD HH:mm:ss". */
  stockholmTime: string;
}

/** De fyra sista orderna, exakt som i Awish. */
export const SEED_LAST_ORDERS: readonly SeedLastOrder[] = [
  {
    externalId: "42777",
    title: "Ascended Heroes",
    amountOre: 18_900,
    stockholmTime: "2026-11-01 17:09:12",
  },
  {
    externalId: "42778",
    title: "Mystery Pack",
    amountOre: 19_900,
    stockholmTime: "2026-11-01 17:09:41",
  },
  {
    externalId: "42779",
    title: "Ascended Heroes",
    amountOre: 18_900,
    stockholmTime: "2026-11-01 17:11:05",
  },
  {
    externalId: "42780",
    title: "30th Celebration",
    amountOre: 17_000,
    stockholmTime: "2026-11-01 17:17:00",
  },
];

// ---------------------------------------------------------------------------
// Butiker, automater, avtal
// ---------------------------------------------------------------------------

export interface SeedStore {
  key: "s1" | "s2" | "s3";
  name: string;
  address: string;
  contactName: string;
  agreement: {
    validFrom: IsoDate;
    commissionBp: number | null;
    monthlyRentOre: number | null;
    note: string;
  };
}

export interface SeedMachine {
  code: string;
  name: string;
  serial: string;
  storeKey: SeedStore["key"];
  /** "Order Machine" i Awish. */
  awishName: string;
  /** Andel av orderna (heltalsvikt). */
  weight: number;
  activeFrom: IsoDate;
  investments: readonly {
    kind: "purchase" | "installation" | "other";
    amountOre: number;
    investedOn: IsoDate;
    depreciationMonths: number | null;
    note: string;
  }[];
}

export const PLACEMENT_FROM: IsoDate = "2026-10-01";

export const SEED_STORES: readonly SeedStore[] = [
  {
    key: "s1",
    name: "Spelbutiken Centrum (exempel)",
    address: "Exempelgatan 1, 111 11 Exempelstad",
    contactName: "Exempel Kontakt",
    agreement: {
      validFrom: PLACEMENT_FROM,
      commissionBp: 1_200,
      monthlyRentOre: null,
      note: "Exempel: provision 12 % på belopp exkl. moms",
    },
  },
  {
    key: "s2",
    name: "Gallerian Väst (exempel)",
    address: "Exempelvägen 2, 222 22 Exempelstad",
    contactName: "Exempel Kontakt",
    agreement: {
      validFrom: PLACEMENT_FROM,
      commissionBp: null,
      monthlyRentOre: 150_000,
      note: "Exempel: fast hyra 1 500 kr/mån",
    },
  },
  {
    key: "s3",
    name: "Kiosken Stationen (exempel)",
    address: "Exempeltorget 3, 333 33 Exempelstad",
    contactName: "Exempel Kontakt",
    agreement: {
      validFrom: PLACEMENT_FROM,
      commissionBp: 800,
      monthlyRentOre: 75_000,
      note: "Exempel: provision 8 % + hyra 750 kr/mån",
    },
  },
];

export const SEED_MACHINES: readonly SeedMachine[] = [
  {
    code: "BL-001",
    name: "Automat 1 (exempel)",
    serial: "EX-0001",
    storeKey: "s1",
    awishName: "BL-001 Centrum",
    weight: 46,
    activeFrom: PLACEMENT_FROM,
    investments: [
      {
        kind: "purchase",
        amountOre: 3_990_000,
        investedOn: "2026-09-25",
        depreciationMonths: 60,
        note: "Exempel: automat",
      },
      {
        kind: "installation",
        amountOre: 250_000,
        investedOn: "2026-09-30",
        depreciationMonths: 60,
        note: "Exempel: frakt och installation",
      },
    ],
  },
  {
    code: "BL-002",
    name: "Automat 2 (exempel)",
    serial: "EX-0002",
    storeKey: "s2",
    awishName: "BL-002 Gallerian",
    weight: 32,
    activeFrom: PLACEMENT_FROM,
    investments: [
      {
        kind: "purchase",
        amountOre: 3_990_000,
        investedOn: "2026-09-25",
        depreciationMonths: 60,
        note: "Exempel: automat",
      },
    ],
  },
  {
    code: "BL-003",
    name: "Automat 3 (exempel)",
    serial: "EX-0003",
    storeKey: "s3",
    awishName: "BL-003 Stationen",
    weight: 22,
    activeFrom: PLACEMENT_FROM,
    investments: [
      {
        kind: "purchase",
        amountOre: 3_490_000,
        investedOn: "2026-09-26",
        depreciationMonths: 60,
        note: "Exempel: begagnad automat",
      },
    ],
  },
];

/** Betalmetoder i Awish med heltalsvikter. */
export const PAYMENT_METHODS: readonly { name: string; weight: number }[] = [
  { name: "Card", weight: 72 },
  { name: "Swish", weight: 28 },
];

/** BAS-konton (momsfri försäljning, eftersom momsen är 0). */
export const SEED_LEDGER_ACCOUNTS: readonly { key: string; basAccount: string; name: string }[] = [
  { key: "settlement", basAccount: "1580", name: "Fordran på kortinlösen" },
  { key: "inventory", basAccount: "1460", name: "Lager av handelsvaror" },
  { key: "equipment", basAccount: "1220", name: "Inventarier och verktyg" },
  { key: "store_payable", basAccount: "2440", name: "Leverantörsskulder" },
  { key: "vat_out", basAccount: "2611", name: "Utgående moms på försäljning inom Sverige, 25 %" },
  { key: "sales", basAccount: "3004", name: "Försäljning inom Sverige, momsfri" },
  { key: "cogs", basAccount: "4010", name: "Inköp material och varor" },
  { key: "rent", basAccount: "5010", name: "Lokalhyra" },
  { key: "card_fees", basAccount: "6040", name: "Kontokortsavgifter" },
  { key: "store_commission", basAccount: "6050", name: "Försäljningsprovisioner" },
  { key: "depreciation", basAccount: "7832", name: "Avskrivningar på inventarier och verktyg" },
];

// ---------------------------------------------------------------------------
// Lager
// ---------------------------------------------------------------------------

/** Inventering i centrallagret och automaterna kvällen före start (svensk tid). */
export const STOCK_COUNT_DAY: IsoDate = "2026-10-12";
export const WAREHOUSE_COUNT_TIME = "17:00:00";
export const MACHINE_COUNT_TIME = "18:00:00";

/** Påfyllningsdagar (före öppning). */
export const REFILL_DAYS: readonly IsoDate[] = [
  "2026-10-15",
  "2026-10-17",
  "2026-10-20",
  "2026-10-22",
  "2026-10-24",
  "2026-10-26",
  "2026-10-28",
  "2026-10-30",
];
/** Påfyllningstid per automat (svensk tid), i SEED_MACHINES ordning. */
export const REFILL_TIMES: readonly string[] = ["09:10:00", "09:30:00", "09:50:00"];

/** Ny leverans till centrallagret (samma dag som det nya inköpspriset). */
export const WAREHOUSE_RECEIPT = {
  title: "30th Celebration",
  day: "2026-10-27" as IsoDate,
  time: "08:30:00",
  /** Minsta leverans (fylls upp till närmaste hela låda om påfyllningarna kräver mer). */
  minQuantity: 120,
  boxSize: 12,
} as const;

/** Buffert över det största behovet mellan två påfyllningar. */
export const PAR_BUFFER = 3;
/** Antal par (automat, titel) som ska sluta lågt (1–2 pack kvar). */
export const LOW_STOCK_PAIRS = 3;

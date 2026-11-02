/**
 * Demoorganisationen "Nordljus Automater AB (demo)": påhittade butiker,
 * automater, titlar, avtal, leverantörer och mål, så att panelen kan visas
 * utan att röja verksamhetens riktiga siffror.
 *
 * Allt här är fasta värden. Försäljningen, lagret och inköpen räknas fram av
 * generatorn (generate.ts) med en seedad slumpgenerator, så att samma version
 * av koden alltid ger exakt samma demo.
 *
 * Perioden är 1 feb – 2 nov 2026 (svensk tid). Butikerna ligger i Mälardalen,
 * så att en påfyllare och ett centrallager är rimligt. Namnen på butiker,
 * personer och företag är påhittade; e-postadresserna använder domänen
 * `.example` (reserverad, når aldrig någon).
 */

import type { IsoDate } from "@/domain/types";

export const DEMO_ORGANIZATION = {
  name: "Nordljus Automater AB (demo)",
  slug: "nordljus-demo",
} as const;

/** Varianten med 100 000+ order (flaggan --stor), för prestandamätning. */
export const DEMO_ORGANIZATION_LARGE = {
  name: "Nordljus Automater AB (demo, stor)",
  slug: "nordljus-demo-stor",
} as const;

export type DemoRole = "owner" | "viewer" | "refiller";

export interface DemoUser {
  email: string;
  fullName: string;
  role: DemoRole;
}

export const DEMO_USERS = {
  owner: { email: "demo@binderlab.local", fullName: "Elin Strand", role: "owner" },
  viewer: { email: "demo-lasare@binderlab.local", fullName: "Johan Berg", role: "viewer" },
  refiller: {
    email: "demo-pafyllare@binderlab.local",
    fullName: "Amir Haddad",
    role: "refiller",
  },
} as const satisfies Record<string, DemoUser>;

/** Första och sista dagen med försäljning (svensk tid). */
export const DEMO_PERIOD = { start: "2026-02-01", end: "2026-11-02" } as const satisfies {
  start: IsoDate;
  end: IsoDate;
};

/** Sista dagen säljer automaterna bara fram till kl. 12 (demon "körs" mitt på dagen). */
export const DEMO_LAST_DAY_CUTOFF_HOUR = 12;

/** Tidpunkten demon beskriver ("nu"), svensk tid. Larmen utvärderas då. */
export const DEMO_NOW = { date: "2026-11-02" as IsoDate, time: "12:00:00" } as const;

/** Första ordernumret (Order No.) och Awish interna ID. */
export const DEMO_FIRST_ORDER_NO = 100_001;
export const DEMO_FIRST_AWISH_ID = 700_001;

/** Fröet för generatorn. Ändras det ändras all demodata. */
export const DEMO_RANDOM_SEED = 20_260_201;

/**
 * Skalan för --stor: efterfrågan och kapacitet gångras, så att perioden ger
 * minst 100 000 order (kontrolleras i generate.test.ts).
 */
export const DEMO_LARGE_SCALE = 7.4;
export const DEMO_LARGE_MIN_ORDERS = 100_000;

// ---------------------------------------------------------------------------
// Butiker och avtal
// ---------------------------------------------------------------------------

export type StoreKey = "s1" | "s2" | "s3" | "s4" | "s5" | "s6" | "s7";

export interface DemoStore {
  key: StoreKey;
  name: string;
  address: string;
  city: string;
  storeType: string;
  openHoursPerWeek: number;
  areaSqm: number;
  contactName: string;
  email: string;
  phone: string;
  /** Första och sista timmen med försäljning (svensk tid, sista timmen ingår). */
  hours: { first: number; last: number };
}

export const DEMO_STORES: readonly DemoStore[] = [
  {
    key: "s1",
    name: "Kortkammaren",
    address: "Smedjegatan 14, 722 15 Västerås",
    city: "Västerås",
    storeType: "Spelbutik",
    openHoursPerWeek: 52,
    areaSqm: 140,
    contactName: "Linnea Ek",
    email: "linnea@kortkammaren.example",
    phone: "021-10 20 30",
    hours: { first: 11, last: 18 },
  },
  {
    key: "s2",
    name: "Köpcentrum Kvarnhagen",
    address: "Kvarnhagsvägen 2, 632 20 Eskilstuna",
    city: "Eskilstuna",
    storeType: "Köpcentrum",
    openHoursPerWeek: 70,
    areaSqm: 18_000,
    contactName: "Per Holm",
    email: "centrumledning@kvarnhagen.example",
    phone: "016-44 55 66",
    hours: { first: 10, last: 19 },
  },
  {
    key: "s3",
    name: "Stationskiosken Arboga",
    address: "Järnvägsgatan 1, 732 30 Arboga",
    city: "Arboga",
    storeType: "Kiosk",
    openHoursPerWeek: 84,
    areaSqm: 45,
    contactName: "Sanna Vik",
    email: "kiosken@stationen-arboga.example",
    phone: "0589-12 34 56",
    hours: { first: 8, last: 20 },
  },
  {
    key: "s4",
    name: "Lekboden",
    address: "Drottninggatan 33, 702 22 Örebro",
    city: "Örebro",
    storeType: "Leksaksbutik",
    openHoursPerWeek: 56,
    areaSqm: 320,
    contactName: "Karin Sjöberg",
    email: "karin@lekboden.example",
    phone: "019-70 80 90",
    hours: { first: 10, last: 17 },
  },
  {
    key: "s5",
    name: "Kägelhallen Bowling",
    address: "Hamngatan 8, 731 32 Köping",
    city: "Köping",
    storeType: "Nöjeshall",
    openHoursPerWeek: 60,
    areaSqm: 1_200,
    contactName: "Oskar Lund",
    email: "info@kagelhallen.example",
    phone: "0221-55 66 77",
    hours: { first: 13, last: 21 },
  },
  {
    key: "s6",
    name: "Bio Fyren",
    address: "Kungsgatan 5, 745 31 Enköping",
    city: "Enköping",
    storeType: "Biograf",
    openHoursPerWeek: 45,
    areaSqm: 900,
    contactName: "Maria Dahl",
    email: "maria@biofyren.example",
    phone: "0171-22 33 44",
    hours: { first: 14, last: 21 },
  },
  {
    key: "s7",
    name: "Seriecentralen",
    address: "Stora torget 4, 733 30 Sala",
    city: "Sala",
    storeType: "Serie- och spelbutik",
    openHoursPerWeek: 48,
    areaSqm: 110,
    contactName: "Viktor Ahl",
    email: "viktor@seriecentralen.example",
    phone: "0224-80 90 10",
    hours: { first: 10, last: 17 },
  },
];

export interface DemoContract {
  title: string;
  validFrom: IsoDate;
  validTo: IsoDate | null;
  noticePeriodMonths: number | null;
  renewalMonths: number | null;
  terminatedOn: IsoDate | null;
  terms: string;
}

export interface DemoAgreement {
  storeKey: StoreKey;
  validFrom: IsoDate;
  validTo: IsoDate | null;
  commissionBp: number | null;
  monthlyRentOre: number | null;
  note: string;
  /** Avtalet (kontraktet) som villkoren hör till, nyckel i DEMO_CONTRACTS. */
  contractKey: string;
}

/** Kontrakt per butik. s2 löper ut 31 dec 2026 (inom 90 dagar från demons "nu"). */
export const DEMO_CONTRACTS: Readonly<Record<string, DemoContract & { storeKey: StoreKey }>> = {
  c1: {
    storeKey: "s1",
    title: "Placeringsavtal Kortkammaren",
    validFrom: "2026-02-01",
    validTo: null,
    noticePeriodMonths: 3,
    renewalMonths: null,
    terminatedOn: null,
    terms: "Provision 15 % på försäljningen exkl. moms. Tillsvidare, tre månaders uppsägning.",
  },
  c2: {
    storeKey: "s2",
    title: "Hyresavtal Kvarnhagen, två automatplatser",
    validFrom: "2026-02-01",
    validTo: "2026-12-31",
    noticePeriodMonths: 1,
    renewalMonths: 12,
    terminatedOn: null,
    terms:
      "Fast hyra 2 500 kr/mån för två platser vid entrén och food court. Förlängs med 12 månader om ingen part säger upp senast en månad före utgång.",
  },
  c3: {
    storeKey: "s3",
    title: "Placeringsavtal Stationskiosken",
    validFrom: "2026-02-01",
    validTo: null,
    noticePeriodMonths: 1,
    renewalMonths: null,
    terminatedOn: "2026-06-14",
    terms: "Provision 10 % och hyra 400 kr/mån. Uppsagt av oss: för låg försäljning.",
  },
  c4: {
    storeKey: "s4",
    title: "Placeringsavtal Lekboden",
    validFrom: "2026-02-01",
    validTo: null,
    noticePeriodMonths: 2,
    renewalMonths: null,
    terminatedOn: null,
    terms: "Provision 12 % på försäljningen exkl. moms. Andra automaten från september.",
  },
  c5: {
    storeKey: "s5",
    title: "Hyresavtal Kägelhallen",
    validFrom: "2026-03-01",
    validTo: "2027-02-28",
    noticePeriodMonths: 2,
    renewalMonths: 12,
    terminatedOn: null,
    terms: "Fast hyra 1 800 kr/mån inklusive el.",
  },
  c6: {
    storeKey: "s6",
    title: "Placeringsavtal Bio Fyren",
    validFrom: "2026-05-16",
    validTo: null,
    noticePeriodMonths: 3,
    renewalMonths: null,
    terminatedOn: null,
    terms: "Provision 10 % och hyra 900 kr/mån.",
  },
  c7: {
    storeKey: "s7",
    title: "Placeringsavtal Seriecentralen",
    validFrom: "2026-02-01",
    validTo: null,
    noticePeriodMonths: 3,
    renewalMonths: null,
    terminatedOn: null,
    terms: "Provision 15 %, sänkt till 12 % från 1 juli när andra automaten flyttade in.",
  },
};

export const DEMO_AGREEMENTS: readonly DemoAgreement[] = [
  {
    storeKey: "s1",
    validFrom: "2026-02-01",
    validTo: null,
    commissionBp: 1_500,
    monthlyRentOre: null,
    note: "Provision 15 %",
    contractKey: "c1",
  },
  {
    storeKey: "s2",
    validFrom: "2026-02-01",
    validTo: "2026-12-31",
    commissionBp: null,
    monthlyRentOre: 250_000,
    note: "Fast hyra 2 500 kr/mån, löper ut 31 dec",
    contractKey: "c2",
  },
  {
    storeKey: "s3",
    validFrom: "2026-02-01",
    validTo: "2026-06-14",
    commissionBp: 1_000,
    monthlyRentOre: 40_000,
    note: "Provision 10 % + hyra 400 kr/mån (avslutat)",
    contractKey: "c3",
  },
  {
    storeKey: "s4",
    validFrom: "2026-02-01",
    validTo: null,
    commissionBp: 1_200,
    monthlyRentOre: null,
    note: "Provision 12 %",
    contractKey: "c4",
  },
  {
    storeKey: "s5",
    validFrom: "2026-03-01",
    validTo: "2027-02-28",
    commissionBp: null,
    monthlyRentOre: 180_000,
    note: "Fast hyra 1 800 kr/mån",
    contractKey: "c5",
  },
  {
    storeKey: "s6",
    validFrom: "2026-05-16",
    validTo: null,
    commissionBp: 1_000,
    monthlyRentOre: 90_000,
    note: "Provision 10 % + hyra 900 kr/mån",
    contractKey: "c6",
  },
  {
    storeKey: "s7",
    validFrom: "2026-02-01",
    validTo: "2026-06-30",
    commissionBp: 1_500,
    monthlyRentOre: null,
    note: "Provision 15 %",
    contractKey: "c7",
  },
  {
    storeKey: "s7",
    validFrom: "2026-07-01",
    validTo: null,
    commissionBp: 1_200,
    monthlyRentOre: null,
    note: "Provision 12 % (omförhandlat när andra automaten kom)",
    contractKey: "c7",
  },
];

// ---------------------------------------------------------------------------
// Automater
// ---------------------------------------------------------------------------

export interface DemoPlacement {
  storeKey: StoreKey;
  validFrom: IsoDate;
  validTo: IsoDate | null;
  /** Efterfrågan i den här butiken: order per dag vid vikt 100 (före säsong och tillväxt). */
  baseRate: number;
}

export interface DemoMachine {
  code: string;
  name: string;
  serial: string;
  /** "Order Machine" i Awish. */
  awishName: string;
  activeFrom: IsoDate;
  placements: readonly DemoPlacement[];
  /** Påfyllningsdagar (1 = måndag … 7 = söndag) och klockslag (före öppning). */
  refillWeekdays: readonly number[];
  refillTime: string;
  /** Pack per plats (spiral). Små automater tar slut fortare. */
  packsPerSlot: number;
  /** Automaten säljer inget från och med den här dagen (fel, se kundärendena). */
  faultFrom?: IsoDate;
  investments: readonly {
    kind: "purchase" | "installation" | "other";
    amountOre: number;
    investedOn: IsoDate;
    depreciationMonths: number | null;
    note: string;
  }[];
}

const purchase = (investedOn: IsoDate, amountOre = 3_990_000) => ({
  kind: "purchase" as const,
  amountOre,
  investedOn,
  depreciationMonths: 60,
  note: "Automat (ny)",
});
const installation = (investedOn: IsoDate, amountOre = 250_000) => ({
  kind: "installation" as const,
  amountOre,
  investedOn,
  depreciationMonths: 60,
  note: "Frakt och installation",
});

export const DEMO_MACHINES: readonly DemoMachine[] = [
  {
    code: "NA-01",
    name: "Automat 01",
    serial: "NL-2601-0101",
    awishName: "NA-01 Kortkammaren",
    activeFrom: "2026-02-01",
    placements: [{ storeKey: "s1", validFrom: "2026-02-01", validTo: null, baseRate: 9 }],
    refillWeekdays: [1, 3, 5],
    refillTime: "08:40:00",
    packsPerSlot: 10,
    investments: [purchase("2026-01-20"), installation("2026-01-30")],
  },
  {
    code: "NA-02",
    name: "Automat 02",
    serial: "NL-2604-0102",
    awishName: "NA-02 Kortkammaren 2",
    activeFrom: "2026-04-11",
    placements: [{ storeKey: "s1", validFrom: "2026-04-11", validTo: null, baseRate: 5 }],
    refillWeekdays: [1, 3, 5],
    refillTime: "08:55:00",
    packsPerSlot: 8,
    investments: [purchase("2026-04-02", 3_790_000), installation("2026-04-10", 150_000)],
  },
  {
    code: "NA-03",
    name: "Automat 03",
    serial: "NL-2601-0103",
    awishName: "NA-03 Kvarnhagen entré",
    activeFrom: "2026-02-01",
    placements: [{ storeKey: "s2", validFrom: "2026-02-01", validTo: null, baseRate: 8 }],
    refillWeekdays: [2, 5],
    refillTime: "09:10:00",
    packsPerSlot: 10,
    investments: [purchase("2026-01-20"), installation("2026-01-31")],
  },
  {
    code: "NA-04",
    name: "Automat 04",
    serial: "NL-2601-0104",
    awishName: "NA-04 Kvarnhagen food court",
    activeFrom: "2026-02-01",
    placements: [{ storeKey: "s2", validFrom: "2026-02-01", validTo: null, baseRate: 6 }],
    refillWeekdays: [2, 5],
    refillTime: "09:25:00",
    packsPerSlot: 8,
    investments: [purchase("2026-01-20"), installation("2026-01-31")],
  },
  {
    code: "NA-05",
    name: "Automat 05",
    serial: "NL-2601-0105",
    awishName: "NA-05 Flyttbar",
    activeFrom: "2026-02-01",
    placements: [
      { storeKey: "s3", validFrom: "2026-02-01", validTo: "2026-06-14", baseRate: 2.6 },
      { storeKey: "s7", validFrom: "2026-06-15", validTo: null, baseRate: 5.5 },
    ],
    refillWeekdays: [4],
    refillTime: "07:40:00",
    packsPerSlot: 8,
    investments: [
      purchase("2026-01-22", 3_490_000),
      installation("2026-01-31", 120_000),
      {
        kind: "other",
        amountOre: 180_000,
        investedOn: "2026-06-15",
        depreciationMonths: null,
        note: "Flytt Arboga → Sala",
      },
    ],
  },
  {
    code: "NA-06",
    name: "Automat 06",
    serial: "NL-2601-0106",
    awishName: "NA-06 Lekboden",
    activeFrom: "2026-02-01",
    placements: [{ storeKey: "s4", validFrom: "2026-02-01", validTo: null, baseRate: 6 }],
    refillWeekdays: [2, 6],
    refillTime: "09:00:00",
    packsPerSlot: 6,
    investments: [purchase("2026-01-22"), installation("2026-01-31")],
  },
  {
    code: "NA-07",
    name: "Automat 07",
    serial: "NL-2603-0107",
    awishName: "NA-07 Kägelhallen",
    activeFrom: "2026-03-02",
    placements: [{ storeKey: "s5", validFrom: "2026-03-02", validTo: null, baseRate: 5 }],
    refillWeekdays: [3, 6],
    refillTime: "11:30:00",
    packsPerSlot: 8,
    faultFrom: "2026-10-31",
    investments: [purchase("2026-02-20"), installation("2026-03-01")],
  },
  {
    code: "NA-08",
    name: "Automat 08",
    serial: "NL-2605-0108",
    awishName: "NA-08 Bio Fyren",
    activeFrom: "2026-05-16",
    placements: [{ storeKey: "s6", validFrom: "2026-05-16", validTo: null, baseRate: 5 }],
    refillWeekdays: [4, 7],
    refillTime: "12:30:00",
    packsPerSlot: 8,
    investments: [purchase("2026-05-05", 3_890_000), installation("2026-05-15")],
  },
  {
    code: "NA-09",
    name: "Automat 09",
    serial: "NL-2601-0109",
    awishName: "NA-09 Seriecentralen",
    activeFrom: "2026-02-01",
    placements: [{ storeKey: "s7", validFrom: "2026-02-01", validTo: null, baseRate: 5 }],
    refillWeekdays: [4],
    refillTime: "08:45:00",
    packsPerSlot: 6,
    investments: [purchase("2026-01-22", 3_490_000), installation("2026-01-31", 120_000)],
  },
  {
    code: "NA-10",
    name: "Automat 10",
    serial: "NL-2609-0110",
    awishName: "NA-10 Lekboden 2",
    activeFrom: "2026-09-12",
    placements: [{ storeKey: "s4", validFrom: "2026-09-12", validTo: null, baseRate: 4 }],
    refillWeekdays: [2, 6],
    refillTime: "09:15:00",
    packsPerSlot: 8,
    investments: [purchase("2026-09-01", 3_990_000), installation("2026-09-11")],
  },
];

/** Automaten som flyttar mellan butiker. */
export const DEMO_MOVED_MACHINE = "NA-05";
/** Automaten som slutat sälja (fel) i slutet av perioden. */
export const DEMO_FAULTY_MACHINE = "NA-07";

// ---------------------------------------------------------------------------
// Titlar
// ---------------------------------------------------------------------------

export type SupplierKey = "nordisk" | "kortdepan";

export interface DemoTitle {
  /** Namnet i Awish ("Name"), blir alias. */
  name: string;
  series: string;
  /** Första dagen titeln får säljas (släppdag för nya titlar). */
  availableFrom: IsoDate;
  /** Sista dagen titeln fylls på (sedan säljs resten ut). */
  lastRefill: IsoDate | null;
  /** Grundpopularitet (vikt). */
  popularity: number;
  /** Släppkurva: extra efterfrågan peak × e^(−dagar/tau) efter släppdagen. */
  release?: { peak: number; tauDays: number };
  /** Platser (spiraler) per automat. */
  slots: number;
  /** Försäljningspris i öre från ett datum. */
  salePrices: readonly { validFrom: IsoDate; ore: number }[];
  /** Inköpspris per pack. Tom lista = saknar inköpspris (avsiktligt). */
  purchasePrices: readonly { validFrom: IsoDate; unitCostOre: number; note: string }[];
  supplier: SupplierKey;
  /** Pack per låda hos leverantören. */
  boxSize: number;
  /** Förhandsbeställning till släppet (pack, före skalan), levereras dagen före. */
  preorderPacks?: number;
}

const start = (unitCostOre: number) => ({
  validFrom: "2026-01-15" as IsoDate,
  unitCostOre,
  note: "Inköpspris från leverantörens prislista",
});

export const DEMO_TITLES: readonly DemoTitle[] = [
  {
    name: "Scarlet & Violet 151",
    series: "Pokémon TCG",
    availableFrom: "2026-02-01",
    lastRefill: null,
    popularity: 150,
    slots: 2,
    salePrices: [
      { validFrom: "2026-02-01", ore: 19_900 },
      { validFrom: "2026-06-01", ore: 21_900 },
    ],
    purchasePrices: [
      start(12_800),
      { validFrom: "2026-05-25", unitCostOre: 13_900, note: "Ny prislista, dyrare inköp" },
    ],
    supplier: "nordisk",
    boxSize: 36,
  },
  {
    name: "Obsidian Flames",
    series: "Pokémon TCG",
    availableFrom: "2026-02-01",
    lastRefill: "2026-05-31",
    popularity: 70,
    slots: 1,
    salePrices: [{ validFrom: "2026-02-01", ore: 12_900 }],
    purchasePrices: [start(7_600)],
    supplier: "nordisk",
    boxSize: 36,
  },
  {
    name: "Paradox Rift",
    series: "Pokémon TCG",
    availableFrom: "2026-02-01",
    lastRefill: "2026-07-31",
    popularity: 60,
    slots: 1,
    salePrices: [{ validFrom: "2026-02-01", ore: 12_900 }],
    purchasePrices: [start(7_700)],
    supplier: "nordisk",
    boxSize: 36,
  },
  {
    name: "Temporal Forces",
    series: "Pokémon TCG",
    availableFrom: "2026-02-01",
    lastRefill: null,
    popularity: 75,
    slots: 1,
    salePrices: [{ validFrom: "2026-02-01", ore: 13_900 }],
    purchasePrices: [start(8_400)],
    supplier: "nordisk",
    boxSize: 36,
  },
  {
    name: "Twilight Masquerade",
    series: "Pokémon TCG",
    availableFrom: "2026-02-01",
    lastRefill: null,
    popularity: 80,
    slots: 1,
    salePrices: [
      { validFrom: "2026-02-01", ore: 13_900 },
      { validFrom: "2026-04-15", ore: 14_900 },
    ],
    purchasePrices: [start(8_600)],
    supplier: "nordisk",
    boxSize: 36,
  },
  {
    name: "Surging Sparks",
    series: "Pokémon TCG",
    availableFrom: "2026-02-01",
    lastRefill: null,
    popularity: 95,
    slots: 1,
    salePrices: [{ validFrom: "2026-02-01", ore: 14_900 }],
    purchasePrices: [
      start(8_800),
      { validFrom: "2026-07-01", unitCostOre: 9_200, note: "Prishöjning från leverantören" },
    ],
    supplier: "nordisk",
    boxSize: 36,
  },
  {
    name: "Prismatic Evolution",
    series: "Pokémon TCG",
    availableFrom: "2026-02-01",
    lastRefill: null,
    popularity: 120,
    slots: 2,
    salePrices: [
      { validFrom: "2026-02-01", ore: 22_900 },
      { validFrom: "2026-08-17", ore: 19_900 },
    ],
    purchasePrices: [
      start(15_500),
      { validFrom: "2026-08-10", unitCostOre: 13_200, note: "Lägre inköpspris när hypen lagt sig" },
    ],
    supplier: "nordisk",
    boxSize: 36,
  },
  {
    name: "Journey Together",
    series: "Pokémon TCG",
    availableFrom: "2026-03-27",
    lastRefill: null,
    popularity: 85,
    release: { peak: 2.5, tauDays: 10 },
    slots: 1,
    salePrices: [{ validFrom: "2026-03-27", ore: 15_900 }],
    purchasePrices: [{ validFrom: "2026-03-20", unitCostOre: 9_600, note: "Förhandsbeställning" }],
    supplier: "nordisk",
    boxSize: 36,
    preorderPacks: 252,
  },
  {
    name: "Destined Rivals",
    series: "Pokémon TCG",
    availableFrom: "2026-05-30",
    lastRefill: null,
    popularity: 90,
    release: { peak: 3, tauDays: 10 },
    slots: 1,
    salePrices: [{ validFrom: "2026-05-30", ore: 16_900 }],
    purchasePrices: [{ validFrom: "2026-05-20", unitCostOre: 10_300, note: "Förhandsbeställning" }],
    supplier: "nordisk",
    boxSize: 36,
    preorderPacks: 288,
  },
  {
    name: "Mega Evolution",
    series: "Pokémon TCG",
    availableFrom: "2026-09-19",
    lastRefill: null,
    popularity: 110,
    release: { peak: 5, tauDays: 14 },
    slots: 2,
    salePrices: [{ validFrom: "2026-09-19", ore: 17_900 }],
    purchasePrices: [{ validFrom: "2026-09-10", unitCostOre: 10_900, note: "Förhandsbeställning" }],
    supplier: "nordisk",
    boxSize: 36,
    preorderPacks: 324,
  },
  {
    name: "Phantasmal Flames",
    series: "Pokémon TCG",
    // Släpps efter demons "nu": har inköpspris och släppplan men ingen försäljning.
    availableFrom: "2026-11-14",
    lastRefill: null,
    popularity: 100,
    release: { peak: 4, tauDays: 12 },
    slots: 2,
    salePrices: [{ validFrom: "2026-11-14", ore: 17_900 }],
    purchasePrices: [{ validFrom: "2026-11-01", unitCostOre: 10_900, note: "Förhandsbeställning" }],
    supplier: "nordisk",
    boxSize: 36,
    preorderPacks: 324,
  },
  {
    name: "Mystery Pack",
    series: "Nordljus egna",
    availableFrom: "2026-02-01",
    lastRefill: null,
    popularity: 90,
    slots: 1,
    salePrices: [
      { validFrom: "2026-02-01", ore: 9_900 },
      { validFrom: "2026-09-01", ore: 10_900 },
    ],
    purchasePrices: [start(5_900)],
    supplier: "kortdepan",
    boxSize: 24,
  },
  {
    name: "Mystery Pack Premium",
    series: "Nordljus egna",
    availableFrom: "2026-02-01",
    lastRefill: null,
    popularity: 35,
    slots: 1,
    salePrices: [{ validFrom: "2026-02-01", ore: 24_900 }],
    purchasePrices: [start(16_200)],
    supplier: "kortdepan",
    boxSize: 12,
  },
  {
    name: "One Piece: Romance Dawn",
    series: "One Piece Card Game",
    availableFrom: "2026-08-08",
    lastRefill: null,
    popularity: 45,
    slots: 1,
    salePrices: [{ validFrom: "2026-08-08", ore: 12_900 }],
    purchasePrices: [],
    supplier: "kortdepan",
    boxSize: 24,
    preorderPacks: 96,
  },
  {
    name: "Lorcana: Into the Inklands",
    series: "Disney Lorcana",
    availableFrom: "2026-08-22",
    lastRefill: null,
    popularity: 35,
    slots: 1,
    salePrices: [{ validFrom: "2026-08-22", ore: 11_900 }],
    purchasePrices: [],
    supplier: "kortdepan",
    boxSize: 24,
    preorderPacks: 72,
  },
];

/** Titlarna som avsiktligt saknar inköpspris. */
export const DEMO_TITLES_WITHOUT_PRICE = DEMO_TITLES.filter(
  (t) => t.purchasePrices.length === 0,
).map((t) => t.name);

/** Den stora släppet i september. */
export const DEMO_BIG_RELEASE = "Mega Evolution";

/** Titeln som tar slut i centrallagret i juli (leverantören restnoterar). */
export const DEMO_BACKORDER = {
  title: "Prismatic Evolution",
  /** Inköpsorder lagda i intervallet levereras först `deliveredOn`. */
  orderedFrom: "2026-06-08" as IsoDate,
  orderedTo: "2026-07-20" as IsoDate,
  deliveredOn: "2026-07-27" as IsoDate,
} as const;

/** Betalmetoder i Awish med heltalsvikter. */
export const DEMO_PAYMENT_METHODS: readonly { name: string; weight: number }[] = [
  { name: "Card", weight: 68 },
  { name: "Swish", weight: 32 },
];

// ---------------------------------------------------------------------------
// Leverantörer
// ---------------------------------------------------------------------------

export interface DemoSupplier {
  key: SupplierKey;
  name: string;
  contactName: string;
  email: string;
  phone: string;
  leadTimeDays: number;
}

export const DEMO_SUPPLIERS: readonly DemoSupplier[] = [
  {
    key: "nordisk",
    name: "Nordisk Hobbygrossist AB",
    contactName: "Henrik Falk",
    email: "order@nordiskhobby.example",
    phone: "08-123 456 70",
    leadTimeDays: 6,
  },
  {
    key: "kortdepan",
    name: "Kortdepån Skandinavien AB",
    contactName: "Ida Norén",
    email: "inkop@kortdepan.example",
    phone: "031-765 43 21",
    leadTimeDays: 10,
  },
];

/** Inköpsrutin: varje måndag beställs det som behövs för täckningen. */
export const DEMO_PURCHASING = {
  weekday: 1,
  /** Dagar framåt som lagret ska täcka efter leveransen. */
  coverDays: 21,
  /** Dagar bakåt som takten räknas på. */
  rateWindowDays: 21,
} as const;

// ---------------------------------------------------------------------------
// Mål, utgångsläge, effekt, kostnader, ägare
// ---------------------------------------------------------------------------

/** Intäktsmål per månad för organisationen, i kronor (före skalan). */
export const DEMO_REVENUE_GOALS_KR: Readonly<Record<string, number>> = {
  "2026-02": 150_000,
  "2026-03": 190_000,
  "2026-04": 230_000,
  "2026-05": 250_000,
  "2026-06": 255_000,
  "2026-07": 260_000,
  "2026-08": 300_000,
  "2026-09": 340_000,
  "2026-10": 420_000,
  "2026-11": 400_000,
  "2026-12": 480_000,
};

/** Vinstmål = 30 % av intäktsmålet. */
export const DEMO_PROFIT_GOAL_BP = 3_000;

/** Antal automater i drift som mål per månad. */
export const DEMO_ACTIVE_MACHINE_GOALS: Readonly<Record<string, number>> = {
  "2026-02": 7,
  "2026-03": 8,
  "2026-04": 9,
  "2026-05": 9,
  "2026-06": 10,
  "2026-07": 10,
  "2026-08": 10,
  "2026-09": 11,
  "2026-10": 11,
  "2026-11": 12,
  "2026-12": 12,
};

/** Utgångsläget (uppmätt i januari, innan panelen togs i bruk). */
export const DEMO_BASELINES = [
  {
    metric: "profit_per_machine_month",
    value: 520_000,
    unit: "ore",
    source: "Bokslut januari 2026, sex automater",
  },
  { metric: "stockout_days_month", value: 26, unit: "days", source: "Påfyllningsloggen januari" },
  {
    metric: "refill_hours_month",
    value: 2_520,
    unit: "minutes",
    source: "Körjournal januari (42 h)",
  },
  {
    metric: "admin_hours_month",
    value: 1_080,
    unit: "minutes",
    source: "Tidrapport januari (18 h)",
  },
] as const;
export const DEMO_BASELINE_PERIOD = { from: "2026-01-01", to: "2026-01-31" } as const;

/** Effekt per månad: slutsålda dagar, påfyllningstid och admintid (minuter). */
export const DEMO_EFFECT: Readonly<
  Record<string, { stockoutDays: number; refillMinutes: number; adminMinutes: number }>
> = {
  "2026-02": { stockoutDays: 22, refillMinutes: 2_460, adminMinutes: 960 },
  "2026-03": { stockoutDays: 19, refillMinutes: 2_340, adminMinutes: 780 },
  "2026-04": { stockoutDays: 15, refillMinutes: 2_280, adminMinutes: 600 },
  "2026-05": { stockoutDays: 13, refillMinutes: 2_220, adminMinutes: 540 },
  "2026-06": { stockoutDays: 12, refillMinutes: 2_160, adminMinutes: 480 },
  "2026-07": { stockoutDays: 16, refillMinutes: 2_100, adminMinutes: 450 },
  "2026-08": { stockoutDays: 10, refillMinutes: 2_040, adminMinutes: 420 },
  "2026-09": { stockoutDays: 11, refillMinutes: 2_100, adminMinutes: 420 },
  "2026-10": { stockoutDays: 8, refillMinutes: 1_980, adminMinutes: 390 },
};

export const DEMO_EFFECT_SETTINGS = { hourlyCostOre: 35_000, stockoutDayValueOre: null } as const;

export const DEMO_FIXED_COSTS: readonly {
  name: string;
  category: "insurance" | "software" | "transport" | "storage" | "other";
  amountOre: number;
  interval: "month" | "quarter" | "year";
  startsOn: IsoDate;
  endsOn: IsoDate | null;
  machineCode: string | null;
  note: string;
}[] = [
  {
    name: "Försäkring automater",
    category: "insurance",
    amountOre: 540_000,
    interval: "year",
    startsOn: "2026-02-01",
    endsOn: null,
    machineCode: null,
    note: "Egendom och avbrott, alla automater",
  },
  {
    name: "Awish licens och SIM",
    category: "software",
    amountOre: 149_000,
    interval: "month",
    startsOn: "2026-02-01",
    endsOn: null,
    machineCode: null,
    note: "Kortläsare, mobildata och portal",
  },
  {
    name: "Leasingbil påfyllning",
    category: "transport",
    amountOre: 420_000,
    interval: "month",
    startsOn: "2026-02-01",
    endsOn: null,
    machineCode: null,
    note: "Inklusive drivmedel (snitt)",
  },
  {
    name: "Förråd Västerås",
    category: "storage",
    amountOre: 95_000,
    interval: "month",
    startsOn: "2026-02-01",
    endsOn: null,
    machineCode: null,
    note: "Centrallagret, 12 m²",
  },
  {
    name: "Redovisningsbyrå",
    category: "other",
    amountOre: 450_000,
    interval: "quarter",
    startsOn: "2026-01-01",
    endsOn: null,
    machineCode: null,
    note: "Bokföring och bokslut",
  },
  {
    name: "Service avtal NA-05",
    category: "other",
    amountOre: 30_000,
    interval: "month",
    startsOn: "2026-02-01",
    endsOn: "2026-06-30",
    machineCode: "NA-05",
    note: "Begagnad automat, serviceavtal första halvåret",
  },
];

export const DEMO_OWNER_SHARES = [
  { userKey: "owner", holderName: "Elin Strand", shareBp: 6_000 },
  { userKey: "viewer", holderName: "Johan Berg", shareBp: 4_000 },
] as const;
export const DEMO_OWNER_SHARES_FROM: IsoDate = "2026-01-01";

// ---------------------------------------------------------------------------
// Expansion, rapportmottagare, kundärenden
// ---------------------------------------------------------------------------

export const DEMO_LEADS: readonly {
  name: string;
  stage: "lead" | "contacted" | "meeting" | "agreement" | "installed" | "lost";
  storeType: string;
  city: string;
  openHoursPerWeek: number | null;
  areaSqm: number | null;
  address: string | null;
  contactName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  notes: string | null;
  nextStep: string | null;
  nextStepOn: IsoDate | null;
  commissionBp: number | null;
  monthlyRentOre: number | null;
  purchaseOre: number | null;
  installationOre: number | null;
  storeKey: StoreKey | null;
}[] = [
  {
    name: "Spelhallen Nova",
    stage: "meeting",
    storeType: "Nöjeshall",
    city: "Västerås",
    openHoursPerWeek: 66,
    areaSqm: 1_500,
    address: "Stensborgsgatan 3, 721 32 Västerås",
    contactName: "Felix Ström",
    contactEmail: "felix@spelhallennova.example",
    contactPhone: "021-44 33 22",
    notes: "Mycket ungdomar på helger. Vill ha provision i stället för hyra.",
    nextStep: "Visa förslag på placering vid kassan",
    nextStepOn: "2026-11-10",
    commissionBp: 1_200,
    monthlyRentOre: null,
    purchaseOre: 3_990_000,
    installationOre: 250_000,
    storeKey: null,
  },
  {
    name: "Bokhandeln Torget",
    stage: "contacted",
    storeType: "Bokhandel",
    city: "Eskilstuna",
    openHoursPerWeek: 50,
    areaSqm: 260,
    address: "Fristadstorget 6, 632 20 Eskilstuna",
    contactName: "Anna Lindqvist",
    contactEmail: "anna@bokhandelntorget.example",
    contactPhone: null,
    notes: "Har sålt samlarkort över disk tidigare.",
    nextStep: "Ring och boka möte",
    nextStepOn: "2026-11-05",
    commissionBp: 1_500,
    monthlyRentOre: null,
    purchaseOre: 3_990_000,
    installationOre: 250_000,
    storeKey: null,
  },
  {
    name: "Badhuset Vågen",
    stage: "lead",
    storeType: "Badhus",
    city: "Örebro",
    openHoursPerWeek: 77,
    areaSqm: 4_000,
    address: null,
    contactName: null,
    contactEmail: null,
    contactPhone: null,
    notes: "Tips från Lekboden. Många barnfamiljer på helger.",
    nextStep: "Hitta kontaktperson",
    nextStepOn: null,
    commissionBp: null,
    monthlyRentOre: null,
    purchaseOre: null,
    installationOre: null,
    storeKey: null,
  },
  {
    name: "Kvarnhagen, tredje platsen",
    stage: "agreement",
    storeType: "Köpcentrum",
    city: "Eskilstuna",
    openHoursPerWeek: 70,
    areaSqm: 18_000,
    address: "Kvarnhagsvägen 2, 632 20 Eskilstuna",
    contactName: "Per Holm",
    contactEmail: "centrumledning@kvarnhagen.example",
    contactPhone: "016-44 55 66",
    notes: "Plats vid lekhörnan. Kopplas till omförhandlingen av hyresavtalet (löper ut 31 dec).",
    nextStep: "Skicka avtalsförslag med tre platser",
    nextStepOn: "2026-11-20",
    commissionBp: null,
    monthlyRentOre: 120_000,
    purchaseOre: 3_990_000,
    installationOre: 150_000,
    storeKey: "s2",
  },
  {
    name: "Fritidsgården Lyftet",
    stage: "lost",
    storeType: "Fritidsgård",
    city: "Köping",
    openHoursPerWeek: 30,
    areaSqm: 400,
    address: null,
    contactName: "Nils Ek",
    contactEmail: null,
    contactPhone: null,
    notes: "Tackade nej: kommunen tillåter inte försäljning i lokalen.",
    nextStep: null,
    nextStepOn: null,
    commissionBp: 1_000,
    monthlyRentOre: null,
    purchaseOre: 3_490_000,
    installationOre: 120_000,
    storeKey: null,
  },
  {
    name: "Bio Fyren",
    stage: "installed",
    storeType: "Biograf",
    city: "Enköping",
    openHoursPerWeek: 45,
    areaSqm: 900,
    address: "Kungsgatan 5, 745 31 Enköping",
    contactName: "Maria Dahl",
    contactEmail: "maria@biofyren.example",
    contactPhone: "0171-22 33 44",
    notes: "Installerad 16 maj.",
    nextStep: null,
    nextStepOn: null,
    commissionBp: 1_000,
    monthlyRentOre: 90_000,
    purchaseOre: 3_890_000,
    installationOre: 250_000,
    storeKey: "s6",
  },
];

export const DEMO_RECIPIENTS: readonly {
  name: string;
  email: string;
  kind: "store" | "accountant" | "partner";
  storeKey: StoreKey | null;
  active: boolean;
}[] = [
  {
    name: "Linnea Ek, Kortkammaren",
    email: "linnea@kortkammaren.example",
    kind: "store",
    storeKey: "s1",
    active: true,
  },
  {
    name: "Centrumledningen Kvarnhagen",
    email: "centrumledning@kvarnhagen.example",
    kind: "store",
    storeKey: "s2",
    active: true,
  },
  {
    name: "Karin Sjöberg, Lekboden",
    email: "karin@lekboden.example",
    kind: "store",
    storeKey: "s4",
    active: true,
  },
  {
    name: "Maria Dahl, Bio Fyren",
    email: "maria@biofyren.example",
    kind: "store",
    storeKey: "s6",
    active: true,
  },
  {
    name: "Sanna Vik, Stationskiosken",
    email: "kiosken@stationen-arboga.example",
    kind: "store",
    storeKey: "s3",
    active: false,
  },
  {
    name: "Redovisningsbyrån Siffran AB",
    email: "kund@siffran.example",
    kind: "accountant",
    storeKey: null,
    active: true,
  },
  {
    name: "Johan Berg (delägare)",
    email: "johan.berg@nordljus.example",
    kind: "partner",
    storeKey: null,
    active: true,
  },
];

/** Kundärenden. Ordern väljs av seeden (första ordern i automaten efter tidpunkten). */
export const DEMO_INCIDENTS: readonly {
  machineCode: string;
  kind: string;
  /** Svensk tid. */
  date: IsoDate;
  time: string;
  status: "open" | "in_progress" | "resolved";
  /** Löst: dagar efter start. */
  resolvedAfterDays: number | null;
  description: string;
  actionTaken: string | null;
  /** Koppla till närmaste order i automaten (och återbetala den om refund). */
  linkOrder: boolean;
  refund: boolean;
  customerContact: string | null;
  assignToOwner: boolean;
}[] = [
  {
    machineCode: "NA-03",
    kind: "not_delivered",
    date: "2026-05-09",
    time: "14:20:00",
    status: "resolved",
    resolvedAfterDays: 2,
    description: "Kunden betalade men packet fastnade i spiralen.",
    actionTaken: "Spiralen justerad, pengarna återbetalda via Swish.",
    linkOrder: true,
    refund: true,
    customerContact: "070-111 22 33",
    assignToOwner: true,
  },
  {
    machineCode: "NA-01",
    kind: "wrong_amount",
    date: "2026-08-22",
    time: "13:05:00",
    status: "resolved",
    resolvedAfterDays: 3,
    description: "Kortet drogs två gånger enligt kunden.",
    actionTaken: "Bara en dragning i Awish. Kunden fick tillbaka beloppet som goodwill.",
    linkOrder: true,
    refund: true,
    customerContact: "kund via e-post",
    assignToOwner: true,
  },
  {
    machineCode: "NA-06",
    kind: "store_empty",
    date: "2026-09-26",
    time: "11:10:00",
    status: "resolved",
    resolvedAfterDays: 1,
    description: "Butiken: Mega Evolution slut efter en dag.",
    actionTaken: "Extra påfyllning, större fördelning till Lekboden vid nästa släpp.",
    linkOrder: false,
    refund: false,
    customerContact: null,
    assignToOwner: true,
  },
  {
    machineCode: "NA-09",
    kind: "refund_request",
    date: "2026-10-29",
    time: "15:40:00",
    status: "in_progress",
    resolvedAfterDays: null,
    description: "Kunden ångrar köpet och vill ha pengarna tillbaka (oöppnat pack).",
    actionTaken: null,
    linkOrder: true,
    refund: false,
    customerContact: "kund via butiken",
    assignToOwner: true,
  },
  {
    machineCode: "NA-07",
    kind: "machine_fault",
    date: "2026-10-31",
    time: "13:00:00",
    status: "open",
    resolvedAfterDays: null,
    description: "Kortläsaren svarar inte. Inga köp sedan lördag.",
    actionTaken: null,
    linkOrder: false,
    refund: false,
    customerContact: null,
    assignToOwner: true,
  },
];

/** Utbetalningar: en per månad, betald den 2:a nästa månad. */
export const DEMO_PAYOUT = {
  /** Månaden där leverantören avsiktligt inte betalat ut två order (avvikelsen). */
  deviationMonth: "2026-08",
  /** Antal order som saknas i utbetalningen. */
  missingOrders: 2,
  /** Månaden som har en specifikation per order (så att avvikelsen pekar ut orderna). */
  linesMonth: "2026-08",
  referencePrefix: "AW-UTB-",
} as const;

export const DEMO_DATA_SOURCE_NAME = "Awish (CSV)";

/**
 * Bästa sortiment per automat: vad som säljer bäst i just den automaten, vilka titlar som
 * står still, och ett konkret förslag ("Byt ut White Flair: säljer 0,1/dag. Prova 30th
 * Celebration: säljer 6/dag i 2 andra automater."). Ren funktion utan I/O, bara verklig
 * försäljning.
 *
 * Per automat och titel i perioden:
 *   sortimentsdagar = dagar i perioden då titeln fanns i automatens sortiment
 *                     (machine_slots). Saknas sortimentet för paret: från titelns första
 *                     order i automaten i perioden till periodens slut.
 *   dagar i lager   = sortimentsdagar − slutsålda dagar (förlorad försäljning). En slutsåld
 *                     titel säljer inget, men är inte en dålig titel.
 *   pack per dag    = sålda pack / dagar i lager
 *   vinst per dag   = Σ vinst (prissatta order) / dagar i lager
 * Ett tal räknas bara som säkert med minst ASSORTMENT_MIN_DAYS dagar i lager.
 *
 * Står still (byt ut): titeln finns i sortimentet nu, har säkra tal, är inget mystery pack
 * och sålde inget alls eller högst SLOW_SHARE_BP (25 %) av medianen för automatens titlar
 * (medianen kräver minst SLOW_MIN_TITLES titlar med säkra tal).
 *
 * "Nu" är i dag (`today`), inte periodens sista dag: med en äldre period byts inget ut som
 * redan är borta, och inget föreslås som redan finns i automaten.
 *
 * Förslag (prova): en titel som inte finns i automaten nu, finns i sortimentet i minst en
 * annan automat i dag, har säkra tal där och säljer minst dubbelt så mycket per dag som
 * den som står still, minst SUGGEST_MIN_MILLI (0,1/dag) och mer än gränsen för "står
 * still" i den här automaten. Talet är Σ pack / Σ dagar i lager över de andra automaterna. Bäst
 * först (pack per dag); varje titel föreslås en gång.
 *
 * Mystery packs (`mysteryBatchSize`): facket fylls bara på när det är tomt, med en hel
 * omgång. De visas med sina tal men byts aldrig ut och föreslås aldrig här.
 */

import { addDays, maxDate, minDate, type IsoDate, type Period } from "@/domain";

/** Minsta antal dagar i lager för säkra tal. */
export const ASSORTMENT_MIN_DAYS = 14;
/** Högst så här stor del av automatens median (bp) och titeln står still. */
export const SLOW_SHARE_BP = 2_500;
/** Minsta antal titlar med säkra tal för att räkna medianen. */
export const SLOW_MIN_TITLES = 3;
/** Förslaget ska sälja minst så här många gånger mer än den som står still. */
export const SUGGEST_FACTOR = 2;
/** Förslaget ska sälja minst så här mycket (tusendelar pack per dag: 0,1/dag). */
export const SUGGEST_MIN_MILLI = 100;
/** Högst så här många förslag. */
export const MAX_SUGGESTIONS = 3;

/** En såld order (ett pack). */
export interface AssortmentSale {
  readonly machineId: string;
  readonly titleId: string;
  readonly date: IsoDate;
  /** Orderns vinst i öre, eller null utan inköpspris. */
  readonly profitOre: number | null;
}

export interface AssortmentSlotPeriod {
  readonly machineId: string;
  readonly titleId: string;
  readonly validFrom: IsoDate;
  readonly validTo: IsoDate | null;
}

export interface AssortmentStockoutDay {
  readonly machineId: string;
  readonly titleId: string;
  readonly date: IsoDate;
  /** Del av dagen som var slutsåld, bp (10 000 = hela dagen). */
  readonly weightBp: number;
}

export interface BestAssortmentInput {
  /** Automaten sidan gäller. */
  readonly machineId: string;
  /** Mätperioden (hela dagar med data). */
  readonly period: Period;
  /** Dagens datum: "i sortimentet nu" gäller i dag, inte periodens sista dag. */
  readonly today: IsoDate;
  /** Alla automaters order i perioden. */
  readonly sales: readonly AssortmentSale[];
  readonly slotPeriods: readonly AssortmentSlotPeriod[];
  readonly stockoutDays: readonly AssortmentStockoutDay[];
  readonly titles: readonly {
    readonly id: string;
    readonly name: string;
    readonly mysteryBatchSize?: number | null;
  }[];
}

/** En titel i automaten. */
export interface AssortmentRow {
  readonly titleId: string;
  readonly name: string;
  /** I sortimentet i dag. */
  readonly current: boolean;
  /** Mystery pack: omgångens storlek, annars null. */
  readonly mysteryBatch: number | null;
  readonly units: number;
  /** Dagar i lager, i tiondelar. */
  readonly stockedDayTenths: number;
  /** Minst ASSORTMENT_MIN_DAYS dagar i lager. */
  readonly enough: boolean;
  /** Pack per dag, i tusendelar. null utan dagar i lager. */
  readonly unitsPerDayMilli: number | null;
  /** Vinst per dag, öre. null utan dagar i lager eller utan prissatta order. */
  readonly profitPerDayOre: number | null;
  /** Order utan inköpspris (utanför vinsten). */
  readonly unpricedUnits: number;
  readonly slow: boolean;
}

export interface AssortmentSuggestion {
  readonly swapOut: {
    readonly titleId: string;
    readonly name: string;
    readonly unitsPerDayMilli: number;
  };
  /** null: inget bättre att föreslå. */
  readonly tryInstead: {
    readonly titleId: string;
    readonly name: string;
    readonly unitsPerDayMilli: number;
    /** Antal andra automater talet bygger på. */
    readonly machines: number;
  } | null;
  /** "Byt ut White Flair: säljer 0,1/dag. Prova 30th Celebration: säljer 6/dag i 2 andra automater." */
  readonly text: string;
}

export interface BestAssortment {
  readonly period: Period;
  /** Dagar i perioden. */
  readonly days: number;
  /** Perioden är kortare än ASSORTMENT_MIN_DAYS: inga omdömen eller förslag. */
  readonly tooShort: boolean;
  /** Bäst först (pack per dag, sedan vinst per dag): rubriken säger "säljer bäst". */
  readonly rows: AssortmentRow[];
  readonly best: AssortmentRow | null;
  /** Sämst först. */
  readonly slow: AssortmentRow[];
  readonly suggestions: AssortmentSuggestion[];
  /** Andra automater med säkra tal för minst en titel. */
  readonly otherMachines: number;
  /** Medianen pack per dag för automatens titlar, tusendelar. null med för få titlar. */
  readonly medianUnitsPerDayMilli: number | null;
}

const key = (machineId: string, titleId: string) => `${machineId}\u0000${titleId}`;

function daysBetween(a: IsoDate, b: IsoDate): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000) + 1;
}

/** Pack per dag som text: 100 → "0,1", 6 000 → "6", 2 450 → "2,5". */
export function perDayText(milli: number): string {
  const tenths = Math.round(milli / 100);
  if (tenths === 0 && milli > 0) return "under 0,1";
  return tenths % 10 === 0 ? String(tenths / 10) : `${Math.floor(tenths / 10)},${tenths % 10}`;
}

interface Pair {
  machineId: string;
  titleId: string;
  units: number;
  priced: number;
  profit: number;
  first: IsoDate | null;
  /** Sortimentets dagar i perioden, eller null utan registrerat sortiment. */
  listed: Period[] | null;
  current: boolean;
  stockoutBp: number;
}

function median(values: readonly number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 === 1 ? s[mid]! : Math.round((s[mid - 1]! + s[mid]!) / 2);
}

export function bestAssortment(input: BestAssortmentInput): BestAssortment {
  const { period, machineId, today } = input;
  const days = daysBetween(period.start, period.end);
  const pairs = new Map<string, Pair>();
  const get = (m: string, t: string): Pair => {
    const k = key(m, t);
    let p = pairs.get(k);
    if (!p) {
      p = {
        machineId: m,
        titleId: t,
        units: 0,
        priced: 0,
        profit: 0,
        first: null,
        listed: null,
        current: false,
        stockoutBp: 0,
      };
      pairs.set(k, p);
    }
    return p;
  };

  for (const s of input.slotPeriods) {
    const p = get(s.machineId, s.titleId);
    p.listed ??= [];
    const start = maxDate(s.validFrom, period.start);
    const end = s.validTo === null ? period.end : minDate(s.validTo, period.end);
    if (start <= end) p.listed.push({ start, end });
    if (s.validFrom <= today && (s.validTo === null || s.validTo >= today)) p.current = true;
  }
  for (const o of input.sales) {
    if (o.date < period.start || o.date > period.end) continue;
    const p = get(o.machineId, o.titleId);
    p.units++;
    if (o.profitOre !== null) {
      p.priced++;
      p.profit += o.profitOre;
    }
    if (p.first === null || o.date < p.first) p.first = o.date;
  }
  // Utan registrerat sortiment: titeln räknas från sin första order och som aktuell.
  for (const p of pairs.values()) {
    if (p.listed === null && p.first !== null) {
      p.listed = [{ start: p.first, end: period.end }];
      p.current = true;
    }
  }
  const inListed = (p: Pair, d: IsoDate) =>
    (p.listed ?? []).some((r) => d >= r.start && d <= r.end);
  for (const d of input.stockoutDays) {
    const p = pairs.get(key(d.machineId, d.titleId));
    if (p && inListed(p, d.date)) p.stockoutBp += d.weightBp;
  }

  const stat = (p: Pair) => {
    // Överlappande perioder räknas en gång (dag för dag bara när det behövs).
    const ranges = [...(p.listed ?? [])].sort((a, b) => (a.start < b.start ? -1 : 1));
    let listedDays = 0;
    let cursor: IsoDate | null = null;
    for (const r of ranges) {
      const start: IsoDate = cursor !== null && r.start <= cursor ? addDays(cursor, 1) : r.start;
      if (start > r.end) continue;
      listedDays += daysBetween(start, r.end);
      cursor = r.end;
    }
    const stockedTenths = Math.max(0, listedDays * 10 - Math.round(p.stockoutBp / 1_000));
    const perDay = stockedTenths > 0 ? Math.round((p.units * 10_000) / stockedTenths) : null;
    return {
      stockedTenths,
      enough: stockedTenths >= ASSORTMENT_MIN_DAYS * 10,
      unitsPerDayMilli: perDay,
      profitPerDayOre:
        stockedTenths > 0 && p.priced > 0 ? Math.round((p.profit * 10) / stockedTenths) : null,
    };
  };

  const title = new Map(input.titles.map((t) => [t.id, t]));
  const nameOf = (id: string) => title.get(id)?.name ?? "Okänd titel";
  const mysteryOf = (id: string) => {
    const b = title.get(id)?.mysteryBatchSize;
    return typeof b === "number" && b >= 1 ? b : null;
  };
  const tooShort = days < ASSORTMENT_MIN_DAYS;

  const own = [...pairs.values()].filter(
    (p) => p.machineId === machineId && (p.current || p.units > 0),
  );
  const ownStats = new Map(own.map((p) => [p.titleId, stat(p)]));
  const judged = own.filter(
    (p) => p.current && ownStats.get(p.titleId)!.enough && mysteryOf(p.titleId) === null,
  );
  const med =
    judged.length >= SLOW_MIN_TITLES
      ? median(judged.map((p) => ownStats.get(p.titleId)!.unitsPerDayMilli ?? 0))
      : null;
  const slowIds = new Set(
    tooShort
      ? []
      : judged
          .filter((p) => {
            const rate = ownStats.get(p.titleId)!.unitsPerDayMilli ?? 0;
            return p.units === 0 || (med !== null && rate * 10_000 <= med * SLOW_SHARE_BP);
          })
          .map((p) => p.titleId),
  );

  const rows: AssortmentRow[] = own
    .map((p) => {
      const s = ownStats.get(p.titleId)!;
      return {
        titleId: p.titleId,
        name: nameOf(p.titleId),
        current: p.current,
        mysteryBatch: mysteryOf(p.titleId),
        units: p.units,
        stockedDayTenths: s.stockedTenths,
        enough: s.enough,
        unitsPerDayMilli: s.unitsPerDayMilli,
        profitPerDayOre: s.profitPerDayOre,
        unpricedUnits: p.units - p.priced,
        slow: slowIds.has(p.titleId),
      };
    })
    .sort(
      (a, b) =>
        (b.unitsPerDayMilli ?? -1) - (a.unitsPerDayMilli ?? -1) ||
        (b.profitPerDayOre ?? -Infinity) - (a.profitPerDayOre ?? -Infinity) ||
        a.name.localeCompare(b.name, "sv"),
    );
  const slow = rows
    .filter((r) => r.slow)
    .sort((a, b) => (a.unitsPerDayMilli ?? 0) - (b.unitsPerDayMilli ?? 0));

  // Kandidater: titlar i andra automaters sortiment i dag, med säkra tal där.
  const ownCurrent = new Set(own.filter((p) => p.current).map((p) => p.titleId));
  const elsewhere = new Map<string, { units: number; tenths: number; machines: number }>();
  const machinesWithData = new Set<string>();
  for (const p of pairs.values()) {
    if (p.machineId === machineId) continue;
    const s = stat(p);
    if (!s.enough) continue;
    machinesWithData.add(p.machineId);
    if (!p.current || ownCurrent.has(p.titleId) || mysteryOf(p.titleId) !== null) continue;
    const e = elsewhere.get(p.titleId) ?? { units: 0, tenths: 0, machines: 0 };
    e.units += p.units;
    e.tenths += s.stockedTenths;
    e.machines++;
    elsewhere.set(p.titleId, e);
  }
  const candidates = [...elsewhere.entries()]
    .map(([titleId, e]) => ({
      titleId,
      name: nameOf(titleId),
      unitsPerDayMilli: Math.round((e.units * 10_000) / e.tenths),
      machines: e.machines,
    }))
    .filter((c) => c.unitsPerDayMilli > 0)
    .sort((a, b) => b.unitsPerDayMilli - a.unitsPerDayMilli || a.name.localeCompare(b.name, "sv"));

  const suggestions: AssortmentSuggestion[] = [];
  for (const r of slow.slice(0, MAX_SUGGESTIONS)) {
    const rate = r.unitsPerDayMilli ?? 0;
    // Minst dubbelt så mycket, minst 0,1/dag, och inget som själv skulle stå still här.
    const i = candidates.findIndex(
      (c) =>
        c.unitsPerDayMilli >= Math.max(SUGGEST_MIN_MILLI, rate * SUGGEST_FACTOR) &&
        (med === null || c.unitsPerDayMilli * 10_000 > med * SLOW_SHARE_BP),
    );
    const pick = i >= 0 ? candidates.splice(i, 1)[0]! : null;
    const out = `Byt ut ${r.name}: säljer ${perDayText(rate)}/dag.`;
    suggestions.push({
      swapOut: { titleId: r.titleId, name: r.name, unitsPerDayMilli: rate },
      tryInstead: pick,
      text: pick
        ? `${out} Prova ${pick.name}: säljer ${perDayText(pick.unitsPerDayMilli)}/dag i ${
            pick.machines === 1 ? "en annan automat" : `${pick.machines} andra automater`
          }.`
        : out,
    });
  }

  return {
    period,
    days,
    tooShort,
    rows,
    best: rows.find((r) => r.enough && r.units > 0) ?? null,
    slow,
    suggestions,
    otherMachines: machinesWithData.size,
    medianUnitsPerDayMilli: med,
  };
}

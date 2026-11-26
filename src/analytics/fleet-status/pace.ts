/**
 * Fyllnad och takt per automat (V2, docs/design/v2/byggplan.md avsnitt 3.1). Rena funktioner.
 *
 *   fyllnad   = Σ pack ÷ Σ kapacitet över automatens fack enligt Awish (stock_locations.awish_fill)
 *   tomma fack = Σ tomma kanaler (awish_fill.empty)
 *   takt      = sålda pack ÷ dagar i fönstret (standard 14 hela dagar t.o.m. i går, samma
 *               fönster som besöksplanen och påfyllningsregeln), i tusendelar pack per dag
 *   tom om    = pack i automaten ÷ takt, avrundat nedåt till hela dagar (0 = tom i dag)
 *
 * Utan Awish-läsning är fyllnaden okänd (null): sidan skriver "Inte läst från Awish".
 */

/** Ett fack per titel som Awish-synken skriver det (stock_locations.awish_fill). */
export interface AwishFillRow {
  readonly title_id: string;
  readonly units: number;
  readonly capacity: number;
  readonly channels: number;
  readonly empty: number;
}

/** Automatens fyllnad enligt Awish. */
export interface MachineFill {
  /** Pack i automaten enligt Awish. */
  readonly units: number;
  /** Plats för så många pack. */
  readonly capacity: number;
  /** Fyllnad i baspunkter (0–10 000). null när kapaciteten är 0. */
  readonly fillBp: number | null;
  /** Antal fack (kanaler). */
  readonly channels: number;
  /** Antal tomma fack. */
  readonly emptyChannels: number;
  /** Titlar med minst ett tomt fack. */
  readonly emptyTitleIds: readonly string[];
}

/** Fönstret för takten (dagar). Samma som besöksplanen (src/server/data/visit-plan.ts). */
export const PACE_WINDOW_DAYS = 14;

/** Fyllnaden ur Awish-läsningen. null = automaten är inte läst från Awish. */
export function fillOf(rows: readonly AwishFillRow[] | null | undefined): MachineFill | null {
  if (!rows || rows.length === 0) return null;
  let units = 0;
  let capacity = 0;
  let known = 0;
  let channels = 0;
  let emptyChannels = 0;
  const emptyTitleIds: string[] = [];
  for (const r of rows) {
    const u = Math.max(0, Math.trunc(r.units));
    const c = Math.max(0, Math.trunc(r.capacity));
    units += u;
    capacity += c;
    known += Math.min(u, c);
    channels += Math.max(0, Math.trunc(r.channels));
    const e = Math.max(0, Math.trunc(r.empty));
    emptyChannels += e;
    if (e > 0) emptyTitleIds.push(r.title_id);
  }
  return {
    units,
    capacity,
    fillBp: capacity > 0 ? Math.min(10_000, Math.round((known * 10_000) / capacity)) : null,
    channels,
    emptyChannels,
    emptyTitleIds: [...new Set(emptyTitleIds)].sort(),
  };
}

/**
 * Pack i automaten för en titel: vårt lager på automatens plats (stock_levels) när det finns,
 * annars Awish-läsningen. Samma regel på Hem, Automater, Rutt och Fyll på. Lagret i appen är
 * aldrig äldre än Awish-läsningen (synken skriver Awish antal som räkning i lagret) och har
 * påfyllningar och försäljning efter läsningen med.
 */
export function fillUnitsOf(awishUnits: number | null | undefined, ledger: number | undefined) {
  return Math.max(0, Math.trunc(ledger ?? awishUnits ?? 0));
}

/**
 * Automatens fyllnad med samma regel som Fyll på: pack per titel ur fillUnitsOf, kapacitet och
 * tomma fack ur Awish. Ett tomt fack räknas inte som tomt när lagret har fler pack än Awish
 * visade (påfyllt efter läsningen).
 */
export function machineFill(
  rows: readonly AwishFillRow[] | null | undefined,
  ledger?: ReadonlyMap<string, number> | null,
): MachineFill | null {
  if (!rows || rows.length === 0) return null;
  if (!ledger || ledger.size === 0) return fillOf(rows);
  return fillOf(
    rows.map((r) => {
      const units = fillUnitsOf(r.units, ledger.get(r.title_id));
      return { ...r, units, empty: units <= Math.max(0, r.units) ? r.empty : 0 };
    }),
  );
}

/**
 * Titlarna i en automat som är slut: 0 pack (fillUnitsOf: lagret i appen, annars Awish) bland
 * titlarna Awish läste, titlarna i sortimentet i dag och titlarna som sålt i automaten i
 * fönstret, utom de som gått ur sortimentet. Kapaciteten behövs inte: en titel som är slut
 * ska fyllas på även när Awish inte har läst automaten. Samma regel som Fyll på (en rad med
 * 0 pack är "slut", src/app/fyll-pa/_lib/model.ts), så att Automater, Rutt och Fyll på säger
 * samma sak (src/server/data/v2/refill-need.test.ts).
 */
export function outTitleIdsOf(args: {
  readonly awish: readonly AwishFillRow[] | null | undefined;
  readonly ledger: ReadonlyMap<string, number> | null | undefined;
  /** Titlar som sålt i automaten i fönstret. */
  readonly sold: ReadonlySet<string>;
  /** Titlar i automatens sortiment i dag. */
  readonly current: ReadonlySet<string>;
  /** Titlar som gått ur automatens sortiment. */
  readonly retired: ReadonlySet<string>;
}): string[] {
  const awish = new Map((args.awish ?? []).map((r) => [r.title_id, r.units]));
  const ids = new Set<string>([...awish.keys(), ...args.current, ...args.sold]);
  const out: string[] = [];
  for (const id of ids) {
    if (args.retired.has(id)) continue;
    if (fillUnitsOf(awish.get(id), args.ledger?.get(id)) === 0) out.push(id);
  }
  return out.sort();
}

/** Sålda pack per dag i tusendelar (1 500 = 1,5 pack per dag). 0 utan dagar. */
export function unitsPerDayMilli(sold: number, days: number = PACE_WINDOW_DAYS): number {
  if (!(days > 0) || !(sold > 0)) return 0;
  return Math.round((sold * 1_000) / days);
}

/**
 * Hela dagar tills automaten är tom med nuvarande takt: 0 = tom (eller tom i dag), null när den
 * inte säljer (ingen takt) och därför inte tar slut.
 */
export function daysLeftOf(units: number, perDayMilli: number): number | null {
  if (units <= 0) return 0;
  if (!(perDayMilli > 0)) return null;
  return Math.floor((units * 1_000) / perDayMilli);
}

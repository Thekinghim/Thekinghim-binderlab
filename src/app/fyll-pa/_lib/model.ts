/**
 * Fyll på: automaterna som kort, sorterade efter behov, och raderna per titel med
 * förslaget. Rena funktioner (testas i model.test.ts).
 *
 * - Nu: Binderlabs saldo i automaten (Awish-inventeringen var femte minut plus
 *   påfyllningar som registrerats sedan dess). Ett negativt saldo visas som 0.
 * - Kapacitet: summan av fackens kapacitet enligt senaste Awish-läsningen
 *   (stock_locations.awish_fill). Okänd före första läsningen ("Fyllnad: väntar på Awish").
 * - Sålt: pack sålda de senaste 14 hela dagarna (t.o.m. i går), som Att göra.
 * - Läge per titel: "slut" (0 pack), "snart slut" (räcker under 2,5 dagar vid snittet,
 *   samma regel som Att göra), annars inget. Ett fullt fack (känd kapacitet, nu ≥ kapacitet)
 *   är aldrig slut eller snart slut: det går inte att fylla. Säljer det ändå fort visas en
 *   lugn rad ("Fullt · räcker ~2 d", tips: ge titeln ett fack till).
 * - Förslag: kapacitet − nu; utan känd kapacitet en veckas försäljning − nu, men bara för
 *   titlar som är slut eller snart slut. Aldrig fler än packen i lagret man fyller från
 *   (Hemma, Kontoret …: automatens "Fylls på från", annars senast valda, annars
 *   standardlagret) och aldrig under 0. Utan kapacitet sägs aldrig "fullt".
 * - Lager att fylla från (`chooseSource`): det man valt för automaten nu gäller. Annars
 *   automatens "Fylls på från" (sedan senast valda, standardlagret), men saknar det packen
 *   som behövs och ett annat aktivt lager har dem väljs det lager som täcker flest
 *   (lika: det föreslagna först, sedan namn) och skälet visas ("Kontoret saknar pack").
 * - Tomma fack: fack med 0 pack enligt Awish. Har titeln fyllts på sedan läsningen (saldot
 *   är högre än Awish antal) räknas dess fack som fyllda.
 * - Fyllnadsgrad: pack nu / kapacitet över titlarna med känd kapacitet.
 * - Mystery packs (egen produkt med innehåll, `FillInput.mystery`): facket fylls bara på när
 *   det är tomt, med exakt en hel omgång (oddsen gäller per omgång). Medan det har pack kvar är
 *   förslaget 0 och raden aldrig "snart slut" eller "tom plats"; vid 0 är den "slut" och
 *   förslaget en omgång (om lagret har en hel omgång). Fyller man ändå i ett antal för ett
 *   mystery-fack som inte är tomt visas en lugn varning (`mysteryNote`); "Räkna om" stoppas aldrig.
 * - Ordning: automater med slut (tomma fack eller titlar på 0) först (flest först), sedan
 *   snart slut, sedan lägst fyllnadsgrad, sist de utan Awish-data; lika ordnas efter kod.
 */

import { inPlace, pickPlace } from "@/components/stock/place-text";
import { mysteryBatch, mysteryCapacityShort, mysteryRefillQty } from "@/domain";
import { sv, type Messages } from "@/i18n/sv";
import { formatInt, NBSP } from "@/lib/format";

export interface AwishFillEntry {
  readonly title_id: string;
  readonly units: number;
  readonly capacity: number;
  readonly channels: number;
  readonly empty: number;
}

export interface FillMachineInput {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  /** Butiken där automaten står i dag, annars null. */
  readonly storeName: string | null;
  /** Senaste Awish-läsningen (ISO), null = aldrig. */
  readonly syncedAt: string | null;
  readonly fill: readonly AwishFillEntry[] | null;
  /** Min automat ("Mina"): jag är ansvarig eller ingen är vald. Utelämnat = min. */
  readonly mine?: boolean;
}

export interface FillInput {
  readonly machines: readonly FillMachineInput[];
  /** Titelns namn per id (bara titlar som finns kvar). */
  readonly titles: ReadonlyMap<string, string>;
  /** Saldo per automat och titel (`${machineId}\u0000${titleId}`). */
  readonly machineStock: ReadonlyMap<string, number>;
  /** Pack hemma (vårt lager) per titel. */
  readonly home: ReadonlyMap<string, number>;
  /** Titlar i automatens sortiment i dag (fackperiod), som nycklar som machineStock. */
  readonly current: ReadonlySet<string>;
  /** Titlar som gått ur automatens sortiment. */
  readonly retired: ReadonlySet<string>;
  /** Sålda pack de senaste SALES_WINDOW_DAYS hela dagarna, som nycklar som machineStock. */
  readonly sold?: ReadonlyMap<string, number>;
  /** Mystery packs: titelns id → pack per omgång (gällande innehåll). */
  readonly mystery?: ReadonlyMap<string, number>;
}

/** Fönstret för försäljningstakten (hela dagar t.o.m. i går), som Att göra. */
export const SALES_WINDOW_DAYS = 14;
/** "Snart slut": räcker under 2,5 dagar (hundradels dagar), som Att göra. */
export const LOW_CENTIDAYS = 250;
/** Utan känd kapacitet fylls det på för en veckas försäljning. */
export const TARGET_DAYS = 7;

/** Läget för en titel: slut, snart slut eller inget. */
export type RowStatus = "empty" | "low" | null;

export interface FillRow {
  readonly titleId: string;
  readonly name: string;
  /** Pack i automaten nu (minst 0). */
  readonly now: number;
  /** Fackens kapacitet, null = okänd (ingen Awish-läsning av titeln). */
  readonly capacity: number | null;
  /** Pack hemma (kan vara negativt om vårt lager inte är räknat). */
  readonly home: number;
  /** Föreslaget antal att fylla på. */
  readonly suggested: number;
  /** Tomma fack för titeln. */
  readonly emptySlots: number;
  /** Sålda pack de senaste SALES_WINDOW_DAYS dagarna. */
  readonly sold: number;
  readonly status: RowStatus;
  /** Mystery pack: pack per omgång (fylls bara på när facket är tomt), annars null. */
  readonly batchSize?: number | null;
}

export interface FillMachine {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  /** Butikens namn, annars automatens namn. */
  readonly place: string;
  readonly syncedAt: string | null;
  /** 0–100, null utan känd kapacitet. */
  readonly fillPct: number | null;
  readonly emptySlots: number;
  readonly units: number;
  readonly capacity: number;
  /** Summan av förslagen. */
  readonly suggested: number;
  /** Titlar som är slut (0 pack). */
  readonly empty: number;
  /** Titlar som snart är slut. */
  readonly low: number;
  /** Behöver påfyllning: tomma fack, slut, snart slut eller ett förslag. */
  readonly needs: boolean;
  readonly mine: boolean;
  readonly rows: readonly FillRow[];
}

export const pairKey = (machineId: string, titleId: string): string =>
  `${machineId}\u0000${titleId}`;

/** Räcker under 2,5 dagar vid snittet (och är inte slut). */
function lastsShort(now: number, sold: number): boolean {
  return now > 0 && sold > 0 && now * SALES_WINDOW_DAYS * 100 < LOW_CENTIDAYS * sold;
}

/** Fullt fack: kapaciteten är känd och automaten har minst så många pack. */
export function isFull(now: number, capacity: number | null): boolean {
  return capacity !== null && capacity > 0 && Math.max(0, now) >= capacity;
}

/**
 * Slut (0 pack), snart slut (räcker under 2,5 dagar vid snittet) eller inget. Ett fullt fack
 * (känd kapacitet, nu ≥ kapacitet) är aldrig slut eller snart slut: inget går att fylla.
 */
export function rowStatus(
  now: number,
  sold: number,
  capacity: number | null = null,
  batchSize: number | null = null,
): RowStatus {
  const n = Math.max(0, now);
  // Mystery pack: bara slut (0) räknas; medan facket har pack fylls det inte på.
  if (mysteryBatch(batchSize) !== null) return n === 0 ? "empty" : null;
  if (isFull(n, capacity)) return null;
  if (n === 0) return "empty";
  if (lastsShort(n, sold)) return "low";
  return null;
}

/**
 * Fullt men säljer fort (skulle annars vara snart slut): "Fullt · räcker ~2 d", annars null.
 * Visas lugnt, utan larm, med tipset att ge titeln ett fack till.
 */
export function fullFastNote(
  row: Pick<FillRow, "now" | "capacity" | "sold">,
  t: Messages = sv,
): string | null {
  const n = Math.max(0, row.now);
  if (!isFull(n, row.capacity) || !lastsShort(n, row.sold)) return null;
  const days = Math.max(1, Math.round((n * SALES_WINDOW_DAYS) / row.sold));
  return t.fill.fullFast(days);
}

/** Tipset under en full titel som säljer fort. */
export const FULL_FAST_TIP = sv.fill.fullFastTip;

/**
 * Förslaget: kapacitet − nu; utan kapacitet en veckas försäljning − nu för titlar som är slut
 * eller snart slut. Högst packen hemma, minst 0.
 */
export function suggestFill(
  now: number,
  capacity: number | null,
  home: number,
  sold = 0,
  batchSize: number | null = null,
): number {
  const n = Math.max(0, now);
  const batch = mysteryBatch(batchSize);
  if (batch !== null) {
    // En hel omgång när facket är tomt och lagret har en hel omgång, annars inget.
    const q = mysteryRefillQty(n, batch);
    return q > 0 && Math.max(0, home) >= q ? q : 0;
  }
  const target =
    capacity !== null
      ? capacity
      : rowStatus(n, sold) !== null
        ? Math.ceil((Math.max(0, sold) * TARGET_DAYS) / SALES_WINDOW_DAYS)
        : 0;
  return Math.max(0, Math.min(target - n, Math.max(0, home)));
}

/** Största antal som går att välja för en rad (stegarens tak). */
export function maxFill(
  row: Pick<FillRow, "now" | "capacity"> & Partial<Pick<FillRow, "batchSize">>,
): number {
  if (row.capacity === null) return 500;
  const base = Math.max(0, row.capacity - row.now, 1);
  // Mystery pack: en hel omgång ska alltid gå att välja (varning om den inte får plats).
  const batch = mysteryBatch(row.batchSize);
  return batch !== null ? Math.max(base, batch) : base;
}

/**
 * Antalet "Fyll allt" sätter för en rad: kapacitet − nu; mystery packs en hel omgång när
 * facket är tomt, annars 0; utan känd kapacitet behålls det valda antalet.
 */
export function fillAllQty(
  row: Pick<FillRow, "now" | "capacity"> & Partial<Pick<FillRow, "batchSize">>,
  current: number,
): number {
  const batch = mysteryBatch(row.batchSize);
  if (batch !== null) return mysteryRefillQty(row.now, batch);
  if (row.capacity === null) return current;
  return Math.max(0, row.capacity - row.now);
}

/**
 * Antalet efter "Räkna om" (nytt saldo `counted`): det som får plats, högst lagret; för ett
 * mystery pack en hel omgång om facket är tomt, annars 0. null = ändra inte (okänd kapacitet).
 */
export function qtyAfterCount(
  row: Pick<FillRow, "capacity" | "home"> & Partial<Pick<FillRow, "batchSize">>,
  counted: number,
): number | null {
  const batch = mysteryBatch(row.batchSize);
  if (batch !== null) return suggestFill(counted, row.capacity, row.home, 0, batch);
  if (row.capacity === null) return null;
  return Math.max(0, Math.min(row.capacity - counted, Math.max(0, row.home)));
}

/**
 * Lugn rad under ett mystery pack: "Mystery-facket fylls bara på när det är tomt" när man
 * fyller i ett antal för ett fack som har pack kvar, annars att en omgång inte får plats.
 * null för andra titlar. Stoppar aldrig något (Räkna om och Klar fungerar som vanligt).
 */
export function mysteryNote(
  row: Pick<FillRow, "now" | "capacity"> & Partial<Pick<FillRow, "batchSize">>,
  value: number,
  t: Messages = sv,
): string | null {
  const batch = mysteryBatch(row.batchSize);
  if (batch === null) return null;
  if (row.now > 0) return value > 0 ? t.fill.mysteryOnlyEmpty : null;
  if (row.capacity !== null && mysteryCapacityShort(row.capacity, batch)) {
    return t.fill.mysteryCapacity(row.capacity, batch);
  }
  return null;
}

/** Packen delas: så många som finns hemma tas från vårt lager, resten registreras utan uttag. */
export function splitRefill(
  quantity: number,
  home: number,
): { fromWarehouse: number; direct: number } {
  const q = Math.max(0, Math.trunc(quantity));
  const fromWarehouse = Math.min(q, Math.max(0, home));
  return { fromWarehouse, direct: q - fromWarehouse };
}

const STATUS_RANK = { empty: 0, low: 1 } as const;

function rowOrder(a: FillRow, b: FillRow): number {
  const ae = a.status === null ? 2 : STATUS_RANK[a.status];
  const be = b.status === null ? 2 : STATUS_RANK[b.status];
  if (ae !== be) return ae - be;
  const ag = a.capacity === null ? -1 : a.capacity - a.now;
  const bg = b.capacity === null ? -1 : b.capacity - b.now;
  if (ag !== bg) return bg - ag;
  return a.name.localeCompare(b.name, "sv");
}

/** Raderna för en automat. */
export function machineRows(machine: FillMachineInput, input: FillInput): FillRow[] {
  const fill = new Map((machine.fill ?? []).map((f) => [f.title_id, f]));
  const ids = new Set<string>();
  for (const id of fill.keys()) ids.add(id);
  for (const key of input.current) {
    const [m, t] = key.split("\u0000");
    if (m === machine.id && t) ids.add(t);
  }
  for (const [key, q] of input.machineStock) {
    const [m, t] = key.split("\u0000");
    if (m === machine.id && t && q > 0) ids.add(t);
  }
  // Såld nyligen men nu 0 pack: slut (som Att göra), även utan fackdata från Awish.
  for (const [key, n] of input.sold ?? []) {
    const [m, t] = key.split("\u0000");
    if (m === machine.id && t && n > 0) ids.add(t);
  }
  const rows: FillRow[] = [];
  for (const titleId of ids) {
    const name = input.titles.get(titleId);
    if (name === undefined) continue;
    const key = pairKey(machine.id, titleId);
    const f = fill.get(titleId);
    const now = Math.max(0, input.machineStock.get(key) ?? f?.units ?? 0);
    // Utgången titel som inte står i automaten längre: ingen rad.
    if (!f && input.retired.has(key) && now === 0) continue;
    const capacity = f && f.capacity > 0 ? f.capacity : null;
    const home = input.home.get(titleId) ?? 0;
    const sold = Math.max(0, input.sold?.get(key) ?? 0);
    const batchSize = mysteryBatch(input.mystery?.get(titleId));
    rows.push({
      titleId,
      name,
      now,
      capacity,
      home,
      suggested: suggestFill(now, capacity, home, sold, batchSize),
      // Ett mystery pack med pack kvar har inga "tomma platser" att fylla.
      emptySlots:
        f && now <= f.units && (batchSize === null || now === 0) ? Math.max(0, f.empty) : 0,
      sold,
      status: rowStatus(now, sold, capacity, batchSize),
      ...(batchSize !== null ? { batchSize } : {}),
    });
  }
  return rows.sort(rowOrder);
}

/** Summorna för en automat ur raderna. */
function totals(rows: readonly FillRow[]) {
  let units = 0;
  let capacity = 0;
  let known = 0;
  for (const r of rows) {
    if (r.capacity === null) continue;
    capacity += r.capacity;
    known += Math.min(r.now, r.capacity);
    units += r.now;
  }
  const emptySlots = rows.reduce((n, r) => n + r.emptySlots, 0);
  const suggested = rows.reduce((n, r) => n + r.suggested, 0);
  const empty = rows.filter((r) => r.status === "empty").length;
  const low = rows.filter((r) => r.status === "low").length;
  return {
    units,
    capacity,
    fillPct: capacity > 0 ? Math.round((known / capacity) * 100) : null,
    emptySlots,
    suggested,
    empty,
    low,
    needs: emptySlots > 0 || empty > 0 || low > 0 || suggested > 0,
  };
}

/** Alla automater som kort, sorterade efter behov. */
export function fillMachines(input: FillInput): FillMachine[] {
  const out = input.machines.map((m): FillMachine => {
    const rows = machineRows(m, input);
    return {
      id: m.id,
      code: m.code,
      name: m.name,
      place: m.storeName ?? m.name,
      syncedAt: m.syncedAt,
      mine: m.mine ?? true,
      ...totals(rows),
      rows,
    };
  });
  return out.sort(machineOrder);
}

type OrderKey = Pick<FillMachine, "emptySlots" | "fillPct" | "code"> &
  Partial<Pick<FillMachine, "empty" | "low">>;

export function machineOrder(a: OrderKey, b: OrderKey): number {
  const aOut = a.emptySlots + (a.empty ?? 0);
  const bOut = b.emptySlots + (b.empty ?? 0);
  const ae = aOut > 0 ? 0 : (a.low ?? 0) > 0 ? 1 : 2;
  const be = bOut > 0 ? 0 : (b.low ?? 0) > 0 ? 1 : 2;
  if (ae !== be) return ae - be;
  if (aOut !== bOut) return bOut - aOut;
  if ((a.low ?? 0) !== (b.low ?? 0)) return (b.low ?? 0) - (a.low ?? 0);
  const ap = a.fillPct ?? 101;
  const bp = b.fillPct ?? 101;
  if (ap !== bp) return ap - bp;
  return a.code.localeCompare(b.code, "sv", { numeric: true });
}

/** Påfyllningen som den visas efter Klar: "24 pack påfyllda, 61 kvar hemma" / "… kvar i Kontoret". */
export function doneMessage(packs: number, homeLeft: number, place = "hemma"): string {
  return `${formatInt(packs)}${NBSP}pack påfyllda, ${formatInt(Math.max(0, homeLeft))} kvar ${inPlace(place)}`;
}

/** Rubriken på Fyll på: aldrig "fulla" utan känd kapacitet. */
export function fillHeadline(machines: readonly FillMachine[], t: Messages = sv): string {
  if (machines.length === 0) return t.fill.headlineNone;
  const need = machines.filter((m) => m.needs).length;
  if (need > 0) return t.fill.needHeadline(need);
  if (machines.every((m) => m.fillPct !== null)) return t.fill.headlineFull(machines.length);
  return t.fill.headlineCalm;
}

/** Kortets rad till höger: "2 slut · 1 snart", "fyll 9", "fullt" eller inget. */
export function needLabel(
  m: Pick<FillMachine, "empty" | "low" | "emptySlots" | "suggested" | "fillPct">,
  t: Messages = sv,
): string | null {
  const parts: string[] = [];
  if (m.empty > 0) parts.push(t.fill.needEmpty(m.empty));
  else if (m.emptySlots > 0) parts.push(t.fill.needEmptySlots(m.emptySlots));
  if (m.low > 0) parts.push(t.fill.needLow(m.low));
  if (parts.length > 0) return parts.join(" · ");
  if (m.suggested > 0) return t.fill.needFill(m.suggested);
  if (m.fillPct !== null) return t.fill.needFull;
  return null;
}

/** En påfyllning som ännu inte syns i serverns siffror (i kön eller nyss sparad). */
export interface FillAdjustment {
  readonly machineId: string;
  readonly titleId: string;
  readonly quantity: number;
  readonly fromWarehouse: boolean;
  /** Lagret packen togs från (utelämnat = automatens lager enligt `sourceOf`). */
  readonly fromLocationId?: string | null;
}

/** Saldot per eget lager: platsens id → titelns id → pack. */
export type PlaceStock = Readonly<Record<string, Readonly<Record<string, number>>>>;

/**
 * Serverns siffror plus påfyllningar som ännu inte syns där (kön utan nät, eller nyss
 * sparade innan sidan laddats om) och omräkningar ("Räkna om", saldot i automaten).
 * `sourceOf` ger lagret varje automat fylls från just nu; raderna visar det lagrets saldo.
 * Förslag, fyllnadsgrad, tomma fack och ordning räknas om.
 */
export function applyAdjustments(
  machines: readonly FillMachine[],
  stock: PlaceStock,
  adjustments: readonly FillAdjustment[],
  counts: ReadonlyMap<string, number> = new Map(),
  sourceOf: (machineId: string) => string | null = () => null,
): { machines: FillMachine[]; stock: Record<string, Record<string, number>> } {
  const nextStock: Record<string, Record<string, number>> = Object.fromEntries(
    Object.entries(stock).map(([k, v]) => [k, { ...v }]),
  );
  const added = new Map<string, number>();
  for (const a of adjustments) {
    const k = pairKey(a.machineId, a.titleId);
    added.set(k, (added.get(k) ?? 0) + a.quantity);
    const place = a.fromLocationId ?? sourceOf(a.machineId);
    if (a.fromWarehouse && place) {
      const at = (nextStock[place] ??= {});
      at[a.titleId] = (at[a.titleId] ?? 0) - a.quantity;
    }
  }
  const out = machines.map((m): FillMachine => {
    let changed = false;
    const source = sourceOf(m.id);
    const rows = m.rows.map((r): FillRow => {
      const k = pairKey(m.id, r.titleId);
      const counted = counts.get(k);
      const plus = added.get(k) ?? 0;
      const homeNow = source ? (nextStock[source]?.[r.titleId] ?? 0) : r.home;
      if (counted === undefined && plus === 0 && homeNow === r.home) return r;
      changed = true;
      const now = Math.max(0, counted ?? r.now + plus);
      return {
        ...r,
        now,
        home: homeNow,
        suggested: suggestFill(now, r.capacity, homeNow, r.sold, r.batchSize ?? null),
        emptySlots:
          plus > 0 || (counted !== undefined && counted > r.now) || (r.batchSize && now > 0)
            ? 0
            : r.emptySlots,
        status: rowStatus(now, r.sold, r.capacity, r.batchSize ?? null),
      };
    });
    if (!changed) return m;
    return { ...m, ...totals(rows), rows: [...rows].sort(rowOrder) };
  });
  return { machines: out.sort(machineOrder), stock: nextStock };
}

/** Pack en titel vill ha om lagret räcker: förslaget utan taket från lagret. */
export function packsWanted(
  row: Pick<FillRow, "now" | "capacity" | "sold"> & Partial<Pick<FillRow, "batchSize">>,
): number {
  return suggestFill(
    row.now,
    row.capacity,
    Number.MAX_SAFE_INTEGER,
    row.sold,
    row.batchSize ?? null,
  );
}

/** Hur många av de pack automaten vill ha som ett lager kan ge: summan av min(vill ha, saldo). */
export function coverage(
  rows: readonly (Pick<FillRow, "titleId" | "now" | "capacity" | "sold"> &
    Partial<Pick<FillRow, "batchSize">>)[],
  stock: Readonly<Record<string, number>> | undefined,
): number {
  let n = 0;
  for (const r of rows) {
    const want = packsWanted(r);
    const have = Math.max(0, stock?.[r.titleId] ?? 0);
    // Mystery pack: bara en hel omgång räknas (en del av en omgång fylls inte på).
    n += r.batchSize && have < want ? 0 : Math.min(want, have);
  }
  return n;
}

export interface SourceChoice {
  /** Lagret att fylla från, null = inget eget lager. */
  readonly id: string | null;
  /** Skälet som visas vid "Från: … ▾" ("Kontoret saknar pack"), annars null. */
  readonly reason: string | null;
}

/**
 * Lagret en automat fylls från.
 * - Valt för automaten nu ("Från: … ▾"): gäller alltid. Saknar det packen men ett annat lager
 *   har dem sägs det ("Hemma har pack").
 * - Annars det första giltiga av `preferred` (automatens "Fylls på från", senast valda,
 *   standardlagret; annars första lagret). Täcker ett annat aktivt lager minst dubbelt så
 *   många av packen som behövs (och fler än noll) väljs det lager som täcker flest; lika:
 *   det föreslagna först, sedan namn. Skälet: "Kontoret saknar pack" / "Kontoret har bara 3".
 * Automatens sparade "Fylls på från" ändras aldrig.
 */
export function chooseSource(args: {
  readonly places: readonly { readonly id: string; readonly name: string }[];
  readonly stock: PlaceStock;
  readonly rows: readonly (Pick<FillRow, "titleId" | "now" | "capacity" | "sold"> &
    Partial<Pick<FillRow, "batchSize">>)[];
  /** Valt för automaten nu (gäller tills sidan laddas om). */
  readonly explicit?: string | null;
  readonly preferred: readonly (string | null | undefined)[];
  /** Texterna för skälet (standard svenska). */
  readonly t?: Messages;
}): SourceChoice {
  const t = args.t ?? sv;
  const { places, stock, rows } = args;
  if (places.length === 0) return { id: null, reason: null };
  const cover = new Map(places.map((p) => [p.id, coverage(rows, stock[p.id])]));
  const name = (id: string) => places.find((p) => p.id === id)?.name ?? "";
  const base = pickPlace(places, ...args.preferred) as string;
  const best = [...places].sort((a, b) => {
    const d = (cover.get(b.id) ?? 0) - (cover.get(a.id) ?? 0);
    if (d !== 0) return d;
    if (a.id === base || b.id === base) return a.id === base ? -1 : 1;
    return a.name.localeCompare(b.name, "sv");
  })[0]!;
  const bestCover = cover.get(best.id) ?? 0;
  const explicit =
    args.explicit && places.some((p) => p.id === args.explicit) ? args.explicit : null;
  if (explicit) {
    const own = cover.get(explicit) ?? 0;
    const hint = own === 0 && bestCover > 0 && best.id !== explicit;
    return { id: explicit, reason: hint ? t.fill.sourceHasPacks(name(best.id)) : null };
  }
  const baseCover = cover.get(base) ?? 0;
  if (best.id !== base && bestCover > 0 && baseCover * 2 <= bestCover) {
    return {
      id: best.id,
      reason:
        baseCover === 0
          ? t.fill.sourceMissing(name(base))
          : t.fill.sourceOnly(name(base), baseCover),
    };
  }
  return { id: base, reason: null };
}

// ---------------------------------------------------------------------------
// Ta med-listan (packlistan)
// ---------------------------------------------------------------------------

export interface BringLine {
  readonly titleId: string;
  readonly name: string;
  /** Pack automaten vill ha för att bli full (utan hänsyn till lagret). */
  readonly want: number;
}

export interface BringMachine {
  readonly id: string;
  readonly place: string;
  readonly code: string;
  readonly want: number;
  /** Titlarna som behöver pack, flest först. */
  readonly lines: readonly BringLine[];
  /** Falskt: automaten har ingen Awish-läsning än, så behovet är inte känt. */
  readonly known: boolean;
}

export interface BringTotal {
  readonly titleId: string;
  readonly name: string;
  /** Pack de valda automaterna vill ha tillsammans. */
  readonly want: number;
  /** Pack i lagret man tar från; null = inget eget lager (saldot är inte känt). */
  readonly have: number | null;
  /** Pack att ta med: det som behövs, högst det som finns. */
  readonly bring: number;
  /** Pack som saknas i lagret. */
  readonly missing: number;
}

export interface BringList {
  readonly machines: readonly BringMachine[];
  readonly totals: readonly BringTotal[];
  readonly want: number;
  readonly bring: number;
  readonly missing: number;
}

/**
 * Ta med-listan: vad som ska med för att fylla de valda automaterna, per automat och totalt,
 * mot saldot i lagret man tar från.
 *
 * - Behovet per titel är förslaget utan taket från lagret (`packsWanted`): kapacitet − nu;
 *   utan känd kapacitet en veckas försäljning för titlar som är slut eller snart slut.
 * - Mystery pack: bara hela omgångar, och bara när facket är tomt. Ur lagret tas bara hela
 *   omgångar (en halv omgång fylls inte på), så resten räknas som saknat.
 * - `stock` = saldot per titel i det valda lagret; null = inget eget lager, då tas allt med
 *   och inget räknas som saknat.
 * - Totalt: det som saknas först (flest först), sedan flest pack, sedan namn.
 */
export function bringList(
  machines: readonly FillMachine[],
  selected: ReadonlySet<string>,
  stock: Readonly<Record<string, number>> | null,
): BringList {
  const byTitle = new Map<string, { name: string; want: number; batch: number | null }>();
  const out: BringMachine[] = [];
  for (const m of machines) {
    if (!selected.has(m.id)) continue;
    const lines: BringLine[] = [];
    for (const r of m.rows) {
      const want = packsWanted(r);
      if (want <= 0) continue;
      lines.push({ titleId: r.titleId, name: r.name, want });
      const t = byTitle.get(r.titleId) ?? {
        name: r.name,
        want: 0,
        batch: mysteryBatch(r.batchSize),
      };
      t.want += want;
      byTitle.set(r.titleId, t);
    }
    lines.sort((a, b) => b.want - a.want || a.name.localeCompare(b.name, "sv"));
    out.push({
      id: m.id,
      place: m.place,
      code: m.code,
      want: lines.reduce((n, l) => n + l.want, 0),
      lines,
      known: m.rows.some((r) => r.capacity !== null),
    });
  }
  const totals = [...byTitle.entries()]
    .map(([titleId, t]): BringTotal => {
      if (stock === null) {
        return { titleId, name: t.name, want: t.want, have: null, bring: t.want, missing: 0 };
      }
      const have = Math.max(0, Math.trunc(stock[titleId] ?? 0));
      const usable = t.batch !== null ? Math.floor(have / t.batch) * t.batch : have;
      const bring = Math.min(t.want, usable);
      return { titleId, name: t.name, want: t.want, have, bring, missing: t.want - bring };
    })
    .sort((a, b) => b.missing - a.missing || b.want - a.want || a.name.localeCompare(b.name, "sv"));
  return {
    machines: out,
    totals,
    want: totals.reduce((n, t) => n + t.want, 0),
    bring: totals.reduce((n, t) => n + t.bring, 0),
    missing: totals.reduce((n, t) => n + t.missing, 0),
  };
}

/** Automaterna som är valda från början: de som behöver pack, annars alla. */
export function defaultBringSelection(machines: readonly FillMachine[]): string[] {
  const need = machines.filter((m) => m.rows.some((r) => packsWanted(r) > 0));
  return (need.length > 0 ? need : machines).map((m) => m.id);
}

/**
 * Valet efter ett tryck på en automat i Ta med-listan: `chosen` null betyder förvalet (de
 * som behöver pack). Automaten läggs till eller tas bort.
 */
export function toggleBring(
  chosen: readonly string[] | null,
  machines: readonly FillMachine[],
  id: string,
): string[] {
  const base = chosen ?? defaultBringSelection(machines);
  return base.includes(id) ? base.filter((x) => x !== id) : [...base, id];
}

// ---------------------------------------------------------------------------
// "Packade du en omgång?" (mystery packs som inte finns färdiga i lagret)
// ---------------------------------------------------------------------------

/** Gällande innehåll för ett mystery pack: det Packa behöver (bara antal, inga belopp). */
export interface FillRecipe {
  readonly recipeId: string;
  /** Pack per omgång. */
  readonly batchSize: number;
  /** Delarna per omgång. */
  readonly items: readonly { readonly titleId: string; readonly quantity: number }[];
}

/** Frågan före Klar: "Det finns 0 Mystery Pack i Kontoret. Packade du en omgång?". */
export interface PackAsk {
  readonly titleId: string;
  readonly name: string;
  /** Färdiga mystery packs i lagret man fyller från (minst 0). */
  readonly home: number;
  /** Omgångar som behöver packas för att påfyllningen ska gå jämnt upp. */
  readonly batches: number;
  /** Samma sak i pack. */
  readonly packs: number;
  readonly recipeId: string;
}

/** Högst så här många omgångar packas i ett svep (samma tak som Packa-sidan). */
export const PACK_ASK_MAX_BATCHES = 10;

/**
 * Frågorna före Klar: mystery packs som fylls på fast lagret man fyller från har färre
 * färdiga pack än antalet. Då har man oftast packat utan att trycka Packa, och utan frågan
 * blir lagret fel (delarna ligger kvar i appen fast de sitter i automaten).
 *
 * - Bara mystery packs med känt innehåll, och bara när delarna räcker i samma lager till
 *   omgångarna som fattas. Räcker de inte ställs ingen fråga: påfyllningen går igenom som
 *   förut (utan uttag ur lagret).
 * - Två mystery packs som delar på samma delar: den första i listan får delarna först.
 * - `stock` = saldot per titel i lagret man fyller från; null = inget eget lager (ingen fråga).
 */
export function packAsks(
  lines: readonly { readonly row: FillRow; readonly quantity: number }[],
  recipes: Readonly<Record<string, FillRecipe>>,
  stock: Readonly<Record<string, number>> | null | undefined,
): PackAsk[] {
  if (!stock) return [];
  const left = new Map<string, number>();
  const have = (id: string) => left.get(id) ?? Math.max(0, Math.trunc(stock[id] ?? 0));
  const out: PackAsk[] = [];
  for (const { row, quantity } of lines) {
    const recipe = recipes[row.titleId];
    const batch = mysteryBatch(recipe?.batchSize);
    if (!recipe || batch === null || mysteryBatch(row.batchSize) === null) continue;
    const home = Math.max(0, Math.trunc(row.home));
    const missing = Math.trunc(quantity) - home;
    if (missing <= 0) continue;
    const batches = Math.ceil(missing / batch);
    if (batches > PACK_ASK_MAX_BATCHES || recipe.items.length === 0) continue;
    if (recipe.items.some((i) => have(i.titleId) < i.quantity * batches)) continue;
    for (const i of recipe.items) left.set(i.titleId, have(i.titleId) - i.quantity * batches);
    out.push({
      titleId: row.titleId,
      name: row.name,
      home,
      batches,
      packs: batches * batch,
      recipeId: recipe.recipeId,
    });
  }
  return out;
}

/**
 * Mystery-facket är tomt men lagret man fyller från har inte en hel omgång färdig: förslaget
 * är då 0. Raden säger varför och erbjuder en hel omgång ("Fyll på en omgång (14 st)").
 * Svaret är omgångens storlek, annars null.
 */
export function mysteryShortAtHome(
  row: Pick<FillRow, "now" | "home"> & Partial<Pick<FillRow, "batchSize">>,
): number | null {
  const batch = mysteryBatch(row.batchSize);
  if (batch === null || row.now > 0) return null;
  return Math.max(0, row.home) < batch ? batch : null;
}

/** Lagrens saldo med packningar som gjorts här men som serverns siffror inte visar än. */
export function withPacked(
  stock: PlaceStock,
  deltas: readonly { readonly placeId: string; readonly titleId: string; readonly delta: number }[],
): PlaceStock {
  if (deltas.length === 0) return stock;
  const out: Record<string, Record<string, number>> = Object.fromEntries(
    Object.entries(stock).map(([k, v]) => [k, { ...v }]),
  );
  for (const d of deltas) {
    const at = (out[d.placeId] ??= {});
    at[d.titleId] = (at[d.titleId] ?? 0) + d.delta;
  }
  return out;
}

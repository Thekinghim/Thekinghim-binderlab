/**
 * Visningsmodellen för Inköpspriser: rubriker, rader, tidslinje och ändringslogg.
 * Rena funktioner utan databas (testas i model.test.ts). Ekonomin (snittpris, kvar per
 * order, förlustvarning, påverkan av en prisändring) räknas i @/domain; här sätts den
 * bara ihop med namn, datum och text.
 */

import {
  addDays,
  addMonths,
  daysBetween,
  monthOf,
  priceChangeImpact,
  type IsoDate,
  type OrderLine,
  type PriceHistoryEntry,
  type PurchasePrice,
  type TitleEconomics,
  type UnpricedTitle,
} from "@/domain";
import { parseAmountOre } from "@/import/amount";
import { formatDate, formatInt, formatKronor, formatMonth, formatSignedKronor } from "@/lib/format";

/** Högsta inköpspris per pack som tas emot (100 000 kr): ett större värde är ett skrivfel. */
export const MAX_UNIT_COST_ORE = 10_000_000;

// ---------------------------------------------------------------------------
// Typer
// ---------------------------------------------------------------------------

/** Ett inköpspris som det ligger i databasen. */
export interface PriceRecord {
  readonly id: string;
  readonly titleId: string;
  readonly unitCostOre: number;
  readonly validFrom: IsoDate;
  readonly note: string | null;
  readonly createdAt: string;
  readonly createdBy: string | null;
}

/** Pris före eller efter i en logghändelse. */
export interface PriceState {
  readonly unitCostOre: number;
  readonly validFrom: IsoDate;
  readonly note: string | null;
}

/** En rad i audit_log för purchase_prices. */
export interface PriceAuditEvent {
  readonly id: string;
  readonly rowId: string;
  readonly action: "insert" | "update" | "delete";
  readonly actorId: string | null;
  readonly occurredAt: string;
  readonly before: PriceState | null;
  readonly after: PriceState | null;
}

export type TitleStatus = "missing" | "loss" | "partial" | "loss-after-rent" | "idle" | "ok";

/** En rad i tabellen per titel (serialiserbar, skickas till klienten). */
export interface TitleRow {
  readonly id: string;
  readonly name: string;
  readonly series: string | null;
  readonly archived: boolean;
  readonly currentCostOre: number | null;
  readonly currentFrom: IsoDate | null;
  readonly averagePriceOre: number | null;
  readonly averageCostOre: number | null;
  readonly leftOre: number | null;
  readonly marginBp: number | null;
  readonly rentOre: number | null;
  readonly leftAfterRentOre: number | null;
  readonly orders: number;
  /** Order i perioden som saknade inköpspris på sin dag (räknas inte in i vinsten). */
  readonly unpricedOrders: number;
  /** Nettointäkt för order utan pris (ur profitability().unpriced.byTitle). */
  readonly unpricedRevenueOre: number;
  /** Första affärsdag med order utan pris i perioden. */
  readonly unpricedFirstDate: IsoDate | null;
  readonly status: TitleStatus;
  /** Egen produkt (vi packar den själva): priset är kostnaden för innehållet. */
  readonly own: boolean;
}

export interface TitleInfo {
  readonly id: string;
  readonly name: string;
  readonly series: string | null;
  readonly archived: boolean;
  readonly ownProduct?: boolean;
}

/** Etiketten för priset: inköpspris, eller kostnaden för innehållet för en egen produkt. */
export function costLabel(own: boolean): string {
  return own ? "Kostnad per pack (innehåll)" : "Inköpspris per pack";
}

export const STATUS_LABEL: Record<TitleStatus, string> = {
  missing: "Saknar pris",
  loss: "Förlust",
  partial: "Delvis utan pris",
  "loss-after-rent": "Förlust efter hyra",
  idle: "Ingen försäljning",
  ok: "Lönsam",
};

/** Ordning när tabellen sorteras på status: det som kräver åtgärd först. */
export const STATUS_RANK: Record<TitleStatus, number> = {
  missing: 0,
  loss: 1,
  partial: 2,
  "loss-after-rent": 3,
  idle: 4,
  ok: 5,
};

export const PRICE_MESSAGES = {
  forbidden: "Bara ägare och admin kan ändra inköpspriser.",
  invalid: "Uppgifterna stämmer inte. Kontrollera pris och datum och försök igen.",
  titleMissing: "Titeln finns inte längre. Ladda om sidan.",
  titleMerged: "Titeln är sammanslagen med en annan. Lägg priset på den titeln i stället.",
  unchanged: "Priset är redan inlagt med samma belopp och datum.",
  correctionUnchanged: "All försäljning har redan det priset.",
  correctionClosed:
    "Månaden är stängd. Välj Nytt inköpspris i stället, eller be en ägare öppna månaden.",
  closedMonthGeneric:
    "Priset skulle gälla i en stängd månad. Välj ett senare datum, eller be en ägare öppna månaden.",
  closedMonth(months: readonly string[]): string {
    const names = months.map(monthName);
    const list =
      names.length === 1
        ? names[0]
        : `${names.slice(0, -1).join(", ")} och ${names[names.length - 1]}`;
    const verb = months.length === 1 ? "som är stängd" : "som är stängda";
    return `Priset skulle gälla i ${list}, ${verb}. Välj ett giltig från-datum efter månaden, eller be en ägare öppna den.`;
  },
} as const;

function monthName(month: string): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return formatMonth(new Date(y, m - 1, 1, 12));
}

/** Avslutar en mening med punkt, utan extra punkt efter en förkortning ("26 okt."). */
export function sentence(text: string): string {
  return text.endsWith(".") ? text : `${text}.`;
}

/** 'ÅÅÅÅ-MM-DD' → Date vid lokal middag (för format.ts). */
export function dayDate(date: IsoDate): Date {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(y, m - 1, d, 12);
}

/** Öre → kronor för format.ts (formatKronor tar kronor). */
export function kr(ore: number): number {
  return ore / 100;
}

// ---------------------------------------------------------------------------
// Inmatning
// ---------------------------------------------------------------------------

export type ParsedPrice = { ok: true; ore: number } | { ok: false; message: string };

/** "112,50" / "112" / "1 120 kr" → öre. Negativa belopp och fler än två decimaler nekas. */
export function parsePriceInput(input: string): ParsedPrice {
  if (input.trim() === "") return { ok: false, message: "Ange inköpspriset per pack." };
  const r = parseAmountOre(input);
  if (!r.ok) return { ok: false, message: "Skriv priset i kronor, t.ex. 112,50." };
  if (r.ore > MAX_UNIT_COST_ORE) {
    return {
      ok: false,
      message: `Högst ${formatKronor(kr(MAX_UNIT_COST_ORE), { decimals: 0 })} per pack.`,
    };
  }
  return { ok: true, ore: r.ore };
}

// ---------------------------------------------------------------------------
// Stängda månader
// ---------------------------------------------------------------------------

/**
 * Stängda månader som ett pris från `validFrom` skulle gälla i: från `validFrom` till
 * dagen före titelns nästa pris (eller tills vidare). Samma regel som databasens
 * purchase_prices_period_guard, så att felet kan säga vilken månad det gäller.
 */
export function closedMonthsHit(
  titlePrices: ReadonlyArray<Pick<PriceRecord, "validFrom">>,
  validFrom: IsoDate,
  closedMonths: readonly string[],
): string[] {
  const next = titlePrices
    .map((p) => p.validFrom)
    .filter((d) => d > validFrom)
    .sort()[0];
  const first = monthOf(validFrom);
  return closedMonths
    .filter((m) => m >= first && (next === undefined || `${m}-01` < next))
    .slice()
    .sort();
}

// ---------------------------------------------------------------------------
// Rader och rubriker
// ---------------------------------------------------------------------------

function statusOf(e: TitleEconomics): TitleStatus {
  if (e.missingPrice) return "missing";
  if (e.lossWarning) return "loss";
  // Priset finns i dag men tidigare order i perioden saknade pris.
  if (e.unpricedOrders > 0) return "partial";
  if (e.lossAfterRentWarning) return "loss-after-rent";
  if (e.orders === 0) return "idle";
  return "ok";
}

/**
 * En rad per titel i titleEconomics, med namn och order utan pris (ur
 * profitability().unpriced.byTitle). Titlar utan namn (borttagna) hoppas över.
 */
export function titleRows(
  economics: readonly TitleEconomics[],
  titles: readonly TitleInfo[],
  unpricedByTitle: readonly UnpricedTitle[] = [],
): TitleRow[] {
  const byId = new Map(titles.map((t) => [t.id, t]));
  const unpriced = new Map(unpricedByTitle.map((u) => [u.titleId, u]));
  return economics.flatMap((e): TitleRow[] => {
    const t = byId.get(e.titleId);
    if (!t) return [];
    const u = unpriced.get(e.titleId);
    return [
      {
        id: e.titleId,
        name: t.name,
        series: t.series,
        archived: t.archived,
        currentCostOre: e.currentUnitCostOre,
        currentFrom: e.currentPriceValidFrom,
        averagePriceOre: e.averagePriceOre,
        averageCostOre: e.averageCostOre,
        leftOre: e.leftPerOrderOre,
        marginBp: e.marginBp,
        rentOre: e.rentPerOrderOre,
        leftAfterRentOre: e.leftPerOrderAfterRentOre,
        orders: e.orders,
        unpricedOrders: e.unpricedOrders,
        unpricedRevenueOre: u?.revenueOre ?? 0,
        unpricedFirstDate: u?.firstDate ?? null,
        status: statusOf(e),
        own: t.ownProduct === true,
      },
    ];
  });
}

function plural(n: number, one: string, many: string): string {
  return `${formatInt(n)} ${n === 1 ? one : many}`;
}

function nameList(names: readonly string[], max = 2): string {
  if (names.length <= max) {
    return names.length === 2 ? `${names[0]} och ${names[1]}` : (names[0] ?? "");
  }
  return `${names.slice(0, max).join(", ")} och ${formatInt(names.length - max)} till`;
}

/** Datum för texterna: dagen vars inköpspris är "aktuellt" (periodens slut) och i dag. */
export interface HeadlineDates {
  readonly asOf: IsoDate;
  readonly today: IsoDate;
}

function priceAsOf(d: HeadlineDates): string {
  return `med inköpspriset som gäller ${formatDayShort(d.asOf, d.today)}`;
}

function sum(rows: readonly TitleRow[], f: (r: TitleRow) => number): number {
  return rows.reduce((n, r) => n + f(r), 0);
}

/**
 * Sidans tvådelade rubrik. Det som kräver åtgärd först: titlar med order utan inköpspris
 * (även de som har pris i dag men saknade det tidigare i perioden), sedan titlar som går
 * med förlust; annars den titel som lämnar minst per order. Antal order och intäkt räknas
 * per titel, så att rubrikens namn och siffror alltid gäller samma titlar.
 */
export function pageHeadline(
  rows: readonly TitleRow[],
  dates: HeadlineDates,
): { title: string; aside: string } {
  const active = rows.filter((r) => !r.archived || r.orders > 0);
  const unpriced = active.filter((r) => r.unpricedOrders > 0);
  if (unpriced.length > 0) {
    const orders = sum(unpriced, (r) => r.unpricedOrders);
    const revenue = formatKronor(kr(sum(unpriced, (r) => r.unpricedRevenueOre)), { decimals: 0 });
    const only = unpriced.length === 1 ? unpriced[0]! : null;
    if (only && only.status !== "missing") {
      return {
        title: `${only.name} har ${plural(orders, "order", "order")} utan inköpspris.`,
        aside: `${revenue} i intäkt från ${formatDayShort(only.unpricedFirstDate ?? dates.asOf, dates.today)} räknas inte in i vinsten.`,
      };
    }
    const allMissing = unpriced.every((r) => r.status === "missing");
    return {
      title: only
        ? `${only.name} saknar inköpspris.`
        : allMissing
          ? `${plural(unpriced.length, "titel", "titlar")} saknar inköpspris.`
          : `${plural(unpriced.length, "titel", "titlar")} har order utan inköpspris.`,
      aside: `${plural(orders, "order", "order")} och ${revenue} i intäkt räknas inte in i vinsten.`,
    };
  }
  const losses = active
    .filter((r) => r.status === "loss" && r.leftOre !== null)
    .sort((a, b) => (a.leftOre ?? 0) - (b.leftOre ?? 0));
  if (losses.length > 0) {
    const worst = losses[0]!;
    return {
      title:
        losses.length === 1
          ? `${worst.name} går med förlust.`
          : `${plural(losses.length, "titel", "titlar")} går med förlust.`,
      aside: sentence(
        `${losses.length === 1 ? "" : `Sämst är ${worst.name}: `}${formatKronor(kr(worst.leftOre ?? 0))} per order ${priceAsOf(dates)}`,
      ),
    };
  }
  const missing = active.filter((r) => r.status === "missing");
  if (missing.length > 0) {
    return {
      title: `${plural(missing.length, "titel", "titlar")} utan inköpspris.`,
      aside: `${nameList(missing.map((r) => r.name))} har inte sålt i perioden.`,
    };
  }
  if (active.length === 0) {
    // Ny organisation: inga titlar än ("Alla 0 titlar har inköpspris" vore sant men tomt).
    return { title: "Inga titlar ännu.", aside: "Titlar skapas när order importeras." };
  }
  const lowest = lowestLeft(active);
  return {
    title: `Alla ${plural(active.length, "titel", "titlar")} har inköpspris.`,
    aside: lowest
      ? `Minst kvar per order: ${lowest.name}, ${formatKronor(kr(lowest.leftOre ?? 0))}.`
      : "Ingen försäljning i perioden.",
  };
}

function lowestLeft(rows: readonly TitleRow[]): TitleRow | undefined {
  return rows
    .filter((r) => r.leftOre !== null && r.orders > 0)
    .sort((a, b) => (a.leftOre ?? 0) - (b.leftOre ?? 0) || a.name.localeCompare(b.name, "sv"))[0];
}

/** Grå delen av rubriken för avsnittet Per titel: den titel som lämnar minst. */
export function perTitleAside(rows: readonly TitleRow[], dates: HeadlineDates): string {
  const lowest = lowestLeft(rows.filter((r) => !r.archived || r.orders > 0));
  if (!lowest) return "Ingen titel med inköpspris har sålt i perioden.";
  return sentence(
    `Minst kvar har ${lowest.name}, ${formatKronor(kr(lowest.leftOre ?? 0))} per order ${priceAsOf(dates)}`,
  );
}

function leftText(ore: number): string {
  if (ore < 0) return `förlust ${formatKronor(kr(-ore))} per order`;
  if (ore === 0) return "går jämnt per order";
  return `${formatKronor(kr(ore))} kvar per order`;
}

/** Rubriken för en vald titel. */
export function titleHeadline(
  row: TitleRow | null,
  name: string,
  today?: IsoDate,
): { title: string; aside: string } {
  const title = `${name}.`;
  if (!row || row.currentCostOre === null) {
    return {
      title,
      aside:
        row && row.orders > 0
          ? `Saknar inköpspris: ${plural(row.orders, "order", "order")} i perioden räknas inte in i vinsten.`
          : "Saknar inköpspris.",
    };
  }
  const cost = `Inköp ${formatKronor(kr(row.currentCostOre))}${row.currentFrom ? ` sedan ${formatDayShort(row.currentFrom, today)}` : ""}`;
  if (row.leftOre === null)
    return { title, aside: `${sentence(cost)} Ingen försäljning i perioden.` };
  let left = leftText(row.leftOre);
  const afterRent = row.leftAfterRentOre;
  if (row.leftOre > 0 && afterRent !== null && afterRent <= 0) {
    left +=
      afterRent === 0
        ? ", men går jämnt efter hyra"
        : `, men förlust ${formatKronor(kr(-afterRent))} per order efter hyra`;
  }
  const unpriced =
    row.unpricedOrders > 0
      ? ` ${plural(row.unpricedOrders, "order", "order")} i perioden saknar inköpspris och räknas inte in i vinsten.`
      : "";
  return { title, aside: `${cost}, ${left}.${unpriced}` };
}

/** "27 okt." (året bara om det inte är samma år som `now`, standard: samma år som datumet). */
export function formatDayShort(date: IsoDate, now?: IsoDate): string {
  return formatDate(dayDate(date), { year: "auto", now: dayDate(now ?? date) });
}

// ---------------------------------------------------------------------------
// Tidslinje
// ---------------------------------------------------------------------------

export interface TimelineEntry {
  readonly validFrom: IsoDate;
  readonly validTo: IsoDate | null;
  readonly unitCostOre: number;
  /** Förändring mot priset före (äldre), null för det första. */
  readonly deltaOre: number | null;
  /** Förändring som andel av priset före, null om det saknas eller var 0. */
  readonly deltaShare: number | null;
  /** Antal order (all tid) som räknas med det här priset. */
  readonly orders: number;
  /** Priset gäller i dag. */
  readonly current: boolean;
  /** Priset börjar gälla senare. */
  readonly future: boolean;
  readonly note: string | null;
}

/**
 * Prishistoriken (ur @/domain priceHistory, senaste först) med förändring, antal order
 * per prisperiod och vilket pris som gäller `today`.
 */
export function priceTimeline(
  history: readonly PriceHistoryEntry[],
  orderDays: ReadonlyArray<{ date: IsoDate; orders: number }>,
  today: IsoDate,
  notes: ReadonlyMap<IsoDate, string | null> = new Map(),
): TimelineEntry[] {
  return history.map((h, i) => {
    const older = history[i + 1];
    const deltaOre = older ? h.unitCostOre - older.unitCostOre : null;
    const orders = orderDays
      .filter((d) => d.date >= h.validFrom && (h.validTo === null || d.date <= h.validTo))
      .reduce((n, d) => n + d.orders, 0);
    return {
      validFrom: h.validFrom,
      validTo: h.validTo,
      unitCostOre: h.unitCostOre,
      deltaOre,
      deltaShare:
        older && older.unitCostOre !== 0 && deltaOre !== null ? deltaOre / older.unitCostOre : null,
      orders,
      current: h.validFrom <= today && (h.validTo === null || h.validTo >= today),
      future: h.validFrom > today,
      note: notes.get(h.validFrom) ?? null,
    };
  });
}

/**
 * Hur stor del av tidslinjen (från första priset till `today`, eller sista priset om det
 * ligger senare) varje pris täcker, i samma ordning som `entries`. Summerar till 1.
 */
export function timelineShares(entries: readonly TimelineEntry[], today: IsoDate): number[] {
  if (entries.length === 0) return [];
  const oldest = entries[entries.length - 1]!.validFrom;
  const newest = entries[0]!.validFrom;
  const end = newest > today ? newest : today;
  const total = daysBetween(oldest, end) + 1;
  const spans = entries.map((e) => {
    const to = e.validTo === null ? end : e.validTo < end ? e.validTo : end;
    return Math.max(1, daysBetween(e.validFrom, to) + 1);
  });
  const sum = spans.reduce((a, b) => a + b, 0) || total;
  return spans.map((s) => s / sum);
}

// ---------------------------------------------------------------------------
// Ändringslogg
// ---------------------------------------------------------------------------

export interface PriceLogEntry {
  readonly id: string;
  readonly occurredAt: string;
  readonly actor: string;
  readonly kind: "Nytt pris" | "Ändrat pris" | "Borttaget pris";
  /** Datumet ändringen gäller från. */
  readonly validFrom: IsoDate;
  /** Priset som gällde från `validFrom` före ändringen (null = saknade pris). */
  readonly beforeOre: number | null;
  /** Priset som gäller från `validFrom` efter ändringen (null = saknar pris). */
  readonly afterOre: number | null;
  /** Giltig från före, om det flyttades. */
  readonly movedFrom: IsoDate | null;
  readonly note: string | null;
}

export function actorName(actorId: string | null, names: Readonly<Record<string, string>>): string {
  if (actorId === null) return "Systemet";
  return names[actorId] ?? "Borttagen användare";
}

function costOn(state: ReadonlyMap<string, PriceState>, date: IsoDate): number | null {
  let best: PriceState | null = null;
  for (const p of state.values()) {
    if (p.validFrom <= date && (best === null || p.validFrom > best.validFrom)) best = p;
  }
  return best ? best.unitCostOre : null;
}

/**
 * Loggen per titel, senaste först. Händelserna spelas upp i tidsordning så att "före"
 * för ett nytt pris blir det pris som gällde dagen innan ändringen gjordes (eller att
 * titeln saknade pris), inte bara ett tomt värde.
 */
export function priceLog(
  events: readonly PriceAuditEvent[],
  names: Readonly<Record<string, string>>,
): PriceLogEntry[] {
  const state = new Map<string, PriceState>();
  const out: PriceLogEntry[] = [];
  // Samma tidpunkt = samma transaktion (t.ex. en import av flera priser): äldsta datumet först.
  const dayOf = (e: PriceAuditEvent) => (e.after ?? e.before)?.validFrom ?? "";
  const ordered = events
    .slice()
    .sort((a, b) =>
      a.occurredAt !== b.occurredAt
        ? a.occurredAt < b.occurredAt
          ? -1
          : 1
        : dayOf(a) < dayOf(b)
          ? -1
          : dayOf(a) > dayOf(b)
            ? 1
            : 0,
    );
  for (const e of ordered) {
    const actor = actorName(e.actorId, names);
    if (e.action === "insert" && e.after) {
      const before = costOn(state, e.after.validFrom);
      state.set(e.rowId, e.after);
      out.push({
        id: e.id,
        occurredAt: e.occurredAt,
        actor,
        kind: "Nytt pris",
        validFrom: e.after.validFrom,
        beforeOre: before,
        afterOre: e.after.unitCostOre,
        movedFrom: null,
        note: e.after.note,
      });
    } else if (e.action === "update" && e.after) {
      const prior = state.get(e.rowId) ?? e.before;
      const before = e.before ?? prior;
      state.set(e.rowId, e.after);
      const moved = before && before.validFrom !== e.after.validFrom ? before.validFrom : null;
      out.push({
        id: e.id,
        occurredAt: e.occurredAt,
        actor,
        kind: "Ändrat pris",
        validFrom: e.after.validFrom,
        beforeOre: before ? before.unitCostOre : null,
        afterOre: e.after.unitCostOre,
        movedFrom: moved,
        note: e.after.note,
      });
    } else if (e.action === "delete" && e.before) {
      state.delete(e.rowId);
      out.push({
        id: e.id,
        occurredAt: e.occurredAt,
        actor,
        kind: "Borttaget pris",
        validFrom: e.before.validFrom,
        beforeOre: e.before.unitCostOre,
        afterOre: costOn(state, e.before.validFrom),
        movedFrom: null,
        note: e.before.note,
      });
    }
  }
  return out.reverse();
}

// ---------------------------------------------------------------------------
// Förhandsvisning av ett nytt pris
// ---------------------------------------------------------------------------

export interface PricePreview {
  /** Priset som ersätts (samma titel och datum), annars null. */
  readonly replaces: { unitCostOre: number; validFrom: IsoDate } | null;
  readonly affectedOrders: number;
  readonly firstDate: IsoDate | null;
  readonly lastDate: IsoDate | null;
  readonly costDeltaOre: number;
  readonly ordersGainingPrice: number;
  /** Sista dagen det nya priset gäller (dagen före nästa pris), null = tills vidare. */
  readonly validTo: IsoDate | null;
  /** Stängda månader priset skulle gälla i (blockerar). */
  readonly closedMonths: string[];
  /** Order (alla tider) som fortfarande saknar pris efter ändringen, med första och sista dag. */
  readonly stillUnpriced: { orders: number; firstDate: IsoDate; lastDate: IsoDate } | null;
}

/** Orderdagar före titelns första inköpspris: de order som saknar pris. */
function unpricedDays(
  prices: ReadonlyArray<Pick<PriceRecord, "validFrom">>,
  orderDays: ReadonlyArray<{ date: IsoDate; orders: number }>,
): Array<{ date: IsoDate; orders: number }> {
  const earliest = prices
    .map((p) => p.validFrom)
    .sort()
    .at(0);
  return orderDays
    .filter((d) => d.orders > 0 && (earliest === undefined || d.date < earliest))
    .slice()
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/**
 * Vad ett nytt pris gör med titelns order (alla tider): räknas med @/domain
 * priceChangeImpact på orderdagarna (inga belopp behövs för inköpet).
 */
export function previewPrice(args: {
  readonly titleId: string;
  readonly prices: ReadonlyArray<Pick<PriceRecord, "unitCostOre" | "validFrom">>;
  readonly orderDays: ReadonlyArray<{ date: IsoDate; orders: number }>;
  readonly unitCostOre: number;
  readonly validFrom: IsoDate;
  readonly closedMonths: readonly string[];
}): PricePreview {
  const { titleId } = args;
  const prices: PurchasePrice[] = args.prices.map((p) => ({
    titleId,
    unitCostOre: p.unitCostOre,
    validFrom: p.validFrom,
  }));
  const orders: OrderLine[] = [];
  for (const d of args.orderDays) {
    for (let i = 0; i < d.orders; i++) {
      orders.push({
        id: `${d.date}:${i}`,
        externalId: `${d.date}:${i}`,
        titleId,
        machineId: null,
        businessDate: d.date,
        amountOre: 0,
      });
    }
  }
  const impact = priceChangeImpact({
    orders,
    prices,
    change: {
      kind: "upsert",
      price: { titleId, unitCostOre: args.unitCostOre, validFrom: args.validFrom },
    },
    closedMonths: args.closedMonths,
  });
  const existing = args.prices.find((p) => p.validFrom === args.validFrom) ?? null;
  const next = args.prices
    .map((p) => p.validFrom)
    .filter((d) => d > args.validFrom)
    .sort()[0];
  return {
    replaces: existing
      ? { unitCostOre: existing.unitCostOre, validFrom: existing.validFrom }
      : null,
    affectedOrders: impact.affectedOrders,
    firstDate: impact.firstDate,
    lastDate: impact.lastDate,
    costDeltaOre: impact.costDeltaOre,
    ordersGainingPrice: impact.ordersGainingPrice,
    validTo: next ? addDays(next, -1) : null,
    closedMonths: closedMonthsHit(args.prices, args.validFrom, args.closedMonths),
    stillUnpriced: stillUnpriced(args.prices, args.orderDays, args.validFrom),
  };
}

function stillUnpriced(
  prices: ReadonlyArray<Pick<PriceRecord, "validFrom">>,
  orderDays: ReadonlyArray<{ date: IsoDate; orders: number }>,
  validFrom: IsoDate,
): PricePreview["stillUnpriced"] {
  const days = unpricedDays([...prices, { validFrom }], orderDays);
  if (days.length === 0) return null;
  return {
    orders: days.reduce((n, d) => n + d.orders, 0),
    firstDate: days[0]!.date,
    lastDate: days[days.length - 1]!.date,
  };
}

// ---------------------------------------------------------------------------
// Rätta priset: det nya priset gäller all försäljning hittills
// ---------------------------------------------------------------------------

/** Ett steg i en rättelse. Raderna pekas ut med giltig från (unikt per titel). */
export type CorrectionStep =
  | {
      readonly kind: "update";
      readonly validFrom: IsoDate;
      /** Flyttas bakåt till rättelsens första dag (titelns första order före första priset). */
      readonly newValidFrom: IsoDate | null;
    }
  | { readonly kind: "insert"; readonly validFrom: IsoDate };

export interface PriceCorrection {
  /** Första dagen som får det nya priset, null = går inte (i dag ligger i en stängd månad). */
  readonly start: IsoDate | null;
  /** Sista dagen (dagen före ett pris som börjar senare än i dag), null = tills vidare. */
  readonly validTo: IsoDate | null;
  /** Den stängda månad 'ÅÅÅÅ-MM' som gör att rättelsen börjar först efter den, annars null. */
  readonly closedUntil: string | null;
  readonly steps: CorrectionStep[];
  /** Order som får ett annat inköp (även de som saknade pris). */
  readonly affectedOrders: number;
  /** Av dem: order som saknade pris och nu räknas in i vinsten. */
  readonly ordersGainingPrice: number;
  /** Ändrat inköp för order som redan hade pris. */
  readonly costDeltaOre: number;
  /** Vinstens förändring för order som redan hade pris (= −costDeltaOre). */
  readonly profitDeltaOre: number;
}

type DayPrice = Pick<PriceRecord, "unitCostOre" | "validFrom">;

function costOnDay(sorted: readonly DayPrice[], date: IsoDate): number | null {
  let cost: number | null = null;
  for (const p of sorted) {
    if (p.validFrom > date) break;
    cost = p.unitCostOre;
  }
  return cost;
}

/**
 * "Rätta priset": det nya priset ersätter titelns nuvarande pris och alla äldre, så att all
 * försäljning hittills (från titelns första order eller första pris) räknas med det. Ett pris
 * som börjar senare än i dag behålls. Stängda månader rörs aldrig: ligger titelns början i
 * eller före en stängd månad börjar rättelsen dagen efter den senaste stängda månaden.
 *
 * Inga rader tas bort (purchase_prices raderas inte): perioderna från rättelsens början till
 * i dag får det nya beloppet, den första flyttas vid behov bakåt till titelns första order
 * och en ny rad läggs in bara där ett äldre pris (i en stängd månad) annars skulle gälla.
 */
export function planCorrection(args: {
  readonly prices: readonly DayPrice[];
  readonly orderDays: ReadonlyArray<{ date: IsoDate; orders: number }>;
  readonly unitCostOre: number;
  readonly closedMonths: readonly string[];
  readonly today: IsoDate;
}): PriceCorrection {
  const { unitCostOre, today } = args;
  const sorted = args.prices
    .slice()
    .sort((a, b) => (a.validFrom < b.validFrom ? -1 : a.validFrom > b.validFrom ? 1 : 0));
  const firstOrder = args.orderDays
    .filter((d) => d.orders > 0 && d.date <= today)
    .map((d) => d.date)
    .sort()[0];
  const firstPrice = sorted.find((p) => p.validFrom <= today)?.validFrom;
  const begin = [firstOrder, firstPrice, today].filter((d): d is IsoDate => !!d).sort()[0]!;

  const latestClosed = args.closedMonths
    .filter((m) => `${m}-01` <= today)
    .slice()
    .sort()
    .at(-1);
  const cutoff = latestClosed ? `${addMonths(latestClosed, 1)}-01` : null;
  const start = cutoff && cutoff > begin ? cutoff : begin;
  const closedUntil = cutoff && cutoff > begin ? latestClosed! : null;
  const nextFuture = sorted.find((p) => p.validFrom > today)?.validFrom;
  const validTo = nextFuture ? addDays(nextFuture, -1) : null;

  const empty = {
    validTo,
    closedUntil,
    steps: [] as CorrectionStep[],
    affectedOrders: 0,
    ordersGainingPrice: 0,
    costDeltaOre: 0,
    profitDeltaOre: 0,
  };
  if (start > today) return { ...empty, start: null };

  const inRange = sorted.filter((p) => p.validFrom >= start && p.validFrom <= today);
  const before = sorted.filter((p) => p.validFrom < start).at(-1);
  const steps: CorrectionStep[] = [];
  const atStart = inRange[0]?.validFrom === start;
  // Ett äldre pris (i en stängd månad) gäller annars från rättelsens början: en ny period
  // behövs, om inte det priset redan är det rätta.
  const needsInsert = before ? before.unitCostOre !== unitCostOre : inRange.length === 0;
  if (!atStart && needsInsert) {
    steps.push({ kind: "insert", validFrom: start });
  }
  inRange.forEach((p, i) => {
    const move = i === 0 && !atStart && !before ? start : null;
    if (p.unitCostOre !== unitCostOre || move) {
      steps.push({ kind: "update", validFrom: p.validFrom, newValidFrom: move });
    }
  });

  let affected = 0;
  let gaining = 0;
  let costDelta = 0;
  for (const d of args.orderDays) {
    if (d.orders <= 0 || d.date < start || (validTo !== null && d.date > validTo)) continue;
    const old = costOnDay(sorted, d.date);
    if (old === unitCostOre) continue;
    affected += d.orders;
    if (old === null) gaining += d.orders;
    else costDelta += (unitCostOre - old) * d.orders;
  }
  return {
    ...empty,
    start,
    steps,
    affectedOrders: affected,
    ordersGainingPrice: gaining,
    costDeltaOre: costDelta,
    profitDeltaOre: costDelta === 0 ? 0 : -costDelta,
  };
}

function cap(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** "+2 295 kr" (öre bara när de finns). */
export function signedKr(ore: number): string {
  return formatSignedKronor(kr(ore), { decimals: ore % 100 === 0 ? 0 : 2 });
}

/** Förhandsvisningen under knapparna: vad "Rätta priset" gör med sålda order. */
export function correctionText(c: PriceCorrection, today: IsoDate): string[] {
  const lines: string[] = [];
  if (c.start === null) {
    return [`${cap(monthName(c.closedUntil ?? monthOf(today)))} är stängd. Välj Nytt inköpspris.`];
  }
  if (c.closedUntil) {
    lines.push(
      sentence(
        `${cap(monthName(c.closedUntil))} är stängd, rättas från ${formatDayShort(c.start, today)}`,
      ),
    );
  }
  if (c.affectedOrders === 0) {
    lines.push("Inga sålda order får nytt inköp.");
    return lines;
  }
  const priced = c.affectedOrders - c.ordersGainingPrice;
  if (priced > 0) {
    lines.push(
      `${plural(c.affectedOrders, "order", "order")} får nytt inköp, vinsten ändras med ${signedKr(c.profitDeltaOre)}.`,
    );
  } else {
    lines.push(`${plural(c.affectedOrders, "order", "order")} får inköpspris.`);
  }
  if (c.ordersGainingPrice > 0) {
    lines.push(
      `${plural(c.ordersGainingPrice, "order", "order")} saknade pris och räknas nu in i vinsten.`,
    );
  }
  return lines;
}

/** Toasten efter "Rätta priset". */
export function correctionToast(c: {
  readonly profitDeltaOre: number;
  readonly affectedOrders: number;
  readonly ordersGainingPrice: number;
}): string {
  if (c.affectedOrders > c.ordersGainingPrice) {
    return `Priset rättat – vinsten ändrades med ${signedKr(c.profitDeltaOre)}`;
  }
  if (c.ordersGainingPrice > 0) {
    return `Priset rättat – ${plural(c.ordersGainingPrice, "order", "order")} räknas nu in i vinsten`;
  }
  return "Priset rättat";
}

/**
 * Titlar som får signalfärg i tabellen: de som kräver åtgärd (saknar pris, förlust), det
 * viktigaste först, högst `max` (signalbudgeten är tre per vy).
 */
export function signalTitleIds(rows: readonly TitleRow[], max = 3): string[] {
  return rows
    .filter((r) => r.status === "missing" || r.status === "loss")
    .slice()
    .sort(
      (a, b) =>
        STATUS_RANK[a.status] - STATUS_RANK[b.status] ||
        b.orders - a.orders ||
        (a.leftOre ?? 0) - (b.leftOre ?? 0) ||
        a.name.localeCompare(b.name, "sv"),
    )
    .slice(0, max)
    .map((r) => r.id);
}

/** Titelns sektion (rubrik och prisredigerare): tabellen rullar dit och sätter markören i priset. */
export const PRICE_EDITOR_ID = "titel";

/** En sak att göra på Inköpspriser: sätta pris eller se över en titel som går med förlust. */
export interface PriceTodo {
  readonly id: string;
  readonly verb: "Sätt pris" | "Sätt kostnad" | "Förlust";
  readonly title: string;
  /** Order utan pris (Sätt pris) eller i perioden (Förlust). */
  readonly orders: number;
  readonly tone: "critical" | "warning";
}

/**
 * Listan överst: titlar som säljer utan pris (flest order först), sedan titlar med förlust.
 * Arkiverade titlar utan order hoppas över. Ren.
 */
export function priceTodos(rows: readonly TitleRow[]): PriceTodo[] {
  const active = rows.filter((r) => !r.archived || r.orders > 0);
  const missing = active
    .filter((r) => r.unpricedOrders > 0 || (r.status === "missing" && !r.archived))
    .sort(
      (a, b) =>
        b.unpricedOrders - a.unpricedOrders ||
        a.name.localeCompare(b.name, "sv", { sensitivity: "base" }),
    )
    .map((r): PriceTodo => ({
      id: r.id,
      verb: r.own ? "Sätt kostnad" : "Sätt pris",
      title: r.name,
      orders: r.unpricedOrders,
      tone: r.unpricedOrders > 0 ? "critical" : "warning",
    }));
  const loss = active
    .filter((r) => r.status === "loss")
    .sort((a, b) => (a.leftOre ?? 0) - (b.leftOre ?? 0))
    .map((r): PriceTodo => ({
      id: r.id,
      verb: "Förlust",
      title: r.name,
      orders: r.orders,
      tone: "critical",
    }));
  return [...missing, ...loss];
}

/**
 * Visningsmodellen för Inköpspriser: rubriker, rader, tidslinje och ändringslogg.
 * Rena funktioner utan databas (testas i model.test.ts). Ekonomin (snittpris, kvar per
 * order, förlustvarning, påverkan av en prisändring) räknas i @/domain; här sätts den
 * bara ihop med namn, datum och text.
 */

import {
  addDays,
  daysBetween,
  monthOf,
  priceChangeImpact,
  type IsoDate,
  type OrderLine,
  type PriceHistoryEntry,
  type PurchasePrice,
  type TitleEconomics,
} from "@/domain";
import { parseAmountOre } from "@/import/amount";
import { formatDate, formatInt, formatKronor, formatMonth } from "@/lib/format";

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

export type TitleStatus = "missing" | "loss" | "loss-after-rent" | "idle" | "ok";

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
  readonly unpricedOrders: number;
  readonly status: TitleStatus;
}

export interface TitleInfo {
  readonly id: string;
  readonly name: string;
  readonly series: string | null;
  readonly archived: boolean;
}

export const STATUS_LABEL: Record<TitleStatus, string> = {
  missing: "Saknar pris",
  loss: "Förlust",
  "loss-after-rent": "Förlust efter hyra",
  idle: "Ingen försäljning",
  ok: "Lönsam",
};

/** Ordning när tabellen sorteras på status: det som kräver åtgärd först. */
export const STATUS_RANK: Record<TitleStatus, number> = {
  missing: 0,
  loss: 1,
  "loss-after-rent": 2,
  idle: 3,
  ok: 4,
};

export const PRICE_MESSAGES = {
  forbidden: "Bara ägare och admin kan ändra inköpspriser.",
  invalid: "Uppgifterna stämmer inte. Kontrollera pris och datum och försök igen.",
  titleMissing: "Titeln finns inte längre. Ladda om sidan.",
  titleMerged: "Titeln är sammanslagen med en annan. Lägg priset på den titeln i stället.",
  unchanged: "Priset är redan inlagt med samma belopp och datum.",
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
  if (e.lossAfterRentWarning) return "loss-after-rent";
  if (e.orders === 0) return "idle";
  return "ok";
}

/** En rad per titel i titleEconomics, med namn. Titlar utan namn (borttagna) hoppas över. */
export function titleRows(
  economics: readonly TitleEconomics[],
  titles: readonly TitleInfo[],
): TitleRow[] {
  const byId = new Map(titles.map((t) => [t.id, t]));
  return economics.flatMap((e): TitleRow[] => {
    const t = byId.get(e.titleId);
    if (!t) return [];
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
        status: statusOf(e),
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

/** Order utan inköpspris i perioden (ur profitability().unpriced). */
export interface UnpricedFacts {
  readonly orders: number;
  readonly revenueOre: number;
}

/**
 * Sidans tvådelade rubrik. Det som kräver åtgärd först: titlar utan pris, sedan titlar
 * som går med förlust; annars den titel som lämnar minst per order.
 */
export function pageHeadline(
  rows: readonly TitleRow[],
  unpriced: UnpricedFacts,
): { title: string; aside: string } {
  const active = rows.filter((r) => !r.archived || r.orders > 0);
  const missing = active.filter((r) => r.status === "missing");
  const missingSold = missing.filter((r) => r.orders > 0);
  if (missingSold.length > 0) {
    const names = missingSold.map((r) => r.name);
    return {
      title:
        missingSold.length === 1
          ? `${names[0]} saknar inköpspris.`
          : `${plural(missingSold.length, "titel", "titlar")} saknar inköpspris.`,
      aside:
        unpriced.orders > 0
          ? `${plural(unpriced.orders, "order", "order")} och ${formatKronor(kr(unpriced.revenueOre), { decimals: 0 })} i intäkt räknas inte in i vinsten.`
          : `${nameList(names)} räknas inte in i vinsten förrän priset finns.`,
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
      aside: `${losses.length === 1 ? "" : `Sämst är ${worst.name}: `}${formatKronor(kr(worst.leftOre ?? 0))} per order med dagens inköpspris.`,
    };
  }
  if (missing.length > 0) {
    return {
      title: `${plural(missing.length, "titel", "titlar")} utan inköpspris.`,
      aside: `${nameList(missing.map((r) => r.name))} har inte sålt i perioden.`,
    };
  }
  const sold = active.filter((r) => r.leftOre !== null && r.orders > 0);
  const lowest = sold.slice().sort((a, b) => (a.leftOre ?? 0) - (b.leftOre ?? 0))[0];
  return {
    title: `Alla ${plural(active.length, "titel", "titlar")} har inköpspris.`,
    aside: lowest
      ? `Minst kvar per order: ${lowest.name}, ${formatKronor(kr(lowest.leftOre ?? 0))}.`
      : "Ingen försäljning i perioden.",
  };
}

/** Rubriken för en vald titel. */
export function titleHeadline(
  row: TitleRow | null,
  name: string,
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
  const cost = `Inköp ${formatKronor(kr(row.currentCostOre))}${row.currentFrom ? ` sedan ${formatDayShort(row.currentFrom)}` : ""}`;
  if (row.leftOre === null)
    return { title, aside: `${sentence(cost)} Ingen försäljning i perioden.` };
  const left =
    row.leftOre <= 0
      ? `Förlust ${formatKronor(kr(-row.leftOre))} per order`
      : `${formatKronor(kr(row.leftOre))} kvar per order`;
  return { title, aside: `${cost}, ${left}.` };
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
  };
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

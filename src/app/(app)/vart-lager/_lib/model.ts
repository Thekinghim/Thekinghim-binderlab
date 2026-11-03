/**
 * Vårt lager: vymodellen. Ren och klientsäker: allt räknas här från färdiga rader
 * (laddaren i ./data.ts), så att testet i ./model.test.ts täcker siffrorna på sidan.
 *
 * - Antal hemma: centrallagrets saldo (stock_levels på platsen is_central).
 * - I automaterna: summan av automaternas kända saldon (Awish eller inventering), aldrig under 0.
 * - Sålt 7 d: sålda pack de senaste sju dagarna t.o.m. i dag, alla automater.
 * - Räcker: samma dagar och status som Prognos & inköp (Lagers vymodell, WarehouseRow).
 * - Värde: antal hemma × inköpspriset som gäller i dag (öre), bara titlar med pris.
 * - Senaste ändring: senaste händelsen i centrallagret (inte försäljning).
 */

import { wallClockIn } from "@/components/shell/period-state";
import { priceOn, type IsoDate, type PurchasePrice } from "@/domain";
import { formatDateTime, formatInt, formatTime, MINUS, NBSP } from "@/lib/format";

import { WAREHOUSE_LOW_DAYS, type StockStatus, type WarehouseRow } from "../../lager/_lib/types";
import { AWISH_REFILL_NOTE_PREFIX } from "@/server/awish/refill-deduction";

/** Notering som register_refill sätter på uttaget ur centrallagret. */
const MANUAL_REFILL_NOTE_PREFIX = "Uttag till påfyllning av ";
/** Notering när register_refill lägger tillbaka ett Awish-uttag (påfyllning utan uttag). */
const RETURNED_NOTE_PREFIX = "Återfört Awish-uttag ";

export interface WarehouseEvent {
  readonly titleId: string;
  readonly kind: string;
  readonly quantity: number;
  readonly occurredAt: string;
  readonly note: string | null;
  readonly source: string | null;
}

export interface MachineRef {
  readonly code: string;
  readonly name: string;
  readonly storeName: string | null;
}

export interface VartLagerInput {
  readonly now: Date;
  readonly timeZone: string;
  readonly today: IsoDate;
  readonly titles: readonly { readonly id: string; readonly name: string }[];
  /** Centrallagrets rader ur Lagers vymodell (dagar kvar och status). */
  readonly warehouse: readonly WarehouseRow[];
  /** Saldot hemma per titel (alla titlar med händelser i centrallagret). */
  readonly home: ReadonlyMap<string, number>;
  /** Pack i automaterna per titel (kända saldon, under 0 räknas som 0). */
  readonly inMachines: ReadonlyMap<string, number>;
  /** Sålda pack de senaste 7 dagarna per titel. */
  readonly sold7: ReadonlyMap<string, number>;
  readonly prices: readonly PurchasePrice[];
  /** Senaste händelsen i centrallagret per titel. */
  readonly latest: ReadonlyMap<string, WarehouseEvent>;
  readonly machines: readonly MachineRef[];
  readonly canEdit: boolean;
}

export interface LatestChange {
  /** "−12 påfyllning Sega gubben" · "+24 inköp" · "räknat 84" */
  readonly text: string;
  /** "i dag 14:05" */
  readonly when: string;
  /** Ändringen i pack (negativ = ut), eller null för en inventering. */
  readonly delta: number | null;
  /** Sant om det var Awish (påfyllning som synken såg). */
  readonly automatic: boolean;
}

export interface VartLagerRow {
  readonly titleId: string;
  readonly name: string;
  readonly home: number;
  readonly inMachines: number;
  readonly sold7: number;
  /** Hela dagar hemmalagret räcker, eller null (ingen försäljning). */
  readonly daysLeft: number | null;
  readonly status: StockStatus;
  /** Räcker kortare än WAREHOUSE_LOW_DAYS eller behövs och är slut. */
  readonly runsOut: boolean;
  /** Saldot är under 0: något har inte registrerats. Visas som "Räkna om". */
  readonly negative: boolean;
  readonly unitCostOre: number | null;
  readonly valueOre: number | null;
  readonly latest: LatestChange | null;
}

export interface VartLagerModel {
  readonly rows: VartLagerRow[];
  readonly totals: {
    readonly home: number;
    readonly valueOre: number;
    /** Titlar med antal hemma men utan inköpspris (räknas inte i värdet). */
    readonly unpriced: number;
    readonly runsOut: number;
    readonly negative: number;
    readonly inMachines: number;
  };
  readonly lowDays: number;
  readonly canEdit: boolean;
}

const sv = (a: string, b: string) =>
  a.localeCompare(b, "sv", { sensitivity: "base", numeric: true });

/** "i dag 14:05" · "i går 09:12" · "2 nov. 14:05" i organisationens tidszon. */
export function whenText(iso: string, timeZone: string, now: Date): string {
  const d = wallClockIn(new Date(iso), timeZone);
  const n = wallClockIn(now, timeZone);
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(n) - day(d)) / 86_400_000);
  if (diff === 0) return `i dag ${formatTime(d)}`;
  if (diff === 1) return `i går ${formatTime(d)}`;
  return formatDateTime(d, { now: n });
}

function signed(n: number): string {
  return n < 0 ? `${MINUS}${formatInt(-n)}` : `+${formatInt(n)}`;
}

/** Påfyllningens plats ur noteringen: butiken för automatens kod, annars resten av texten. */
function refillPlace(rest: string, machines: readonly MachineRef[]): string {
  const code = rest.split(/\s+/)[0] ?? "";
  const m = machines.find((x) => x.code === code);
  if (m) return m.storeName ?? m.name;
  return rest.trim() || "automat";
}

/** Texten för senaste ändringen. Ren. */
export function describeChange(
  e: WarehouseEvent,
  machines: readonly MachineRef[],
  timeZone: string,
  now: Date,
): LatestChange {
  const when = whenText(e.occurredAt, timeZone, now);
  const note = e.note ?? "";
  if (e.kind === "count") {
    return { text: `räknat ${formatInt(e.quantity)}`, when, delta: null, automatic: false };
  }
  if (e.kind === "receipt") {
    return { text: `${signed(e.quantity)} inköp`, when, delta: e.quantity, automatic: false };
  }
  if (e.kind === "adjustment" && note.startsWith(AWISH_REFILL_NOTE_PREFIX)) {
    const place = refillPlace(note.slice(AWISH_REFILL_NOTE_PREFIX.length), machines);
    return {
      text: `${signed(e.quantity)} påfyllning ${place}`,
      when,
      delta: e.quantity,
      automatic: true,
    };
  }
  if (e.kind === "adjustment" && note.startsWith(MANUAL_REFILL_NOTE_PREFIX)) {
    const place = refillPlace(note.slice(MANUAL_REFILL_NOTE_PREFIX.length), machines);
    return {
      text: `${signed(e.quantity)} påfyllning ${place}`,
      when,
      delta: e.quantity,
      automatic: false,
    };
  }
  if (e.kind === "adjustment" && note.startsWith(RETURNED_NOTE_PREFIX)) {
    const place = refillPlace(note.slice(RETURNED_NOTE_PREFIX.length), machines);
    return {
      text: `${signed(e.quantity)} återfört ${place}`,
      when,
      delta: e.quantity,
      automatic: false,
    };
  }
  const word =
    e.kind === "transfer_in" || e.kind === "transfer_out"
      ? "flytt"
      : e.kind === "waste"
        ? "svinn"
        : e.kind === "refill"
          ? "påfyllning"
          : "justering";
  return { text: `${signed(e.quantity)} ${word}`, when, delta: e.quantity, automatic: false };
}

export function buildVartLagerModel(input: VartLagerInput): VartLagerModel {
  const wh = new Map(input.warehouse.map((r) => [r.titleId, r]));
  const rows: VartLagerRow[] = [...input.titles]
    .sort((a, b) => sv(a.name, b.name))
    .map((t) => {
      const r = wh.get(t.id);
      const home = r?.onHand ?? input.home.get(t.id) ?? 0;
      const inMachines = Math.max(0, input.inMachines.get(t.id) ?? 0);
      const sold7 = input.sold7.get(t.id) ?? 0;
      // Utan rad i Lagers modell (inget i lagret och inget behov i veckan): slut om den säljer.
      const status: StockStatus = r ? r.status : home <= 0 && sold7 > 0 ? "critical" : "ok";
      const daysLeft = r ? r.daysLeft : null;
      const price = priceOn(input.prices, t.id, input.today);
      const unitCostOre = price?.unitCostOre ?? null;
      const e = input.latest.get(t.id);
      return {
        titleId: t.id,
        name: t.name,
        home,
        inMachines,
        sold7,
        daysLeft,
        status,
        runsOut: status !== "ok",
        negative: home < 0,
        unitCostOre,
        valueOre: unitCostOre === null ? null : Math.max(0, home) * unitCostOre,
        latest: e ? describeChange(e, input.machines, input.timeZone, input.now) : null,
      };
    });
  return {
    rows,
    totals: {
      home: rows.reduce((s, r) => s + Math.max(0, r.home), 0),
      valueOre: rows.reduce((s, r) => s + (r.valueOre ?? 0), 0),
      unpriced: rows.filter((r) => r.home > 0 && r.unitCostOre === null).length,
      runsOut: rows.filter((r) => r.runsOut).length,
      negative: rows.filter((r) => r.negative).length,
      inMachines: rows.reduce((s, r) => s + r.inMachines, 0),
    },
    lowDays: WAREHOUSE_LOW_DAYS,
    canEdit: input.canEdit,
  };
}

/** "räcker 12 d" · "slut" · "–" */
export function lastsText(r: Pick<VartLagerRow, "home" | "daysLeft" | "sold7">): string {
  if (r.home <= 0) return r.sold7 > 0 || r.daysLeft !== null ? "slut" : "–";
  if (r.daysLeft === null) return "–";
  if (r.daysLeft === 0) return `<${NBSP}1${NBSP}d`;
  return `${formatInt(r.daysLeft)}${NBSP}d`;
}

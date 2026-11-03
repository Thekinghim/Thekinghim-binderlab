/**
 * Vårt lager: vymodellen. Ren och klientsäker: allt räknas här från färdiga rader
 * (laddaren i ./data.ts), så att testet i ./model.test.ts täcker siffrorna på sidan.
 *
 * - Antal i lager: summan av alla egna lager (Hemma, Kontoret …); per lager i `byPlace`.
 * - I automaterna: summan av automaternas kända saldon (Awish eller inventering), aldrig under 0.
 * - Sålt 7 d: sålda pack de senaste sju dagarna t.o.m. i dag, alla automater.
 * - Räcker: samma dagar och status som Prognos & inköp (Lagers vymodell, WarehouseRow).
 * - Värde: antal hemma × inköpspriset som gäller i dag (öre), bara titlar med pris.
 * - Senaste ändring: senaste händelsen i något eget lager (inte försäljning), och per lager.
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
  /** Lagret händelsen gäller (utelämnat = standardlagret). */
  readonly locationId?: string;
  /** Vid en flytt: det andra lagrets namn. */
  readonly counterpart?: string | null;
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
  /** Vårt lagers rader ur Lagers vymodell (summan av alla egna lager: dagar kvar och status). */
  readonly warehouse: readonly WarehouseRow[];
  /** Saldot i alla egna lager tillsammans per titel. */
  readonly home: ReadonlyMap<string, number>;
  /** De egna lagren, standardlagret först. Utelämnat = ett lager (inga platsval). */
  readonly places?: readonly Place[];
  /** Saldot per lager: platsens id → titelns id → pack. */
  readonly byPlace?: Readonly<Record<string, Readonly<Record<string, number>>>>;
  /** Pack i automaterna per titel (kända saldon, under 0 räknas som 0). */
  readonly inMachines: ReadonlyMap<string, number>;
  /** Sålda pack de senaste 7 dagarna per titel. */
  readonly sold7: ReadonlyMap<string, number>;
  readonly prices: readonly PurchasePrice[];
  /** Senaste händelsen per titel och lager (en eller flera per titel). */
  readonly latest: ReadonlyMap<string, WarehouseEvent | readonly WarehouseEvent[]>;
  readonly machines: readonly MachineRef[];
  readonly canEdit: boolean;
}

export interface Place {
  readonly id: string;
  readonly name: string;
  readonly isDefault: boolean;
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
  /** Pack i alla egna lager tillsammans. */
  readonly home: number;
  /** Pack per lager (platsens id → pack; saknas = 0). */
  readonly byPlace: Readonly<Record<string, number>>;
  /** Senaste ändringen per lager. */
  readonly latestByPlace: Readonly<Record<string, LatestChange>>;
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
    /** Pack per lager (negativa saldon räknas som 0). */
    readonly byPlace: Readonly<Record<string, number>>;
  };
  readonly places: readonly Place[];
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

/**
 * Texten för senaste ändringen. Ren. Med `place` (flera lager, alla visas) står lagret
 * först: "−12 från Kontoret, påfyllning Sega gubben" · "+24 till Hemma, inköp" ·
 * "räknat 84 i Kontoret".
 */
export function describeChange(
  e: WarehouseEvent,
  machines: readonly MachineRef[],
  timeZone: string,
  now: Date,
  place: string | null = null,
): LatestChange {
  const base = describeChangeAt(e, machines, timeZone, now);
  if (!place) return base;
  if (e.kind === "count") return { ...base, text: `${base.text} i ${place}` };
  const [amount, ...rest] = base.text.split(" ");
  const dir = e.quantity < 0 ? "från" : "till";
  return { ...base, text: `${amount} ${dir} ${place}, ${rest.join(" ")}` };
}

function describeChangeAt(
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
  if (e.kind === "transfer_in" || e.kind === "transfer_out") {
    const other = e.counterpart?.trim();
    const text = other
      ? `${signed(e.quantity)} flytt ${e.kind === "transfer_out" ? "till" : "från"} ${other}`
      : `${signed(e.quantity)} flytt`;
    return { text, when, delta: e.quantity, automatic: false };
  }
  const word = e.kind === "waste" ? "svinn" : e.kind === "refill" ? "påfyllning" : "justering";
  return { text: `${signed(e.quantity)} ${word}`, when, delta: e.quantity, automatic: false };
}

const asList = (v: WarehouseEvent | readonly WarehouseEvent[] | undefined) =>
  v === undefined
    ? []
    : Array.isArray(v)
      ? (v as readonly WarehouseEvent[])
      : [v as WarehouseEvent];

export function buildVartLagerModel(input: VartLagerInput): VartLagerModel {
  const wh = new Map(input.warehouse.map((r) => [r.titleId, r]));
  const places = input.places ?? [];
  const multi = places.length > 1;
  const placeName = new Map(places.map((p) => [p.id, p.name]));
  const defaultPlace = places.find((p) => p.isDefault) ?? places[0];
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
      const events = asList(input.latest.get(t.id));
      const byPlace: Record<string, number> = {};
      for (const p of places) byPlace[p.id] = input.byPlace?.[p.id]?.[t.id] ?? 0;
      const latestByPlace: Record<string, LatestChange> = {};
      let e: WarehouseEvent | undefined;
      for (const x of events) {
        const at = x.locationId ?? defaultPlace?.id;
        if (at && !latestByPlace[at]) {
          latestByPlace[at] = describeChange(x, input.machines, input.timeZone, input.now);
        }
        if (!e || x.occurredAt > e.occurredAt) e = x;
      }
      const eAt = e ? (e.locationId ?? defaultPlace?.id) : undefined;
      return {
        titleId: t.id,
        name: t.name,
        home,
        byPlace,
        latestByPlace,
        inMachines,
        sold7,
        daysLeft,
        status,
        runsOut: status !== "ok",
        negative: home < 0,
        unitCostOre,
        valueOre: unitCostOre === null ? null : Math.max(0, home) * unitCostOre,
        latest: e
          ? describeChange(
              e,
              input.machines,
              input.timeZone,
              input.now,
              multi && eAt ? (placeName.get(eAt) ?? null) : null,
            )
          : null,
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
      byPlace: Object.fromEntries(
        places.map((p) => [p.id, rows.reduce((s, r) => s + Math.max(0, r.byPlace[p.id] ?? 0), 0)]),
      ),
    },
    places,
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

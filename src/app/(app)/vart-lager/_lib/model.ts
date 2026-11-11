/**
 * Vårt lager: vymodellen. Ren och klientsäker: allt räknas här från färdiga rader
 * (laddaren i ./data.ts), så att testet i ./model.test.ts täcker siffrorna på sidan.
 *
 * - Antal i lager: summan av alla egna lager (Hemma, Kontoret …); per lager i `byPlace`.
 * - I automaterna: summan av automaternas kända saldon (Awish eller inventering), aldrig under 0.
 * - Sålt 7 d: sålda pack de senaste sju dagarna t.o.m. i dag, alla automater.
 * - Räcker (`lastsDays`, samma regel som tabellen på Inköp): hela dagar tills allt vi har,
 *   hemma + i automaterna, är sålt vid takten de senaste 14 hela dagarna i alla automater.
 *   Ingen försäljning de senaste 7 dagarna → "–". Status (tar slut, packa) från Lagers
 *   vymodell (WarehouseRow), som Prognos & inköp.
 * - Utgår: titlar som gått ur alla automater (samma regel som Lager, `retiredTitles`). De
 *   ligger still hemma: ingen status, inget inköp, sist i listan och summerade i "Ligger still".
 * - Packa/Beställ X st (`needQty`): samma antal som Inköp på /prognos, ur inköpsplanen med
 *   EN regel (purchaseQty i @/analytics/purchasing): försäljning under ledtid + dagar till
 *   nästa beställning + säkerhetslager, minus vårt lager, automaterna och det som är
 *   beställt, avrundat till minsta order och hela boxar när leverantören är känd. Att göra
 *   överst visar titlarna där det antalet är över 0 (som Inköp), egna produkter som Packa.
 * - Värde: antal hemma × inköpspriset som gäller i dag (öre), bara titlar med pris.
 * - Senaste ändring: senaste händelsen i något eget lager (inte försäljning), och per lager.
 */

import { wallClockIn } from "@/components/shell/period-state";
import { priceOn, type IsoDate, type PurchasePrice } from "@/domain";
import { formatDateTime, formatInt, formatTime, MINUS, NBSP } from "@/lib/format";

import { WAREHOUSE_LOW_DAYS, type StockStatus, type WarehouseRow } from "../../lager/_lib/types";
import { AWISH_REFILL_NOTE_PREFIX } from "@/server/awish/refill-deduction";

import {
  factLine,
  needAction,
  stepsText,
  toMystery,
  type NeedAction,
  type ToMystery,
} from "./steps";

/** Notering som register_refill sätter på uttaget ur centrallagret. */
const MANUAL_REFILL_NOTE_PREFIX = "Uttag till påfyllning av ";
/** Notering när register_refill lägger tillbaka ett Awish-uttag (påfyllning utan uttag). */
const RETURNED_NOTE_PREFIX = "Återfört Awish-uttag ";
/** Mystery packs: pack_mystery och undo_mystery_packing (20261115000000_mystery_packs.sql). */
const PACKED_NOTE_PREFIX = "Packat ";
const UNPACKED_NOTE_PREFIX = "Ångrat: Packat ";

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
  readonly titles: readonly {
    readonly id: string;
    readonly name: string;
    /** Egen produkt: vi packar den själva ("Packa" i stället för "Beställ"). */
    readonly ownProduct?: boolean;
    /** Mystery pack: pack per omgång. Då skrivs antalet i hela omgångar. */
    readonly mysteryBatchSize?: number | null;
  }[];
  /** Antal automater (1 = "i automaten" i raden under titeln). Utelämnat = flera. */
  readonly machineCount?: number;
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
  /** Titlar som gått ur alla automater (Utgår på Lager). Utelämnat = inga. */
  readonly retired?: ReadonlySet<string>;
  /**
   * Antal att köpa in eller packa per titel ur Inköps plan (purchaseQtyByTitle), samma
   * siffra som på /prognos. Saknas titeln är antalet 0. null/utelämnat = planen kunde inte
   * räknas: titlar som tar slut visas utan antal.
   */
  readonly purchase?: ReadonlyMap<string, number> | null;
  /**
   * Delar i mystery packs: pack av titeln som går åt till omgångarna som ska packas
   * (PurchaseLine.mysteryNeed i inköpsplanen). Ingår redan i `purchase`.
   */
  readonly mysteryNeed?: ReadonlyMap<
    string,
    { readonly packs: number; readonly parts: readonly { readonly titleId: string }[] }
  > | null;
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
  /** Hela dagar hemmalagret räcker (Lagers modell, styr status), eller null. */
  readonly daysLeft: number | null;
  /** Räcker på sidan (`lastsDays`): hemma + i automaterna vid 14 dagars takt, eller null. */
  readonly lastsDays: number | null;
  /** Gått ur alla automater: ligger still hemma, köps inte in. */
  readonly retired: boolean;
  readonly status: StockStatus;
  /** Räcker kortare än WAREHOUSE_LOW_DAYS eller behövs och är slut. */
  readonly runsOut: boolean;
  /** Saldot är under 0: något har inte registrerats. Visas som "Räkna om". */
  readonly negative: boolean;
  readonly unitCostOre: number | null;
  readonly valueOre: number | null;
  readonly latest: LatestChange | null;
  /** Egen produkt: vi packar den själva. */
  readonly own: boolean;
  /**
   * Pack att packa eller beställa: Inköps antal (purchaseQty), 0 när inget behövs, null
   * när planen saknas.
   */
  readonly needQty: number | null;
  /**
   * Det som ska packas eller beställas (samma regel som Inköp, ./steps.ts): mystery packs i
   * hela omgångar. null = inget behövs.
   */
  readonly action: NeedAction | null;
  /** "0 hemma · 9 i automaten · slut om 3 dagar" (samma rad som på Inköp). */
  readonly fact: string;
  /** Delen av inköpet som mystery packen äter upp ("16 av dem går till Mystery Pack."). */
  readonly toMystery: ToMystery | null;
}

/**
 * Räcker, samma regel på Vårt lager och Inköp: hela dagar tills `packs` (hemma + i
 * automaterna) är sålda vid takten `perDayTenths` (tiondelar pack per dag, de senaste 14
 * hela dagarna i alla automater). null utan takt. Ren.
 */
export function lastsDays(packs: number, perDayTenths: number | null): number | null {
  if (perDayTenths === null || perDayTenths <= 0) return null;
  return Math.floor((Math.max(0, packs) * 10) / perDayTenths);
}

/** En rad i listan "Att göra" överst på Vårt lager. */
export interface StockTodo {
  readonly titleId: string;
  readonly verb: "Räkna om" | "Packa" | "Beställ";
  readonly title: string;
  /**
   * Antalet på kortet: omgångar för mystery packs, annars pack. null för Räkna om och när
   * antalet är okänt.
   */
  readonly qty: number | null;
  /** Enheten efter antalet: "st", "omgång" eller "omgångar". */
  readonly unit: string;
  /** Samma sak i pack (för länken till Mystery packs), eller null. */
  readonly packs: number | null;
  /** Under 0 och ska fyllas på: "1. Räkna om. 2. Packa 2 omgångar." Annars null. */
  readonly steps: string | null;
  /** "0 hemma · 9 i automaten · slut om 3 dagar" */
  readonly fact: string;
  readonly tone: "critical" | "warning";
}

/** Ska packas eller beställas: Inköps antal är över 0 (utan plan: titeln tar slut). */
export function needsPurchase(
  r: Pick<VartLagerRow, "retired" | "needQty" | "runsOut"> &
    Partial<Pick<VartLagerRow, "toMystery">>,
): boolean {
  // Utgången titel köps inte, utom det som mystery packen behöver av den.
  if (r.retired && !r.toMystery) return false;
  return r.needQty === null ? r.runsOut : r.needQty > 0;
}

/**
 * Vad som ska göras i vårt lager, viktigast först: saldon under 0 (räkna om), titlar som
 * är slut och sedan de som ska packas eller beställas (samma titlar och antal som Inköp).
 * Egna produkter packas, övriga beställs. Ren.
 */
export function stockTodos(rows: readonly VartLagerRow[]): StockTodo[] {
  const rank = (r: VartLagerRow) => (r.negative ? 0 : r.home <= 0 ? 1 : 2);
  return rows
    .filter((r) => r.negative || needsPurchase(r))
    .sort(
      (a, b) =>
        rank(a) - rank(b) ||
        (a.daysLeft ?? -1) - (b.daysLeft ?? -1) ||
        a.name.localeCompare(b.name, "sv"),
    )
    .map((r) =>
      r.negative
        ? {
            titleId: r.titleId,
            verb: "Räkna om",
            title: r.name,
            qty: null,
            unit: "st",
            packs: null,
            // Under 0 och ska fyllas på: båda stegen, samma text som på Inköp.
            steps: stepsText(true, r.action),
            fact: r.fact,
            tone: "critical",
          }
        : {
            titleId: r.titleId,
            verb: r.own ? "Packa" : "Beställ",
            title: r.name,
            qty: r.action?.qty ?? null,
            unit: r.action?.unit ?? "st",
            packs: r.action?.packs ?? null,
            // En del i mystery packs: "16 av dem går till Mystery Pack."
            steps: r.toMystery?.text ?? null,
            fact: r.fact,
            tone: r.home <= 0 ? "critical" : "warning",
          },
    );
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
    /** Titlar som gått ur automaterna men ligger hemma: antal titlar, pack och värde. */
    readonly idle: { readonly titles: number; readonly packs: number; readonly valueOre: number };
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
  if (e.kind === "adjustment" && note.startsWith(PACKED_NOTE_PREFIX)) {
    return { text: `${signed(e.quantity)} packat`, when, delta: e.quantity, automatic: false };
  }
  if (e.kind === "adjustment" && note.startsWith(UNPACKED_NOTE_PREFIX)) {
    return {
      text: `${signed(e.quantity)} ångrad packning`,
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
  const retiredSet = input.retired ?? new Set<string>();
  const names = new Map(input.titles.map((t) => [t.id, t.name]));
  const titleName = (id: string) => names.get(id) ?? "mystery packs";
  const rows: VartLagerRow[] = [...input.titles]
    .sort(
      (a, b) => Number(retiredSet.has(a.id)) - Number(retiredSet.has(b.id)) || sv(a.name, b.name),
    )
    .map((t) => {
      const r = wh.get(t.id);
      const retired = retiredSet.has(t.id);
      const home = r?.onHand ?? input.home.get(t.id) ?? 0;
      const inMachines = Math.max(0, input.inMachines.get(t.id) ?? 0);
      const sold7 = input.sold7.get(t.id) ?? 0;
      // Utan rad i Lagers modell (inget i lagret och inget behov i veckan): slut om den säljer.
      // Utgången titel: ingen status (den ska inte köpas in eller packas).
      const status: StockStatus = retired
        ? "ok"
        : r
          ? r.status
          : home <= 0 && sold7 > 0
            ? "critical"
            : "ok";
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
      // Under "Alla": senaste händelsen i ett lager som har titeln. "räknat 0 i Kontoret" på
      // en titel med 180 hemma läses som "vi har 0"; lager utan pack hoppas då över.
      const holding = events.filter(
        (x) => (byPlace[x.locationId ?? defaultPlace?.id ?? ""] ?? 0) > 0,
      );
      if (multi && holding.length > 0) {
        e = holding.reduce((a, b) => (b.occurredAt > a.occurredAt ? b : a));
      }
      const eAt = e ? (e.locationId ?? defaultPlace?.id) : undefined;
      const runsOut = status !== "ok";
      const lasts =
        retired || sold7 <= 0 ? null : lastsDays(home + inMachines, r?.perDayTenths ?? null);
      // Inköps antal (samma regel och siffra som /prognos); utgången titel köps inte.
      // En utgången titel kan ändå vara en del i ett mystery pack: då gäller planens antal.
      const mysteryNeed = input.mysteryNeed?.get(t.id) ?? null;
      const planQty = input.purchase ? (input.purchase.get(t.id) ?? 0) : null;
      const needQty = retired && !mysteryNeed ? 0 : planQty;
      const own = t.ownProduct === true;
      const share = own ? null : toMystery(needQty, mysteryNeed, titleName);
      return {
        titleId: t.id,
        name: t.name,
        home,
        byPlace,
        latestByPlace,
        inMachines,
        sold7,
        daysLeft,
        lastsDays: lasts,
        retired,
        status,
        runsOut,
        negative: home < 0,
        own,
        needQty,
        toMystery: share,
        action: needsPurchase({ retired, needQty, runsOut, toMystery: share })
          ? needAction({ own, needQty, mysteryBatchSize: t.mysteryBatchSize, home })
          : null,
        fact: factLine({
          home,
          inMachines,
          lastsDays: lasts,
          ...(input.machineCount === undefined ? {} : { machineCount: input.machineCount }),
        }),
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
      idle: {
        titles: rows.filter((r) => r.retired && r.home > 0).length,
        packs: rows.reduce((s, r) => s + (r.retired ? Math.max(0, r.home) : 0), 0),
        valueOre: rows.reduce((s, r) => s + (r.retired ? (r.valueOre ?? 0) : 0), 0),
      },
    },
    places,
    lowDays: WAREHOUSE_LOW_DAYS,
    canEdit: input.canEdit,
  };
}

/** "12 d" · "slut" · "utgår" · "–" (Räcker, se `lastsDays`). */
export function lastsText(
  r: Pick<VartLagerRow, "home" | "inMachines" | "lastsDays" | "sold7" | "retired">,
): string {
  if (r.retired) return "utgår";
  if (r.home + r.inMachines <= 0) return r.sold7 > 0 ? "slut" : "–";
  if (r.lastsDays === null) return "–";
  if (r.lastsDays === 0) return `<${NBSP}1${NBSP}d`;
  return `${formatInt(r.lastsDays)}${NBSP}d`;
}

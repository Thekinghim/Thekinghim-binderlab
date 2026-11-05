/**
 * Deterministisk generator av demons försäljning, lager och inköp.
 *
 * Simuleringen går dag för dag genom perioden (svensk tid):
 *
 * 1. Morgon: leveranser till centrallagret (inköpsorder som kommer i dag).
 * 2. Måndagar: inköpsrutinen beställer det som behövs för täckningen
 *    (takten de senaste 21 dagarna × ledtid + 21 dagar, i hela lådor).
 *    Förhandsbeställningar till släppen läggs fyra veckor före släppdagen.
 * 3. Påfyllning: varje automat på sina veckodagar, upp till kapaciteten,
 *    så långt centrallagret räcker. Första besöket varje månad inventeras
 *    automaten (och ibland kasseras ett skadat pack).
 * 4. Försäljning: antal köp per automat och dag är Poisson-fördelat kring en
 *    takt som beror på butik, veckodag, säsong, lov, tillväxt och nystart.
 *    Kunden väljer titel efter popularitet och släppkurva. Är titeln slut i
 *    automaten går halva efterfrågan förlorad och resten väljer något annat.
 *    Det är den förlorade försäljningen som panelen sedan visar.
 * 5. Kväll sista dagen i månaden: inventering av centrallagret.
 *
 * Slumpen är seedad (src/seed/random.ts). Flyttal används bara för takter
 * och vikter, aldrig för belopp: priserna är heltal i öre ur katalogen.
 * Inget beror på processens tidszon.
 */

import {
  addDays,
  dayOfWeek,
  daysBetween,
  eachDay,
  monthEnd,
  monthOf,
  monthsElapsed,
} from "@/domain/dates";
import type { IsoDate } from "@/domain/types";

import { stockholmToUtcMs, type SeedOrder } from "../orders";
import { createRandom, type Random } from "../random";
import { demoCatalog, type DemoCatalog } from "./calendar";
import {
  DEMO_FIRST_AWISH_ID,
  DEMO_FIRST_ORDER_NO,
  DEMO_PAYMENT_METHODS,
  DEMO_PURCHASING,
  DEMO_RANDOM_SEED,
  DEMO_STORES,
  DEMO_SUPPLIERS,
  type DemoMachine,
  type DemoPlacement,
  type DemoTitle,
  type StoreKey,
  type SupplierKey,
} from "./catalog";

export interface DemoOptions {
  /** Skala på efterfrågan och kapacitet (1 = vanlig demo, DEMO_LARGE_SCALE = --stor). */
  scale?: number;
  seed?: number;
  /** Katalogen för demons "nu" (calendar.ts). Standard: originalet, 2 nov 2026 kl. 12. */
  catalog?: DemoCatalog;
}

export type DemoActor = "owner" | "refiller";

export type DemoLocation = { kind: "warehouse" } | { kind: "machine"; code: string };

export interface DemoStockEvent {
  location: DemoLocation;
  title: string;
  kind: "count" | "refill" | "adjustment" | "waste" | "receipt";
  /** Förändring, eller räknat antal vid `count`. */
  quantity: number;
  occurredAtMs: number;
  note: string;
  /** Vem som utför händelsen: påfyllaren i automaterna, ägaren i centrallagret. */
  actor: DemoActor;
}

export interface DemoPurchaseOrder {
  /** Stabil nyckel, t.ex. "IO-2026-0007". Sparas i noteringen. */
  key: string;
  supplier: SupplierKey;
  orderedOn: IsoDate;
  expectedOn: IsoDate;
  /** Null = inte levererad i perioden. */
  receivedOn: IsoDate | null;
  status: "draft" | "ordered" | "received";
  lines: { title: string; quantity: number; unitCostOre: number }[];
  note: string;
}

export interface DemoLostSale {
  machineCode: string;
  title: string;
  date: IsoDate;
}

export interface DemoGeneration {
  scale: number;
  orders: SeedOrder[];
  stockEvents: DemoStockEvent[];
  purchaseOrders: DemoPurchaseOrder[];
  lostSales: DemoLostSale[];
  /** Automatdagar då en titel i sortimentet var slut när butiken öppnade. */
  stockoutDays: number;
  /** Saldo i slutet: automat|titel → antal, och centrallagret per titel. */
  machineLevels: Map<string, number>;
  warehouseLevels: Map<string, number>;
}

/** Vikt per veckodag (1 = måndag … 7 = söndag), i procent. */
const WEEKDAY: Readonly<Record<number, number>> = {
  1: 80,
  2: 78,
  3: 88,
  4: 95,
  5: 120,
  6: 150,
  7: 115,
};

/** Säsong per månad, i procent. */
const SEASON: Readonly<Record<string, number>> = {
  "02": 88,
  "03": 92,
  "04": 96,
  "05": 90,
  "06": 86,
  "07": 80,
  "08": 92,
  "09": 104,
  "10": 112,
  "11": 110,
};

/** Lov och helger 2026: faktor i procent. */
const HOLIDAYS: readonly { from: IsoDate; to: IsoDate; pct: number; label: string }[] = [
  { from: "2026-02-23", to: "2026-03-01", pct: 125, label: "Sportlov" },
  { from: "2026-04-03", to: "2026-04-12", pct: 120, label: "Påsklov" },
  { from: "2026-05-14", to: "2026-05-14", pct: 115, label: "Kristi himmelsfärd" },
  { from: "2026-06-19", to: "2026-06-19", pct: 40, label: "Midsommarafton" },
  { from: "2026-06-20", to: "2026-06-20", pct: 70, label: "Midsommardagen" },
  { from: "2026-06-11", to: "2026-08-18", pct: 105, label: "Sommarlov" },
  { from: "2026-10-26", to: "2026-11-01", pct: 135, label: "Höstlov" },
];

/** Dagar med nystartsrabatt i takten (automaten blir känd i butiken). */
const RAMP_DAYS = 14;
/** Andel av kunderna som går när titeln är slut (resten väljer annat), i procent. */
const LOST_SHARE_PCT = 50;
/** Klockslag (svensk tid) för händelser i centrallagret. */
const RECEIPT_TIME = "07:00:00";
const WITHDRAW_TIME = "07:30:00";
const WAREHOUSE_COUNT_TIME = "17:30:00";

const pairKey = (code: string, title: string): string => `${code}|${title}`;

function holidayPct(date: IsoDate): number {
  let pct = 100;
  for (const h of HOLIDAYS) {
    if (date >= h.from && date <= h.to) {
      pct = (pct * h.pct) / 100;
    }
  }
  return pct;
}

function placementOn(machine: DemoMachine, date: IsoDate): DemoPlacement | null {
  for (const p of machine.placements) {
    if (date >= p.validFrom && (p.validTo === null || date <= p.validTo)) {
      return p;
    }
  }
  return null;
}

function storeOf(key: StoreKey) {
  const store = DEMO_STORES.find((s) => s.key === key);
  if (!store) {
    throw new Error(`Butiken ${key} saknas.`);
  }
  return store;
}

/** Försäljningspriset (öre) som gäller dagen. */
export function salePriceOn(title: DemoTitle, date: IsoDate): number {
  let price: number | null = null;
  for (const p of title.salePrices) {
    if (p.validFrom <= date) {
      price = p.ore;
    }
  }
  if (price === null) {
    throw new Error(`${title.name} har inget pris ${date}.`);
  }
  return price;
}

/** Inköpspriset (öre) som gäller dagen, eller 0 om titeln saknar pris (inköpet görs ändå). */
function purchasePriceOn(title: DemoTitle, date: IsoDate): number {
  let price = 0;
  for (const p of title.purchasePrices) {
    if (p.validFrom <= date) {
      price = p.unitCostOre;
    }
  }
  return price || (title.purchasePrices[0]?.unitCostOre ?? 0);
}

/** Popularitet just den dagen (släppkurvan ovanpå grundvikten). */
function demandWeight(title: DemoTitle, date: IsoDate): number {
  const age = daysBetween(title.availableFrom, date);
  if (age < 0) {
    return 0;
  }
  const boost = title.release ? title.release.peak * Math.exp(-age / title.release.tauDays) : 0;
  return title.popularity * (1 + boost);
}

function isSellable(title: DemoTitle, date: IsoDate): boolean {
  return date >= title.availableFrom;
}

function isRefillable(title: DemoTitle, date: IsoDate): boolean {
  return date >= title.availableFrom && (title.lastRefill === null || date <= title.lastRefill);
}

function uniform(rng: Random): number {
  return rng.nextUint32() / 0x1_0000_0000;
}

/** Poisson-fördelat antal (Knuth för små takter, normalapproximation för stora). */
function poisson(rng: Random, lambda: number): number {
  if (lambda <= 0) {
    return 0;
  }
  if (lambda < 40) {
    const limit = Math.exp(-lambda);
    let k = 0;
    let p = 1;
    for (;;) {
      p *= uniform(rng);
      if (p <= limit) {
        return k;
      }
      k++;
    }
  }
  const u1 = Math.max(uniform(rng), 1e-12);
  const u2 = uniform(rng);
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return Math.max(0, Math.round(lambda + Math.sqrt(lambda) * z));
}

/** Timvikter: eftermiddag efter skolan, mitt på dagen på helger, kvällar på nöjesställen. */
function hourWeight(hour: number, weekend: boolean): number {
  let w = 5;
  if (hour >= 15 && hour <= 18) w += 8;
  if (weekend && hour >= 11 && hour <= 16) w += 7;
  if (hour >= 19) w += 3;
  if (hour < 10) w -= 3;
  return Math.max(1, w);
}

/** Svensk lokal tid → UTC-ms, snabbt: en uppslagning per dag (klockan 12) plus sekunder. */
class DayClock {
  private readonly noon = new Map<IsoDate, number>();
  at(date: IsoDate, secondOfDay: number): number {
    let base = this.noon.get(date);
    if (base === undefined) {
      base = stockholmToUtcMs(date, "12:00:00");
      this.noon.set(date, base);
    }
    // Sommartidsskiftet sker kl. 02–03; alla tider här ligger efter 03:00.
    return base + (secondOfDay - 12 * 3600) * 1000;
  }
  atTime(date: IsoDate, time: string): number {
    const [h = "0", m = "0", s = "0"] = time.split(":");
    return this.at(date, Number(h) * 3600 + Number(m) * 60 + Number(s));
  }
}

function clockText(secondOfDay: number): string {
  const h = Math.floor(secondOfDay / 3600);
  const m = Math.floor((secondOfDay % 3600) / 60);
  const s = secondOfDay % 60;
  return [h, m, s].map((n) => String(n).padStart(2, "0")).join(":");
}

interface PendingOrder {
  machineIndex: number;
  title: string;
  amountOre: number;
  paidAtMs: number;
  createdAtMs: number;
  businessDate: IsoDate;
  stockholmTime: string;
  paymentMethod: string;
}

/** Genererar hela demon. Samma alternativ ger alltid samma resultat. */
export function generateDemo(options: DemoOptions = {}): DemoGeneration {
  const scale = options.scale ?? 1;
  if (!(scale > 0) || !Number.isFinite(scale)) {
    throw new RangeError("Skalan måste vara > 0.");
  }
  const cat = options.catalog ?? demoCatalog();
  const DEMO_PERIOD = cat.period;
  const DEMO_TITLES = cat.titles;
  const DEMO_MACHINES = cat.machines;
  const DEMO_BACKORDER = cat.backorder;
  const rng = createRandom(options.seed ?? DEMO_RANDOM_SEED);
  const clock = new DayClock();
  const days = eachDay(DEMO_PERIOD.start, DEMO_PERIOD.end);
  const lastDay = DEMO_PERIOD.end;
  const titleByName = new Map(DEMO_TITLES.map((t) => [t.name, t]));
  const methodWeights = DEMO_PAYMENT_METHODS.map((m) => m.weight);

  const capacity = (machine: DemoMachine, title: DemoTitle): number =>
    Math.max(1, Math.round(title.slots * machine.packsPerSlot * scale));

  const machineLevel = new Map<string, number>();
  const stocked = new Set<string>();
  const warehouse = new Map<string, number>();
  const stockEvents: DemoStockEvent[] = [];
  const lostSales: DemoLostSale[] = [];
  const pending: PendingOrder[] = [];
  const purchaseOrders: DemoPurchaseOrder[] = [];
  /** Sålda pack per titel och dagindex (för inköpsrutinens takt). */
  const soldByTitle = new Map<string, number[]>();
  const countedMonth = new Map<string, string>();
  let stockoutDays = 0;

  // Centrallagret vid start: ungefär sex veckors försäljning, i hela lådor.
  const startCountMs = clock.atTime(addDays(DEMO_PERIOD.start, -1), WAREHOUSE_COUNT_TIME);
  for (const title of DEMO_TITLES) {
    if (title.availableFrom > DEMO_PERIOD.start) {
      continue;
    }
    const boxes = Math.max(1, Math.ceil((title.popularity * scale) / 30));
    const quantity = boxes * title.boxSize;
    warehouse.set(title.name, quantity);
    stockEvents.push({
      location: { kind: "warehouse" },
      title: title.name,
      kind: "count",
      quantity,
      occurredAtMs: startCountMs,
      note: "Inventering av centrallagret före start",
      actor: "owner",
    });
  }

  let poNumber = 0;
  const nextPoKey = (): string =>
    `${cat.purchaseOrderPrefix}${String(++poNumber).padStart(4, "0")}`;
  const inTransit = (title: string): number =>
    purchaseOrders
      .filter((po) => po.status !== "received")
      .reduce(
        (n, po) =>
          n + po.lines.filter((l) => l.title === title).reduce((a, l) => a + l.quantity, 0),
        0,
      );

  const placeOrder = (
    supplier: SupplierKey,
    date: IsoDate,
    lines: DemoPurchaseOrder["lines"],
    expectedOn: IsoDate,
    note: string,
  ): void => {
    if (lines.length === 0) {
      return;
    }
    purchaseOrders.push({
      key: nextPoKey(),
      supplier,
      orderedOn: date,
      expectedOn,
      receivedOn: null,
      status: date === lastDay ? "draft" : "ordered",
      lines,
      note,
    });
  };

  days.forEach((date, dayIndex) => {
    const weekday = dayOfWeek(date);
    const month = monthOf(date);

    // 1. Leveranser.
    for (const po of purchaseOrders) {
      if (po.status === "ordered" && po.expectedOn === date) {
        po.status = "received";
        po.receivedOn = date;
        const ms = clock.atTime(date, RECEIPT_TIME);
        for (const line of po.lines) {
          warehouse.set(line.title, (warehouse.get(line.title) ?? 0) + line.quantity);
          stockEvents.push({
            location: { kind: "warehouse" },
            title: line.title,
            kind: "receipt",
            quantity: line.quantity,
            occurredAtMs: ms,
            note: `Inleverans ${po.key}`,
            actor: "owner",
          });
        }
      }
    }

    // 2. Inköp: förhandsbeställningar och måndagsrutinen.
    for (const title of DEMO_TITLES) {
      if (title.preorderPacks && daysBetween(date, title.availableFrom) === 28) {
        const quantity = Math.ceil((title.preorderPacks * scale) / title.boxSize) * title.boxSize;
        placeOrder(
          title.supplier,
          date,
          [
            {
              title: title.name,
              quantity,
              unitCostOre: purchasePriceOn(title, title.availableFrom),
            },
          ],
          addDays(title.availableFrom, -1),
          `Förhandsbeställning ${title.name} (släpp ${title.availableFrom})`,
        );
      }
    }
    if (weekday === DEMO_PURCHASING.weekday && dayIndex >= 7) {
      for (const supplier of DEMO_SUPPLIERS) {
        const lines: DemoPurchaseOrder["lines"] = [];
        let backordered = false;
        for (const title of DEMO_TITLES) {
          if (title.supplier !== supplier.key || !isRefillable(title, date)) {
            continue;
          }
          if (title.lastRefill !== null && daysBetween(date, title.lastRefill) < 28) {
            continue;
          }
          const sold = soldByTitle.get(title.name) ?? [];
          const window = Math.min(
            DEMO_PURCHASING.rateWindowDays,
            daysBetween(title.availableFrom, date),
          );
          if (window < 7) {
            continue;
          }
          let recent = 0;
          for (let i = dayIndex - window; i < dayIndex; i++) {
            recent += sold[i] ?? 0;
          }
          const rate = recent / window;
          const need =
            rate * (supplier.leadTimeDays + DEMO_PURCHASING.coverDays) -
            (warehouse.get(title.name) ?? 0) -
            inTransit(title.name);
          if (need <= 0) {
            continue;
          }
          const quantity = Math.ceil(need / title.boxSize) * title.boxSize;
          lines.push({ title: title.name, quantity, unitCostOre: purchasePriceOn(title, date) });
          if (
            title.name === DEMO_BACKORDER.title &&
            date >= DEMO_BACKORDER.orderedFrom &&
            date <= DEMO_BACKORDER.orderedTo
          ) {
            backordered = true;
          }
        }
        if (backordered) {
          // Restnoterad titel: egen order som levereras sent; resten som vanligt.
          const rest = lines.filter((l) => l.title !== DEMO_BACKORDER.title);
          const late = lines.filter((l) => l.title === DEMO_BACKORDER.title);
          placeOrder(
            supplier.key,
            date,
            rest,
            addDays(date, supplier.leadTimeDays),
            "Veckobeställning",
          );
          placeOrder(
            supplier.key,
            date,
            late,
            DEMO_BACKORDER.deliveredOn,
            `Restnoterad hos leverantören, levereras ${DEMO_BACKORDER.deliveredOn}`,
          );
        } else {
          placeOrder(
            supplier.key,
            date,
            lines,
            addDays(date, supplier.leadTimeDays),
            "Veckobeställning",
          );
        }
      }
    }

    // 3. Påfyllning.
    const withdrawn = new Map<string, { quantity: number; codes: string[] }>();
    for (const machine of DEMO_MACHINES) {
      const placement = placementOn(machine, date);
      const faulty = machine.faultFrom !== undefined && date >= machine.faultFrom;
      if (!placement || faulty) {
        continue;
      }
      const firstDay = date === machine.activeFrom;
      if (!firstDay && !machine.refillWeekdays.includes(weekday)) {
        continue;
      }
      const refillMs = clock.atTime(date, machine.refillTime);
      // Första besöket i månaden: inventering (och ibland ett kasserat pack).
      const inventory = countedMonth.get(machine.code) !== month && !firstDay;
      if (inventory) {
        countedMonth.set(machine.code, month);
      } else if (firstDay) {
        countedMonth.set(machine.code, month);
      }
      for (const title of DEMO_TITLES) {
        const key = pairKey(machine.code, title.name);
        const level = machineLevel.get(key) ?? 0;
        if (inventory && stocked.has(key)) {
          let counted = level;
          if (counted > 0 && rng.int(100) < 3) {
            counted -= 1;
            stockEvents.push({
              location: { kind: "machine", code: machine.code },
              title: title.name,
              kind: "waste",
              quantity: -1,
              occurredAtMs: refillMs - 180_000,
              note: "Skadat pack kasserat vid inventering",
              actor: "refiller",
            });
          }
          stockEvents.push({
            location: { kind: "machine", code: machine.code },
            title: title.name,
            kind: "count",
            quantity: counted,
            occurredAtMs: refillMs - 120_000,
            note: "Inventering vid månadens första påfyllning",
            actor: "refiller",
          });
          machineLevel.set(key, counted);
        }
        if (!isRefillable(title, date)) {
          continue;
        }
        if (!stocked.has(key)) {
          stocked.add(key);
          stockEvents.push({
            location: { kind: "machine", code: machine.code },
            title: title.name,
            kind: "count",
            quantity: 0,
            occurredAtMs: refillMs - 60_000,
            note: firstDay ? "Inventering vid start" : "Ny plats i automaten",
            actor: "refiller",
          });
        }
        const current = machineLevel.get(key) ?? 0;
        const available = warehouse.get(title.name) ?? 0;
        const quantity = Math.min(capacity(machine, title) - current, available);
        if (quantity <= 0) {
          continue;
        }
        machineLevel.set(key, current + quantity);
        warehouse.set(title.name, available - quantity);
        const w = withdrawn.get(title.name) ?? { quantity: 0, codes: [] };
        w.quantity += quantity;
        w.codes.push(machine.code);
        withdrawn.set(title.name, w);
        stockEvents.push({
          location: { kind: "machine", code: machine.code },
          title: title.name,
          kind: "refill",
          quantity,
          occurredAtMs: refillMs,
          note: "Påfyllning",
          actor: "refiller",
        });
      }
    }
    const withdrawMs = clock.atTime(date, WITHDRAW_TIME);
    for (const [title, w] of withdrawn) {
      stockEvents.push({
        location: { kind: "warehouse" },
        title,
        kind: "adjustment",
        quantity: -w.quantity,
        occurredAtMs: withdrawMs,
        note: `Uttag till påfyllning: ${w.codes.join(", ")}`,
        actor: "owner",
      });
    }

    // 4. Försäljning.
    const growth = 1 + 0.02 * monthsElapsed(DEMO_PERIOD.start, date);
    // Veckodagen ur det verkliga datumet, säsong och lov ur berättelsens (calendar.ts).
    const story = cat.storyDate(date);
    const dayPct =
      (WEEKDAY[weekday] ?? 100) * (SEASON[story.slice(5, 7)] ?? 100) * holidayPct(story);
    const weekend = weekday >= 6;
    DEMO_MACHINES.forEach((machine, machineIndex) => {
      const placement = placementOn(machine, date);
      if (!placement || (machine.faultFrom !== undefined && date >= machine.faultFrom)) {
        return;
      }
      const store = storeOf(placement.storeKey);
      const age = daysBetween(placement.validFrom, date);
      const ramp = age < RAMP_DAYS ? 0.6 + (0.4 * age) / RAMP_DAYS : 1;
      const lambda = (placement.baseRate * dayPct * growth * ramp * scale) / 1_000_000;

      // Sortimentet: titlar som får säljas och antingen fylls på eller finns kvar.
      const assortment = DEMO_TITLES.filter((t) => {
        if (!isSellable(t, date)) return false;
        const key = pairKey(machine.code, t.name);
        return isRefillable(t, date) || (machineLevel.get(key) ?? 0) > 0;
      });
      for (const t of assortment) {
        if (
          (machineLevel.get(pairKey(machine.code, t.name)) ?? 0) === 0 &&
          stocked.has(pairKey(machine.code, t.name))
        ) {
          stockoutDays++;
        }
      }
      const weights = assortment.map((t) => Math.max(1, Math.round(demandWeight(t, date) * 10)));

      const hours: number[] = [];
      for (let h = store.hours.first; h <= store.hours.last; h++) hours.push(h);
      const hourWeights = hours.map((h) => hourWeight(h, weekend));
      const count = poisson(rng, lambda);
      const seconds: number[] = [];
      for (let i = 0; i < count; i++) {
        const hour = hours[rng.weighted(hourWeights)] ?? store.hours.first;
        const second = hour * 3600 + rng.int(3600);
        if (date === lastDay && second >= cat.cutoffHour * 3600) {
          continue;
        }
        seconds.push(second);
      }
      seconds.sort((a, b) => a - b);

      for (const second of seconds) {
        if (assortment.length === 0) break;
        let pick = assortment[rng.weighted(weights)];
        if (!pick) continue;
        let key = pairKey(machine.code, pick.name);
        if ((machineLevel.get(key) ?? 0) <= 0) {
          lostSales.push({ machineCode: machine.code, title: pick.name, date });
          if (rng.int(100) < LOST_SHARE_PCT) {
            continue;
          }
          const inStock = assortment
            .map((t, i) => ({ t, w: weights[i] ?? 0 }))
            .filter((x) => (machineLevel.get(pairKey(machine.code, x.t.name)) ?? 0) > 0);
          if (inStock.length === 0) continue;
          pick = inStock[rng.weighted(inStock.map((x) => x.w))]?.t;
          if (!pick) continue;
          key = pairKey(machine.code, pick.name);
        }
        machineLevel.set(key, (machineLevel.get(key) ?? 0) - 1);
        const sold = soldByTitle.get(pick.name) ?? [];
        sold[dayIndex] = (sold[dayIndex] ?? 0) + 1;
        soldByTitle.set(pick.name, sold);
        const paidAtMs = clock.at(date, second);
        const method = DEMO_PAYMENT_METHODS[rng.weighted(methodWeights)];
        pending.push({
          machineIndex,
          title: pick.name,
          amountOre: salePriceOn(pick, date),
          paidAtMs,
          createdAtMs: paidAtMs - rng.between(6, 45) * 1000,
          businessDate: date,
          stockholmTime: `${date} ${clockText(second)}`,
          paymentMethod: method?.name ?? "Card",
        });
      }
    });

    // 5. Inventering av centrallagret sista dagen i månaden.
    if (date === monthEnd(month) && date !== lastDay) {
      const ms = clock.atTime(date, WAREHOUSE_COUNT_TIME);
      for (const [title, quantity] of [...warehouse].sort((a, b) => a[0].localeCompare(b[0]))) {
        stockEvents.push({
          location: { kind: "warehouse" },
          title,
          kind: "count",
          quantity,
          occurredAtMs: ms,
          note: "Månadsinventering av centrallagret",
          actor: "owner",
        });
      }
    }
  });

  // Ordernummer i tidsordning.
  pending.sort((a, b) => a.paidAtMs - b.paidAtMs || a.machineIndex - b.machineIndex);
  const orders: SeedOrder[] = pending.map((p, i) => {
    const machine = DEMO_MACHINES[p.machineIndex] as DemoMachine;
    return {
      externalId: String(DEMO_FIRST_ORDER_NO + i),
      awishId: DEMO_FIRST_AWISH_ID + i,
      title: p.title,
      amountOre: p.amountOre,
      machineCode: machine.code,
      awishMachine: machine.awishName,
      paymentMethod: p.paymentMethod,
      paidAtMs: p.paidAtMs,
      createdAtMs: p.createdAtMs,
      businessDate: p.businessDate,
      stockholmTime: p.stockholmTime,
    };
  });

  for (const title of titleByName.keys()) {
    if (!warehouse.has(title)) warehouse.set(title, 0);
  }
  stockEvents.sort((a, b) => a.occurredAtMs - b.occurredAtMs);

  return {
    scale,
    orders,
    stockEvents,
    purchaseOrders,
    lostSales,
    stockoutDays,
    machineLevels: machineLevel,
    warehouseLevels: warehouse,
  };
}

/** Orderna per månad ('ÅÅÅÅ-MM'), i tidsordning. Varje månad blir en Awish-export. */
export function ordersByMonth(orders: readonly SeedOrder[]): Map<string, SeedOrder[]> {
  const out = new Map<string, SeedOrder[]>();
  for (const o of orders) {
    const month = o.businessDate.slice(0, 7);
    const list = out.get(month) ?? [];
    list.push(o);
    out.set(month, list);
  }
  return out;
}

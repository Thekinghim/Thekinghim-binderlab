/**
 * Påfyllning: titel × automat där lagret räcker kortare tid än gränsen (standard 2,5 dagar)
 * vid snittförsäljningen de senaste 14 hela dagarna (t.o.m. i går).
 *
 *   takt          = sålda pack i fönstret / dagar i fönstret (kortas vid automatens startdag)
 *   räcker        = i lager / takt (dagar)
 *   flaggas när     i lager × dagar × 100 < gräns (hundradels dagar) × sålda pack
 *   kronor i risk = intäkt per dag × (7 − räcker), dvs. intäkt som uteblir de närmaste 7 dagarna
 *   nivå          = 'now' om lagret räcker mindre än 1 dag, eller (med `visitDue`, Att göra
 *                   och Hem) om besöksplanens "besök senast" (slutdatum − 1 dag) har
 *                   passerat; annars 'soon'
 *
 * Väntat slutdatum = i går + tak(räcker), domänens `stockoutDate` med asOf = i går.
 *
 * Titlar utan försäljning i fönstret flaggas inte (takten är 0), utom ett tomt fack för en
 * titel som har sålt i automaten tidigare: det är slut, som Akut på Lager. Dagens försäljning ingår
 * inte i takten (dagen är inte slut) men har redan dragits från lagret. En titel som har
 * gått ur sortimentet i automaten (`input.slotPeriods`, ./assortment.ts) fylls inte på och
 * flaggas inte, som på Lager och i besöksplanen.
 *
 * Larmgräns (`input.slotAlerts`, tabellen slot_alerts): saldo högst gränsen ger också en
 * punkt, med eller utan försäljning. Texten börjar då med "Saldo 3, larmgräns 4."
 *
 * Fullt fack (`StockLevelRef.capacity` känd och saldo ≥ kapacitet, isFullSlot): ingen punkt
 * alls, inte heller för larmgränsen. Det går inte att fylla på, som på Fyll på (där
 * raden i stället säger "Fullt · räcker ~2 d" och "Säljer fort – ge den ett fack till").
 * Så fort ett pack säljs är facket inte fullt längre och regeln ovan gäller igen.
 *
 * Mystery packs (`TitleRef.mysteryBatchSize`): facket fylls bara på när det är tomt, med en
 * hel omgång (oddsen gäller per omgång). Medan det har pack kvar blir det ingen punkt alls,
 * varken "snart slut", "fyll på" eller larmgränsen. Tomt (och har sålt här, eller har en
 * larmgräns): punkten "Mystery Pack Plus är slut i BL-001 – fyll på en hel omgång (14 st)",
 * nivå 'now'.
 */

import {
  addDays,
  mysteryBatch,
  mysteryEmptyText,
  dailyUnits,
  daysOfStockLeft,
  floorDiv,
  revenue,
  roundHalfUp,
  salesVelocity,
  stockoutDate,
  type IsoDate,
} from "@/domain";
import { sellOut, type WeekShare } from "@/analytics/sellout";
import { sellOutPhrase } from "@/analytics/sellout/text";
import { weekShapes } from "@/analytics/sellout/week-shape";
import { assortmentKey, retiredPairs, type SlotPeriod } from "./assortment";
import { evidence, isMachineActive, links, machineNames, titleNames } from "./common";
import { HORIZON_DAYS, sortTodos, urgencyOf, type TodoContext } from "./context";
import { day, kr, plural, ratioTenths, sentence, tenths } from "./text";
import type {
  AnalyticsOrder,
  MachineRef,
  SlotAlert,
  StockLevelRef,
  TitleRef,
  TodoItem,
  TodoLevel,
} from "./types";

/**
 * Fingerprint för en påfyllningspunkt: nivån, saldot och senaste registrerade påfyllning
 * (`lastRefilledAt`, bara påfyllning och flytt in, aldrig en inventering eller Awish-läsning).
 * "Klar" döljer alltså punkten bara tills läget ändras: ett pack till säljs (saldot ändras),
 * titeln blir akut eller tar slut (nivån) eller någon registrerar en påfyllning. En räkning
 * som inte ändrar saldot låter avbockningen stå kvar. Det är hellre en punkt för mycket än en
 * påfyllning som döljs medan automaten töms.
 */
export function refillFingerprint(
  level: TodoLevel,
  stock: Pick<StockLevelRef, "onHand" | "lastRefilledAt">,
): string {
  const refilled = stock.lastRefilledAt;
  const at = refilled !== undefined && refilled !== null && refilled !== "" ? refilled : "-";
  return `${level}|saldo:${Math.max(0, stock.onHand)}|påfyllt:${at}`;
}

/**
 * Besöksplanens marginal (`VISIT_DEFAULTS.bufferDays` i @/analytics/visits): besöket ska
 * göras senast dagen före väntat slutdatum. Samma tal här, så att en titel vars besök
 * besöksplanen säger är försenat står under "I dag".
 * refill.test.ts kontrollerar att talen är lika.
 */
export const VISIT_BUFFER_DAYS = 1;

/**
 * Fullt fack: kapaciteten är känd (> 0) och automaten har minst så många pack. Samma regel
 * som Fyll på (src/app/fyll-pa/_lib/model.ts isFull), Att göra, Hem, Lager och Drift.
 */
export function isFullSlot(onHand: number, capacity: number | null | undefined): boolean {
  return (
    capacity !== null &&
    capacity !== undefined &&
    Number.isFinite(capacity) &&
    capacity > 0 &&
    Math.max(0, onHand) >= capacity
  );
}

/**
 * Lägger fackens kapacitet (summerad per automat och titel) på lagerraderna. Rader utan
 * kapacitet får `capacity: null`.
 */
export function withCapacities<T extends StockLevelRef>(
  stock: readonly T[],
  capacities: readonly {
    readonly machineId: string;
    readonly titleId: string;
    readonly capacity: number;
  }[],
): T[] {
  const sum = new Map<string, number>();
  for (const c of capacities) {
    if (!Number.isSafeInteger(c.capacity) || c.capacity <= 0) continue;
    const k = assortmentKey(c.machineId, c.titleId);
    sum.set(k, (sum.get(k) ?? 0) + c.capacity);
  }
  return stock.map((s) => ({
    ...s,
    capacity: sum.get(assortmentKey(s.machineId, s.titleId)) ?? null,
  }));
}

/** Val för påfyllningsregeln. */
export interface RefillOptions {
  /**
   * Sant = en titel vars besök enligt besöksplanen är försenat (slutdatum −
   * VISIT_BUFFER_DAYS före i dag) får nivån 'now' och texten "Besöket är försenat (senast
   * 3 nov.)". Att göra, Hem och automatsidan använder det (computeTodos).
   */
  readonly visitDue?: boolean;
  /**
   * Veckans form per automat (sellout/week-shape). Utelämnad: räknas ur `input.orders`
   * (28 dagar t.o.m. i går; automater med för lite historik får platt snitt). Den som bara
   * har de senaste dagarnas order (Lager) skickar formerna från laddaren.
   */
  readonly weekShares?: ReadonlyMap<string, WeekShare>;
}

/** Påfyllningspunkter. */
export function refillTodos(ctx: TodoContext, opts: RefillOptions = {}): TodoItem[] {
  const { input, today, options } = ctx;
  const machines = new Map(input.machines.map((m) => [m.id, m]));
  const asOf = addDays(today, -1);
  const windowStart = addDays(asOf, -(options.refillWindowDays - 1));

  // Veckans form per automat: helgen säljer mer, så slutdagen räknas dag för dag (sellOut).
  const shapes =
    opts.weekShares ?? weekShapes(input.orders, { asOf, machines: input.machines });

  const byPair = new Map<string, AnalyticsOrder[]>();
  for (const o of input.orders) {
    if (o.machineId === null) continue;
    if (o.businessDate < windowStart || o.businessDate > asOf) continue;
    const k = `${o.machineId}\u0000${o.titleId}`;
    const list = byPair.get(k);
    if (list) list.push(o);
    else byPair.set(k, [o]);
  }

  const retired = retiredPairs(input.slotPeriods ?? [], today);
  const alerts = alertMap(input.slotAlerts ?? []);
  // Titel × automat som har sålt någon gång i indatat (inte bara i fönstret).
  const soldHere = new Set(
    input.orders.flatMap((o) =>
      o.machineId === null ? [] : [assortmentKey(o.machineId, o.titleId)],
    ),
  );
  const batches = mysteryBatches(input.titles);
  const out: TodoItem[] = [];
  for (const s of input.stock) {
    const machine = machines.get(s.machineId);
    if (!machine || !isMachineActive(machine, today)) continue;
    if (retired.has(assortmentKey(s.machineId, s.titleId))) continue;
    const orders = byPair.get(`${s.machineId}\u0000${s.titleId}`) ?? [];
    const v = salesVelocity(dailyUnits(orders), {
      asOf,
      days: options.refillWindowDays,
      ...(machine.activeFrom !== null ? { activeFrom: machine.activeFrom } : {}),
    });
    const onHand = Math.max(0, s.onHand);
    const batch = batches.get(s.titleId);
    if (batch !== undefined) {
      // Mystery pack: ingen punkt förrän facket är tomt, då en hel omgång.
      if (onHand > 0) continue;
      const alertAt = alerts.get(assortmentKey(s.machineId, s.titleId));
      if (
        v.units > 0 ||
        alertAt !== undefined ||
        soldHere.has(assortmentKey(s.machineId, s.titleId))
      ) {
        const windowOrders = orders.filter(
          (o) => o.businessDate >= v.start && o.businessDate <= v.end,
        );
        const revenueOre = v.units > 0 ? revenue(windowOrders, input.settings) : 0;
        const atStakeOre =
          v.days > 0 ? Math.max(0, roundHalfUp(revenueOre * HORIZON_DAYS, v.days)) : 0;
        out.push(
          mysteryTodo(s, batch, ctx.titleName(s.titleId), ctx.machineName(s.machineId), {
            atStakeOre: v.units > 0 ? atStakeOre : null,
            detail:
              v.units > 0
                ? ` Säljer i snitt ${ratioTenths(v.units, v.days)} pack per dag (${v.days} dagar t.o.m. ${day(asOf)}).`
                : "",
          }),
        );
      }
      continue;
    }
    // Fullt fack: inget att fylla på (Fyll på visar "Fullt · räcker ~N d").
    if (isFullSlot(onHand, s.capacity)) continue;
    const alertAt = alerts.get(assortmentKey(s.machineId, s.titleId));
    const underAlert = alertAt !== undefined && onHand <= alertAt;
    // EN slutdag för alla sidor: sellOut() från i går (dagens försäljning är inte klar),
    // med automatens veckoform när den finns.
    const so =
      v.units > 0 && v.days > 0
        ? sellOut({
            onHand,
            dailyAvg: v,
            from: asOf,
            weekShare: shapes.get(s.machineId) ?? null,
          })
        : null;
    const weekday = so !== null && so.basis === "weekday";
    const byRate =
      v.units > 0 &&
      v.days > 0 &&
      (onHand * v.days * 100 < options.refillThresholdCentidays * v.units ||
        // Helgen kan tömma facket fortare än snittet säger.
        (weekday && so.daysLeft * 100 < options.refillThresholdCentidays));
    if (!byRate) {
      if (underAlert) {
        out.push(alertTodo(s, alertAt, ctx.titleName(s.titleId), ctx.machineName(s.machineId)));
      } else if (onHand === 0 && soldHere.has(assortmentKey(s.machineId, s.titleId))) {
        // Slut och har sålt här tidigare (före fönstret): Lager visar Akut, så Att göra
        // säger detsamma, fast takten i fönstret är 0 (den är 0 för att facket är tomt).
        out.push(emptyTodo(s, ctx.titleName(s.titleId), ctx.machineName(s.machineId)));
      }
      continue;
    }

    const windowOrders = orders.filter((o) => o.businessDate >= v.start && o.businessDate <= v.end);
    const revenueOre = revenue(windowOrders, input.settings);
    const daysLeft = so?.daysLeft ?? daysOfStockLeft(onHand, v) ?? 0;
    const daysLeftTenths = floorDiv(onHand * v.days * 10, v.units);
    const lostDaysNumerator = HORIZON_DAYS * v.units - onHand * v.days; // (7 − räcker) × units
    const atStakeOre = Math.max(0, roundHalfUp(revenueOre * lostDaysNumerator, v.days * v.units));
    const empty = onHand === 0;
    // Domänens konvention: saldot räknas som saldot efter asOf (i går), så sista packet
    // säljs dag asOf + tak(räcker). 2,3 dagar räknat från i går kväll → slut 4 nov. om i dag är 2 nov.
    const outDate = so?.date ?? stockoutDate(asOf, onHand, v);
    // Besöksplanen: besök senast dagen före slutdatum. Har den dagen passerat är besöket
    // försenat, och då står punkten under "I dag" (Lager: "Besök senast 3 nov. (passerat)").
    const visitBy = outDate === null ? null : addDays(outDate, -VISIT_BUFFER_DAYS);
    const visitLate = opts.visitDue === true && visitBy !== null && visitBy < today;
    const level: TodoLevel =
      daysLeftTenths < 10 || (weekday && daysLeft < 1) || visitLate ? "now" : "soon";
    const titleName = ctx.titleName(s.titleId);
    const machineName = ctx.machineName(s.machineId);
    const perDay = ratioTenths(v.units, v.days);
    const revenuePerDay = kr(roundHalfUp(revenueOre, v.days));
    const visitText =
      visitLate && visitBy !== null ? ` Besöket är försenat (senast ${day(visitBy)}).` : "";

    const rateDetail = empty
      ? `Slut i lager. Säljer i snitt ${perDay} pack och ${revenuePerDay} per dag (${v.days} dagar t.o.m. ${day(asOf)}).`
      : weekday
        ? // Med veckoform stämmer inte "räcker ca N dagar" (snittet): dagen säger allt.
          `${plural(onHand, "pack", "pack")} kvar, säljer i snitt ${perDay} pack per dag ` +
          `(${v.days} dagar t.o.m. ${day(asOf)}). ${sentence(sellOutPhrase(outDate ?? today, today))} ` +
          `Räknat med vilka veckodagar automaten säljer mest.`
        : `${plural(onHand, "pack", "pack")} kvar räcker ca ${tenths(daysLeftTenths)} dagar vid ${perDay} pack per dag ` +
          `(${v.days} dagar t.o.m. ${day(asOf)}). ${sentence(sellOutPhrase(outDate ?? today, today))}`;
    const detail = `${underAlert ? `${alertText(onHand, alertAt)} ` : ""}${rateDetail}${visitText}`;

    out.push({
      key: `refill:${s.machineId}:${s.titleId}`,
      fingerprint: refillFingerprint(level, s),
      kind: "refill",
      level,
      urgency: urgencyOf(level, atStakeOre),
      atStakeOre,
      daysLeft,
      title: empty
        ? `${titleName} är slut i ${machineName}`
        : `Fyll på ${titleName} i ${machineName}`,
      detail,
      evidence: evidence({
        rule: `Lagret räcker under ${tenths(roundHalfUp(options.refillThresholdCentidays, 10))} dagar vid snittförsäljningen de senaste ${options.refillWindowDays} dagarna.`,
        period: { start: v.start, end: v.end },
        orderIds: windowOrders.map((o) => o.id),
        dates: windowOrders.map((o) => o.businessDate),
        titleIds: [s.titleId],
        machineIds: [s.machineId],
        figures: [
          { key: "onHand", label: "I lager", value: onHand, unit: "packs" },
          { key: "unitsInWindow", label: "Sålda pack i fönstret", value: v.units, unit: "packs" },
          { key: "windowDays", label: "Dagar i fönstret", value: v.days, unit: "days" },
          { key: "revenueInWindowOre", label: "Intäkt i fönstret", value: revenueOre, unit: "ore" },
          { key: "daysLeftTenths", label: "Räcker (dagar)", value: daysLeftTenths, unit: "tenths" },
          { key: "atStakeOre", label: "Intäkt i risk 7 dagar", value: atStakeOre, unit: "ore" },
        ],
      }),
      link: links.stock(s.machineId, s.titleId),
      action: {
        kind: "register-refill",
        label: "Registrera påfyllning",
        params: { machineId: s.machineId, titleId: s.titleId },
      },
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Mystery packs
// ---------------------------------------------------------------------------

/** Mystery packs: titelns id → pack per omgång. */
export function mysteryBatches(titles: readonly TitleRef[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const t of titles) {
    const b = mysteryBatch(t.mysteryBatchSize);
    if (b !== null) out.set(t.id, b);
  }
  return out;
}

/** Punkten för ett tomt mystery-fack: fyll på en hel omgång. */
function mysteryTodo(
  s: StockLevelRef,
  batch: number,
  titleName: string,
  machineName: string,
  extra: { readonly atStakeOre: number | null; readonly detail: string },
): TodoItem {
  return {
    key: `refill:${s.machineId}:${s.titleId}`,
    fingerprint: refillFingerprint("now", s),
    kind: "refill",
    level: "now",
    urgency: urgencyOf("now", extra.atStakeOre),
    atStakeOre: extra.atStakeOre,
    daysLeft: 0,
    title: mysteryEmptyText(titleName, batch, machineName),
    detail:
      `Mystery-facket är tomt. Det fylls bara på när det är tomt, med en hel omgång (${batch} pack), så att oddsen på etiketten stämmer.` +
      extra.detail,
    evidence: evidence({
      rule: "Mystery pack: facket fylls på först när det är tomt, med exakt en omgång.",
      titleIds: [s.titleId],
      machineIds: [s.machineId],
      figures: [
        { key: "onHand", label: "I lager", value: 0, unit: "packs" },
        { key: "batchSize", label: "Pack per omgång", value: batch, unit: "packs" },
      ],
    }),
    link: links.stock(s.machineId, s.titleId),
    action: {
      kind: "register-refill",
      label: "Registrera påfyllning",
      params: { machineId: s.machineId, titleId: s.titleId },
    },
  };
}

// ---------------------------------------------------------------------------
// Larmgräns
// ---------------------------------------------------------------------------

function alertMap(alerts: readonly SlotAlert[]): Map<string, number> {
  return new Map(alerts.map((a) => [assortmentKey(a.machineId, a.titleId), a.alertAtUnits]));
}

/** "Saldo 3, larmgräns 4." */
export function alertText(onHand: number, alertAt: number): string {
  return `Saldo ${Math.max(0, onHand)}, larmgräns ${alertAt}.`;
}

/** Punkten när bara larmgränsen slår till (ingen eller för låg takt). */
function alertTodo(
  s: StockLevelRef,
  alertAt: number,
  titleName: string,
  machineName: string,
): TodoItem {
  const onHand = Math.max(0, s.onHand);
  const level: TodoLevel = onHand === 0 ? "now" : "soon";
  return {
    key: `refill:${s.machineId}:${s.titleId}`,
    fingerprint: refillFingerprint(level, s),
    kind: "refill",
    level,
    urgency: urgencyOf(level, 0),
    atStakeOre: null,
    daysLeft: null,
    title:
      onHand === 0
        ? `${titleName} är slut i ${machineName}`
        : `Fyll på ${titleName} i ${machineName}`,
    detail: alertText(onHand, alertAt),
    evidence: evidence({
      rule: "Saldot är högst larmgränsen för titeln i automaten.",
      titleIds: [s.titleId],
      machineIds: [s.machineId],
      figures: [
        { key: "onHand", label: "I lager", value: onHand, unit: "packs" },
        { key: "alertAtUnits", label: "Larmgräns", value: alertAt, unit: "packs" },
      ],
    }),
    link: links.stock(s.machineId, s.titleId),
    action: {
      kind: "register-refill",
      label: "Registrera påfyllning",
      params: { machineId: s.machineId, titleId: s.titleId },
    },
  };
}

/** Punkten för ett tomt fack utan försäljning i fönstret (titeln har sålt här förut). */
function emptyTodo(s: StockLevelRef, titleName: string, machineName: string): TodoItem {
  return {
    key: `refill:${s.machineId}:${s.titleId}`,
    fingerprint: refillFingerprint("now", s),
    kind: "refill",
    level: "now",
    urgency: urgencyOf("now", 0),
    atStakeOre: null,
    daysLeft: 0,
    title: `${titleName} är slut i ${machineName}`,
    detail: "Slut i automaten. Inget sålt de senaste två veckorna.",
    evidence: evidence({
      rule: "Facket är tomt och titeln har sålt i automaten tidigare.",
      titleIds: [s.titleId],
      machineIds: [s.machineId],
      figures: [{ key: "onHand", label: "I lager", value: 0, unit: "packs" }],
    }),
    link: links.stock(s.machineId, s.titleId),
    action: {
      kind: "register-refill",
      label: "Registrera påfyllning",
      params: { machineId: s.machineId, titleId: s.titleId },
    },
  };
}

/**
 * Lägger larmgränserna på punkter som redan är räknade (laddaren i @/server/data/core
 * skickar inte med gränserna). En påfyllningspunkt som redan finns får texten
 * "Saldo 3, larmgräns 4." först; annars blir det en ny punkt. Nycklar i `skipKeys`
 * (t.ex. avbockade punkter) läggs inte till. Resultatet är sorterat efter brådska.
 */
export function withSlotAlerts(
  items: readonly TodoItem[],
  args: {
    readonly alerts: readonly SlotAlert[];
    readonly stock: readonly StockLevelRef[];
    readonly machines: readonly MachineRef[];
    readonly titles: readonly TitleRef[];
    readonly today: IsoDate;
    readonly slotPeriods?: readonly SlotPeriod[];
    readonly skipKeys?: ReadonlySet<string>;
  },
): TodoItem[] {
  if (args.alerts.length === 0) return [...items];
  const alerts = alertMap(args.alerts);
  const machines = new Map(args.machines.map((m) => [m.id, m]));
  const retired = retiredPairs(args.slotPeriods ?? [], args.today);
  const titleName = titleNames(args.titles);
  const machineName = machineNames(args.machines);
  const byKey = new Map(items.map((t, i) => [t.key, i]));
  const batches = mysteryBatches(args.titles);
  const out = [...items];
  for (const s of args.stock) {
    const pair = assortmentKey(s.machineId, s.titleId);
    const alertAt = alerts.get(pair);
    const onHand = Math.max(0, s.onHand);
    if (alertAt === undefined || onHand > alertAt) continue;
    // Mystery pack: larmgränsen gäller inte före 0 (facket fylls bara på när det är tomt).
    const batch = batches.get(s.titleId);
    if (batch !== undefined && onHand > 0) continue;
    if (isFullSlot(onHand, s.capacity)) continue;
    const machine = machines.get(s.machineId);
    if (!machine || !isMachineActive(machine, args.today)) continue;
    if (retired.has(pair)) continue;
    const key = `refill:${s.machineId}:${s.titleId}`;
    const at = byKey.get(key);
    if (at !== undefined) {
      const item = out[at]!;
      const text = alertText(onHand, alertAt);
      if (!item.detail.startsWith(text)) out[at] = { ...item, detail: `${text} ${item.detail}` };
      continue;
    }
    if (args.skipKeys?.has(key)) continue;
    out.push(
      batch !== undefined
        ? mysteryTodo(s, batch, titleName(s.titleId), machineName(s.machineId), {
            atStakeOre: null,
            detail: ` ${alertText(onHand, alertAt)}`,
          })
        : alertTodo(s, alertAt, titleName(s.titleId), machineName(s.machineId)),
    );
  }
  return sortTodos(out);
}

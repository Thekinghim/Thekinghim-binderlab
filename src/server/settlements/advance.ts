/**
 * Betalning till en butik för en egen period (store_payments): ren logik utan databas.
 *
 * Ägaren betalar ofta från mitten av en månad till mitten av nästa ("14 okt.–14 nov.").
 * Avräkningarna finns per kalendermånad och skapas när månaden är slut. En betalning delas
 * därför upp per kalendermånad NÄR DEN REGISTRERAS, och delarna sparas och ändras aldrig.
 *
 * ## Regeln för uppdelningen (splitPayment)
 *
 * Perioden delas i kalendermånader (monthSlices). Delarna fylls i tur och ordning:
 *
 *  1. Varje månad UTOM DEN SISTA får det appen själv räknar att butiken ska ha för just de
 *     dagarna (sliceTarget), högst det som är kvar av betalningen:
 *     - Täcker delen hela månadens andel (hela månaden, eller allt butiken fick i månaden
 *       ligger inom dagarna) och har månaden en avräkning: avräkningens belopp. En betald
 *       avräkning: det som betalades för den (paid_amount_ore eller beloppet), minus det andra
 *       betalningar redan har lagt på den. Betalningen räknas då som SAMMA pengar som
 *       betalningen av avräkningen, inte som pengar till.
 *     - Annars butikens andel för dagarna, räknad med samma uträkning som avräkningen och
 *       butiksrapporten (eget datum). För en betald avräkning i samma proportion av det som
 *       betalades.
 *     - Går dagarna inte att räkna (saknat inköpspris, eller månaden är inte slut) delas
 *       betalningen inte: ägaren får registrera en betalning per månad.
 *  2. Den SISTA månaden får resten. Är resten mer än butiken ska ha den månaden syns det som
 *     "för mycket" när avräkningen finns. En betald sista månad kan inte få mer än det som
 *     betalades (det vore pengar två gånger): då registreras inget.
 *
 * Ingen fördelning efter antal dagar: appens egna belopp per dag gäller.
 *
 * ## Avdraget på avräkningen
 *
 * Det som betalats för en månad (summan av delarna, `advanceOre`) dras av på månadens
 * avräkning så länge den är obetald: "Kvar att betala" = avräkningen − förskottet. Täcker
 * förskottet hela avräkningen (förskott ≥ belopp) räknas den som betald: servern markerar den
 * betald med betalningarna (paid_from_payments, betalt belopp = förskottet). Blev det för
 * mycket blir skillnaden en vanlig "betald mot dagens uträkning"-skillnad som kan läggas på
 * nästa avräkning (robusthet runda 1). En betald avräkning drar aldrig av något: det som
 * betalats i förskott ingår i det som betalades för den.
 */

import { addDays, monthEnd, monthStart, type IsoDate, type IsoMonth, type Period } from "@/domain";
import { krText, monthNameText, shortDateText } from "@/reports/text";

/** En del av en betalning: det som betalats för dagarna i en kalendermånad. */
export interface PaymentPart {
  readonly month: IsoMonth;
  readonly start: IsoDate;
  readonly end: IsoDate;
  readonly amountOre: number;
}

/** En betalning med sina delar (store_payments). */
export interface StorePaymentRecord {
  readonly id: string;
  readonly storeId: string;
  readonly paidOn: IsoDate;
  readonly amountOre: number;
  readonly periodStart: IsoDate;
  readonly periodEnd: IsoDate;
  readonly note: string | null;
  readonly parts: readonly PaymentPart[];
}

/** Ett förskott på en månad: en del av en betalning med betalningens dag. */
export interface AdvancePart extends PaymentPart {
  readonly paymentId: string;
  readonly storeId: string;
  readonly paidOn: IsoDate;
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

/** Läser sparade delar (store_payments.parts); fel form ger en tom lista. */
export function parseParts(value: unknown): PaymentPart[] {
  if (!Array.isArray(value)) return [];
  const out: PaymentPart[] = [];
  for (const e of value) {
    if (typeof e !== "object" || e === null) return [];
    const p = e as Record<string, unknown>;
    if (
      typeof p.month !== "string" ||
      !MONTH.test(p.month) ||
      typeof p.start !== "string" ||
      !ISO.test(p.start) ||
      typeof p.end !== "string" ||
      !ISO.test(p.end) ||
      typeof p.amountOre !== "number" ||
      !Number.isSafeInteger(p.amountOre) ||
      p.amountOre < 0
    ) {
      return [];
    }
    out.push({
      month: p.month as IsoMonth,
      start: p.start as IsoDate,
      end: p.end as IsoDate,
      amountOre: p.amountOre,
    });
  }
  return out;
}

/** Betalningarnas delar som förskott (delar på 0 kr tas inte med). */
export function advancePartsOf(payments: readonly StorePaymentRecord[]): AdvancePart[] {
  const out: AdvancePart[] = [];
  for (const p of payments) {
    for (const part of p.parts) {
      if (part.amountOre <= 0) continue;
      out.push({ ...part, paymentId: p.id, storeId: p.storeId, paidOn: p.paidOn });
    }
  }
  return out.sort((a, b) =>
    a.start !== b.start ? (a.start < b.start ? -1 : 1) : a.paidOn < b.paidOn ? -1 : 1,
  );
}

/** Perioden i kalendermånader: 14 okt.–14 nov. → [14–31 okt., 1–14 nov.]. */
export function monthSlices(period: Period): { month: IsoMonth; start: IsoDate; end: IsoDate }[] {
  const out: { month: IsoMonth; start: IsoDate; end: IsoDate }[] = [];
  let start = period.start;
  while (start <= period.end) {
    const month = start.slice(0, 7) as IsoMonth;
    const last = monthEnd(month);
    const end = last < period.end ? last : period.end;
    out.push({ month, start, end });
    start = addDays(end, 1);
  }
  return out;
}

/** Hela kalendermånaden. */
export function isWholeMonth(slice: { month: IsoMonth; start: IsoDate; end: IsoDate }): boolean {
  return slice.start === monthStart(slice.month) && slice.end === monthEnd(slice.month);
}

/** Det appen vet om en månad i perioden när betalningen delas upp. */
export interface MonthInfo {
  readonly month: IsoMonth;
  readonly start: IsoDate;
  readonly end: IsoDate;
  /** Månadens avräkning, om den finns. */
  readonly settlement: {
    readonly paid: boolean;
    /**
     * Obetald: avräkningens belopp nu (med rättelserna på den). Betald: det som betalades.
     * I båda fallen minus det andra betalningar redan lagt på månaden.
     */
    readonly openOre: number;
  } | null;
  /** Butikens andel för dagarna; null = går inte att räkna (`why`). */
  readonly rangeOre: number | null;
  /** Butikens andel för hela månaden; null = går inte att räkna. */
  readonly monthOre: number | null;
  /** Dagarna slutar efter i dag (månaden är inte slut för dagarna). */
  readonly future: boolean;
  /** Varför dagarna inte går att räkna. */
  readonly why?: string;
}

/** Vad en månad som inte är den sista ska få av betalningen, eller varför det inte går. */
export function sliceTarget(
  info: MonthInfo,
): { ok: true; targetOre: number } | { ok: false; message: string } {
  const name = monthNameText(info.month);
  const s = info.settlement;
  const covers =
    isWholeMonth(info) ||
    (info.rangeOre !== null && info.monthOre !== null && info.rangeOre === info.monthOre);
  if (s && covers) return { ok: true, targetOre: Math.max(0, s.openOre) };
  if (info.future) {
    return {
      ok: false,
      message: `${capitalize(name)} är inte slut, så delen för ${name} går inte att räkna än.`,
    };
  }
  if (info.rangeOre === null) {
    return {
      ok: false,
      message: `Butikens andel för ${dayRangeText(info)} går inte att räkna${info.why ? `: ${info.why}` : "."}`,
    };
  }
  const range = Math.max(0, info.rangeOre);
  if (!s) return { ok: true, targetOre: range };
  if (s.paid) {
    // Samma andel av det som betalades som dagarna är av månaden.
    const month = info.monthOre ?? 0;
    const scaled = month > 0 ? Math.round((Math.max(0, s.openOre) * range) / month) : range;
    return { ok: true, targetOre: Math.min(Math.max(0, s.openOre), scaled) };
  }
  return { ok: true, targetOre: Math.min(Math.max(0, s.openOre), range) };
}

export type SplitResult =
  | { readonly ok: true; readonly parts: PaymentPart[] }
  | { readonly ok: false; readonly message: string };

/**
 * Delar upp betalningen på månaderna i perioden (regeln överst i filen). `months` är
 * monthSlices(perioden) med det appen vet om varje månad, i ordning.
 */
export function splitPayment(amountOre: number, months: readonly MonthInfo[]): SplitResult {
  if (!Number.isSafeInteger(amountOre) || amountOre <= 0) {
    return { ok: false, message: "Skriv ett belopp över 0 kr." };
  }
  if (months.length === 0) return { ok: false, message: "Välj en period." };
  let left = amountOre;
  const parts: PaymentPart[] = months.map((m) => ({
    month: m.month,
    start: m.start,
    end: m.end,
    amountOre: 0,
  }));
  for (let i = 0; i < months.length - 1; i += 1) {
    const target = sliceTarget(months[i]!);
    if (!target.ok) {
      return {
        ok: false,
        message: `${target.message} Registrera en betalning för varje månad i stället.`,
      };
    }
    const take = Math.min(left, target.targetOre);
    parts[i] = { ...parts[i]!, amountOre: take };
    left -= take;
  }
  const last = months[months.length - 1]!;
  if (last.settlement?.paid && left > Math.max(0, last.settlement.openOre)) {
    const name = monthNameText(last.month);
    const over = left - Math.max(0, last.settlement.openOre);
    return {
      ok: false,
      message: `${capitalize(name)} är redan betald. Betalningen är ${krText(over, "always")} mer än det som återstår för ${name}. Ångra "betald" för ${name} först om det är en ny betalning, eller ändra perioden.`,
    };
  }
  parts[parts.length - 1] = { ...parts[parts.length - 1]!, amountOre: left };
  return { ok: true, parts };
}

// ---------------------------------------------------------------------------
// Avdraget på avräkningen
// ---------------------------------------------------------------------------

/** Förskotten för en butik och månad. */
export function advancesFor(
  parts: readonly AdvancePart[],
  storeId: string,
  month: IsoMonth,
): AdvancePart[] {
  return parts.filter((p) => p.storeId === storeId && p.month === month);
}

export function advanceTotal(parts: readonly { amountOre: number }[]): number {
  return parts.reduce((n, p) => n + p.amountOre, 0);
}

/**
 * Kvar att betala på en obetald avräkning: beloppet − förskotten. Negativt = butiken har
 * fått mer i förskott än avräkningen (`overOre`). `covered`: förskotten täcker avräkningen,
 * den räknas som betald.
 */
export function coverage(
  amountOre: number,
  advanceOre: number,
): { leftOre: number; covered: boolean; overOre: number } {
  const leftOre = amountOre - advanceOre;
  return {
    leftOre,
    covered: advanceOre > 0 && leftOre <= 0,
    overOre: leftOre < 0 ? -leftOre : 0,
  };
}

/**
 * Dagen en avräkning räknas som betald när förskotten täcker den: den senaste betalningens
 * dag, men aldrig före månadens första dag (avräkningen kan inte vara betald före månaden).
 */
export function coveredPaidOn(parts: readonly AdvancePart[], month: IsoMonth): IsoDate {
  const latest =
    parts
      .map((p) => p.paidOn)
      .sort()
      .at(-1) ?? monthStart(month);
  return latest < monthStart(month) ? monthStart(month) : latest;
}

/** "1–14 nov.", "14 okt.–14 nov.", "hela november". */
export function dayRangeText(p: { start: IsoDate; end: IsoDate }): string {
  const sameMonth = p.start.slice(0, 7) === p.end.slice(0, 7);
  if (
    sameMonth &&
    p.start === monthStart(p.start.slice(0, 7) as IsoMonth) &&
    p.end === monthEnd(p.end.slice(0, 7) as IsoMonth)
  ) {
    return `hela ${monthNameText(p.start.slice(0, 7) as IsoMonth)}`;
  }
  if (p.start === p.end) return shortDateText(p.start);
  if (sameMonth) return `${Number(p.start.slice(8, 10))}–${shortDateText(p.end)}`;
  return `${shortDateText(p.start)}–${shortDateText(p.end)}`;
}

/**
 * Raden på avräkningen: "Redan betalt i förskott 1 701,24 kr (1–14 nov., betalt 16 nov.)".
 * Flera betalningar: en parentes per betalning.
 */
export function advanceLine(parts: readonly AdvancePart[]): string | null {
  const counted = parts.filter((p) => p.amountOre > 0);
  if (counted.length === 0) return null;
  const what = counted
    .map((p) => `${dayRangeText(p)}, betalt ${shortDateText(p.paidOn)}`)
    .join("; ");
  return `Redan betalt i förskott ${krText(advanceTotal(counted), "always")} (${what})`;
}

/** "Kvar att betala 3 298,76 kr." / "Butiken har fått 12,00 kr för mycket." / "Allt är betalt." */
export function leftLine(leftOre: number): string {
  if (leftOre > 0) return `Kvar att betala ${krText(leftOre, "always")}`;
  if (leftOre < 0) return `Butiken har fått ${krText(-leftOre, "always")} för mycket`;
  return "Allt är betalt";
}

/**
 * Raden för en del av en betalning i listan "Betalningar": vad den gör med månaden.
 * `settlement`: månadens avräkning (null = finns inte än).
 */
export function partEffectText(
  part: PaymentPart,
  settlement: { paid: boolean; fromPayments: boolean } | null,
): string {
  const name = monthNameText(part.month);
  if (part.amountOre === 0) return `Inget för ${name}`;
  if (!settlement) return `Dras av när avräkningen för ${name} skapas`;
  if (settlement.paid && !settlement.fromPayments) return `Ingår i det som betalades för ${name}`;
  if (settlement.paid) return `Täcker avräkningen för ${name}`;
  return `Dras av på avräkningen för ${name}`;
}

function capitalize(text: string): string {
  return text.charAt(0).toLocaleUpperCase("sv-SE") + text.slice(1);
}

/**
 * Ett belopp i kronor som det skrivs ("10 089,32", "10089.32 kr", "1 701") till öre, eller
 * null när det inte är ett belopp över 0 med högst två decimaler.
 */
export function parseKrInput(text: string): number | null {
  const t = text
    .replace(/kr/gi, "")
    .replace(/[\s  ]/g, "")
    .replace(",", ".");
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return null;
  const [whole, frac = ""] = t.split(".");
  const ore = Number(whole) * 100 + Number(frac.padEnd(2, "0"));
  return Number.isSafeInteger(ore) && ore > 0 ? ore : null;
}

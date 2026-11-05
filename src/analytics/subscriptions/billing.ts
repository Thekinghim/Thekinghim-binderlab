/**
 * Abonnemang: Binderlab tar betalt per aktiv automat och månad. Rena funktioner för
 * fakturaunderlag, MRR, ARR, churn och moms. Ingen klocka, ingen databas: "i dag" skickas in.
 *
 * Regler (docs/abonnemang.md):
 * - Planen har perioder (status, pris per automat och månad i öre, valuta) som aldrig
 *   överlappar. Status "active" debiteras, "paused" och "ended" debiteras inte.
 * - Provperioden: inget debiteras till och med `trialEndsOn`.
 * - Automatdagar: varje dag en automat är aktiv (activeFrom ≤ dag ≤ activeTo) är en
 *   automatdag. En automat som är aktiv hela månaden kostar exakt priset.
 * - Belopp per fakturarad (samma valuta och pris) = round(pris × debiterbara automatdagar /
 *   dagar i månaden), avrundat halva uppåt till hela öre.
 * - Moms (25 % i Sverige):
 *   - Sverige (eller inget land): 25 % svensk moms.
 *   - Annat EU-land med momsnummer: omvänd skattskyldighet (0 %, notering på fakturan).
 *   - Annat EU-land utan momsnummer: 25 % svensk moms och en varning (momsnummer saknas).
 *   - Utanför EU: ingen svensk moms (tjänsten omsätts utomlands).
 * - MRR en dag = pris × aktiva automater den dagen, för kunder med aktiv plan och utan
 *   provperiod. ARR = 12 × MRR. Summor per valuta (valutor blandas aldrig).
 * - Churn i en månad = kunder med aktiv plan (betalande eller i provperiod) dagen före månaden
 *   som inte har en aktiv eller pausad plan vid månadens slut (eller i dag för innevarande
 *   månad). Andel = churnade / aktiva vid månadens start.
 */

import {
  addDays,
  addMonths,
  applyBp,
  eachDay,
  monthEnd,
  monthOf,
  monthStart,
  roundHalfUp,
  type IsoDate,
  type IsoMonth,
} from "@/domain";

export type PlanStatus = "active" | "paused" | "ended";

export const PLAN_STATUSES: readonly PlanStatus[] = ["active", "paused", "ended"];

export const CURRENCIES = ["SEK", "EUR", "DKK", "NOK"] as const;
export type Currency = (typeof CURRENCIES)[number];

/** Svensk moms på tjänsten, 25 %. */
export const SWEDISH_VAT_BP = 2500;

/** EU:s medlemsländer (ISO 3166-1 alfa-2; Grekland är GR här och EL i momsnummer). */
export const EU_COUNTRIES: ReadonlySet<string> = new Set([
  "AT",
  "BE",
  "BG",
  "CY",
  "CZ",
  "DE",
  "DK",
  "EE",
  "ES",
  "FI",
  "FR",
  "GR",
  "HR",
  "HU",
  "IE",
  "IT",
  "LT",
  "LU",
  "LV",
  "MT",
  "NL",
  "PL",
  "PT",
  "RO",
  "SE",
  "SI",
  "SK",
]);

export interface PlanPeriod {
  validFrom: IsoDate;
  /** Sista dagen (inklusive). null = tills vidare. */
  validTo: IsoDate | null;
  status: PlanStatus;
  pricePerMachineOre: number;
  currency: string;
}

export interface BillingMachine {
  machineId: string;
  activeFrom: IsoDate;
  /** Sista aktiva dagen (inklusive). null = fortfarande aktiv. */
  activeTo: IsoDate | null;
}

export interface BillingCustomer {
  /** null = Sverige. */
  countryCode: string | null;
  vatNumber: string | null;
  /** Sista dagen i provperioden. */
  trialEndsOn: IsoDate | null;
}

export type VatMode = "se_vat" | "reverse_charge" | "missing_vat_number" | "outside_eu";

export interface VatTreatment {
  mode: VatMode;
  rateBp: number;
  /** Text på fakturan (tom för vanlig svensk moms). */
  note: string;
}

/** Hur momsen hanteras för kunden. */
export function vatTreatment(
  customer: Pick<BillingCustomer, "countryCode" | "vatNumber">,
): VatTreatment {
  const country = (customer.countryCode ?? "SE").toUpperCase();
  const vat = customer.vatNumber?.trim() || null;
  if (country === "SE") return { mode: "se_vat", rateBp: SWEDISH_VAT_BP, note: "" };
  if (EU_COUNTRIES.has(country)) {
    if (vat) {
      return {
        mode: "reverse_charge",
        rateBp: 0,
        note: `Omvänd skattskyldighet (reverse charge), art. 44 och 196 i direktiv 2006/112/EG. Köparens momsnr: ${vat}.`,
      };
    }
    return {
      mode: "missing_vat_number",
      rateBp: SWEDISH_VAT_BP,
      note: "Momsnummer saknas: svensk moms tas ut tills kunden lämnar ett giltigt momsnummer.",
    };
  }
  return {
    mode: "outside_eu",
    rateBp: 0,
    note: "Tjänsten är omsatt utanför EU. Ingen svensk moms (3 kap. 5 § ML / art. 44).",
  };
}

/** Planperioden som gäller dagen, eller null. */
export function planOn(periods: readonly PlanPeriod[], day: IsoDate): PlanPeriod | null {
  for (const p of periods) {
    if (p.validFrom <= day && (p.validTo === null || day <= p.validTo)) return p;
  }
  return null;
}

/** Är automaten aktiv dagen? */
export function machineActiveOn(m: BillingMachine, day: IsoDate): boolean {
  return m.activeFrom <= day && (m.activeTo === null || day <= m.activeTo);
}

/** Antal aktiva automater dagen. */
export function machinesOn(machines: readonly BillingMachine[], day: IsoDate): number {
  let n = 0;
  for (const m of machines) if (machineActiveOn(m, day)) n++;
  return n;
}

/** Ligger dagen i provperioden? */
export function inTrial(customer: Pick<BillingCustomer, "trialEndsOn">, day: IsoDate): boolean {
  return customer.trialEndsOn !== null && day <= customer.trialEndsOn;
}

export interface InvoiceLine {
  currency: string;
  pricePerMachineOre: number;
  /** Debiterbara automatdagar till det här priset. */
  machineDays: number;
  /** round(pris × automatdagar / dagar i månaden). */
  netOre: number;
}

export interface CurrencyTotal {
  currency: string;
  netOre: number;
  vatOre: number;
  totalOre: number;
}

export interface InvoiceBasis {
  month: IsoMonth;
  daysInMonth: number;
  /** Automater som var aktiva någon dag i månaden. */
  activeMachines: number;
  /** Alla automatdagar i månaden (även i provperiod eller paus). */
  machineDays: number;
  /** Automatdagar som debiteras. */
  billableMachineDays: number;
  /** Automatdagar i provperioden (med aktiv plan). */
  trialMachineDays: number;
  lines: InvoiceLine[];
  totals: CurrencyTotal[];
  vat: VatTreatment;
}

export interface BillingInput {
  periods: readonly PlanPeriod[];
  machines: readonly BillingMachine[];
  customer: BillingCustomer;
}

/** Fakturaunderlaget för en kund och månad. */
export function invoiceBasis(input: BillingInput, month: IsoMonth): InvoiceBasis {
  const days = eachDay(monthStart(month), monthEnd(month));
  const vat = vatTreatment(input.customer);
  const active = new Set<string>();
  let machineDays = 0;
  let billable = 0;
  let trialDays = 0;
  // (valuta, pris) → automatdagar, i den ordning de först förekommer.
  const buckets = new Map<string, InvoiceLine>();
  for (const day of days) {
    let count = 0;
    for (const m of input.machines) {
      if (machineActiveOn(m, day)) {
        count++;
        active.add(m.machineId);
      }
    }
    machineDays += count;
    if (count === 0) continue;
    const plan = planOn(input.periods, day);
    if (!plan || plan.status !== "active") continue;
    if (inTrial(input.customer, day)) {
      trialDays += count;
      continue;
    }
    billable += count;
    const key = `${plan.currency}|${plan.pricePerMachineOre}`;
    const line = buckets.get(key) ?? {
      currency: plan.currency,
      pricePerMachineOre: plan.pricePerMachineOre,
      machineDays: 0,
      netOre: 0,
    };
    line.machineDays += count;
    buckets.set(key, line);
  }
  const lines = [...buckets.values()].map((l) => ({
    ...l,
    netOre: roundHalfUp(l.pricePerMachineOre * l.machineDays, days.length),
  }));
  const byCurrency = new Map<string, number>();
  for (const l of lines) byCurrency.set(l.currency, (byCurrency.get(l.currency) ?? 0) + l.netOre);
  const totals = [...byCurrency.entries()].map(([currency, netOre]) => {
    const vatOre = applyBp(netOre, vat.rateBp);
    return { currency, netOre, vatOre, totalOre: netOre + vatOre };
  });
  return {
    month,
    daysInMonth: days.length,
    activeMachines: active.size,
    machineDays,
    billableMachineDays: billable,
    trialMachineDays: trialDays,
    lines,
    totals,
    vat,
  };
}

export type CustomerState = "active" | "trial" | "paused" | "ended" | "none";

/** Kundens läge en dag. */
export function customerStateOn(
  input: Pick<BillingInput, "periods" | "customer">,
  day: IsoDate,
): CustomerState {
  const plan = planOn(input.periods, day);
  if (!plan) {
    const started = input.periods.some((p) => p.validFrom <= day);
    return started ? "ended" : "none";
  }
  if (plan.status === "active") return inTrial(input.customer, day) ? "trial" : "active";
  return plan.status;
}

export interface Money {
  currency: string;
  amountOre: number;
}

/** MRR för kunden en dag (null om inget debiteras den dagen). */
export function mrrOn(input: BillingInput, day: IsoDate): Money | null {
  const plan = planOn(input.periods, day);
  if (!plan || plan.status !== "active" || inTrial(input.customer, day)) return null;
  return {
    currency: plan.currency,
    amountOre: plan.pricePerMachineOre * machinesOn(input.machines, day),
  };
}

/** ARR = 12 × MRR. */
export function arrOf(mrr: Money | null): Money | null {
  return mrr ? { currency: mrr.currency, amountOre: mrr.amountOre * 12 } : null;
}

/** Summerar belopp per valuta; SEK först, sedan i bokstavsordning. */
export function sumByCurrency(values: Iterable<Money | null>): Money[] {
  const map = new Map<string, number>();
  for (const v of values) {
    if (!v) continue;
    map.set(v.currency, (map.get(v.currency) ?? 0) + v.amountOre);
  }
  return [...map.entries()]
    .map(([currency, amountOre]) => ({ currency, amountOre }))
    .sort((a, b) =>
      a.currency === b.currency
        ? 0
        : a.currency === "SEK"
          ? -1
          : b.currency === "SEK"
            ? 1
            : a.currency.localeCompare(b.currency),
    );
}

/** Mätdagen för en månad: sista dagen, eller i dag om månaden pågår. null om den inte börjat. */
export function measureDay(month: IsoMonth, today: IsoDate): IsoDate | null {
  if (monthStart(month) > today) return null;
  const end = monthEnd(month);
  return end < today ? end : today;
}

export interface PlatformCustomerInput extends BillingInput {
  id: string;
  name: string;
}

export interface MonthHistory {
  month: IsoMonth;
  /** Pågår månaden fortfarande? (mätt i dag i stället för sista dagen) */
  partial: boolean;
  mrr: Money[];
  /** Fakturerat (exkl. moms) enligt underlaget. */
  invoiced: Money[];
  payingCustomers: number;
  /** Kunder med aktiv plan (betalande eller provperiod) vid månadens start. */
  activeAtStart: number;
  churned: number;
  /** Churn i bp, null om ingen var aktiv vid start. */
  churnBp: number | null;
}

function isLive(state: CustomerState): boolean {
  return state === "active" || state === "trial";
}

/** MRR, fakturerat och churn per månad, från `months` månader bakåt till och med i dag. */
export function platformHistory(
  customers: readonly PlatformCustomerInput[],
  today: IsoDate,
  months = 12,
): MonthHistory[] {
  const current = monthOf(today);
  const out: MonthHistory[] = [];
  for (let i = months - 1; i >= 0; i--) {
    const month = addMonths(current, -i);
    const day = measureDay(month, today) as IsoDate;
    const before = addDays(monthStart(month), -1);
    let paying = 0;
    let atStart = 0;
    let churned = 0;
    const mrr: Array<Money | null> = [];
    const invoiced: Money[] = [];
    for (const c of customers) {
      const m = mrrOn(c, day);
      mrr.push(m);
      if (m) paying++;
      const startLive = isLive(customerStateOn(c, before));
      if (startLive) {
        atStart++;
        const endState = customerStateOn(c, day);
        if (!isLive(endState) && endState !== "paused") churned++;
      }
      for (const t of invoiceBasis(c, month).totals) {
        invoiced.push({ currency: t.currency, amountOre: t.netOre });
      }
    }
    out.push({
      month,
      partial: day !== monthEnd(month),
      mrr: sumByCurrency(mrr),
      invoiced: sumByCurrency(invoiced),
      payingCustomers: paying,
      activeAtStart: atStart,
      churned,
      churnBp: atStart === 0 ? null : roundHalfUp(churned * 10_000, atStart),
    });
  }
  return out;
}

export interface CustomerSummary {
  id: string;
  name: string;
  state: CustomerState;
  plan: PlanPeriod | null;
  /** Första dagen med plan. */
  startedOn: IsoDate | null;
  trialEndsOn: IsoDate | null;
  machinesNow: number;
  activeMachinesThisMonth: number;
  mrr: Money | null;
  arr: Money | null;
  /** Innevarande månads underlag hittills (hela månaden med dagens automater). */
  thisMonth: InvoiceBasis;
}

/** En rad per kund på plattformssidan. */
export function customerSummary(c: PlatformCustomerInput, today: IsoDate): CustomerSummary {
  const mrr = mrrOn(c, today);
  const basis = invoiceBasis(c, monthOf(today));
  const first = c.periods.reduce<IsoDate | null>(
    (min, p) => (min === null || p.validFrom < min ? p.validFrom : min),
    null,
  );
  return {
    id: c.id,
    name: c.name,
    state: customerStateOn(c, today),
    plan: planOn(c.periods, today) ?? c.periods[c.periods.length - 1] ?? null,
    startedOn: first,
    trialEndsOn: c.customer.trialEndsOn,
    machinesNow: machinesOn(c.machines, today),
    activeMachinesThisMonth: basis.activeMachines,
    mrr,
    arr: arrOf(mrr),
    thisMonth: basis,
  };
}

export interface PlatformTotals {
  mrr: Money[];
  arr: Money[];
  /** Kunder som betalar i dag. */
  payingCustomers: number;
  trialCustomers: number;
  pausedCustomers: number;
  /** Alla kundorganisationer (även utan plan). */
  customers: number;
  /** Aktiva automater i dag hos betalande kunder. */
  billableMachines: number;
  /** Aktiva automater i dag hos alla kunder. */
  machines: number;
}

export function platformTotals(summaries: readonly CustomerSummary[]): PlatformTotals {
  const mrr = sumByCurrency(summaries.map((s) => s.mrr));
  return {
    mrr,
    arr: mrr.map((m) => ({ currency: m.currency, amountOre: m.amountOre * 12 })),
    payingCustomers: summaries.filter((s) => s.state === "active").length,
    trialCustomers: summaries.filter((s) => s.state === "trial").length,
    pausedCustomers: summaries.filter((s) => s.state === "paused").length,
    customers: summaries.length,
    billableMachines: summaries
      .filter((s) => s.state === "active")
      .reduce((n, s) => n + s.machinesNow, 0),
    machines: summaries.reduce((n, s) => n + s.machinesNow, 0),
  };
}

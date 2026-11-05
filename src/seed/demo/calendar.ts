/**
 * Demons kalender: katalogen (catalog.ts) flyttad till ett valfritt "nu".
 *
 * Katalogen beskriver demon för 1 feb – 2 nov 2026 kl. 12. Kunddemon (Inställningar →
 * Demo för kunder) ska se levande ut, så den skapas med "nu" = när den skapas. Då flyttas
 * HELA berättelsen lika många dagar (Δ = nu − 2 nov 2026):
 *
 * - Varje ISO-datum i katalogen flyttas Δ dagar. Allt som hänger ihop (automat 07 som slutar
 *   sälja två dygn före "nu", avtalet som löper ut inom 90 dagar, släppet om tolv dagar,
 *   ärendena) ligger därför lika långt från "nu" som i originalet.
 * - Månadsnycklar ("2026-08": mål, effekt, avvikelsemånaden) flyttas lika många hela
 *   månader (Δ avrundat till månader).
 * - Datum och månader i fritext ("från 1 juli", "löper ut 31 dec", "januari 2026") skrivs
 *   om på samma sätt, och veckodagen i ärendet ("sedan lördag") räknas om.
 * - Generatorn räknar veckodag och månadsslut ur de VERKLIGA datumen (lördag säljer mest
 *   och centrallagret inventeras sista dagen i månaden), men säsong och lov ur
 *   berättelsens datum (`storyDate`), så att t.ex. höstlovet ligger kvar före "nu".
 *
 * Δ = 0 och klockan 12 ger exakt originalkatalogen (den lokala demon och dess tester).
 * Samma "nu" ger alltid samma demo.
 */

import { addDays, addMonths, daysBetween, dayOfWeek } from "@/domain/dates";
import type { IsoDate } from "@/domain/types";

import {
  DEMO_ACTIVE_MACHINE_GOALS,
  DEMO_AGREEMENTS,
  DEMO_BACKORDER,
  DEMO_BASELINE_PERIOD,
  DEMO_BASELINES,
  DEMO_CONTRACTS,
  DEMO_EFFECT,
  DEMO_FIXED_COSTS,
  DEMO_INCIDENTS,
  DEMO_LAST_DAY_CUTOFF_HOUR,
  DEMO_LEADS,
  DEMO_MACHINES,
  DEMO_NOW,
  DEMO_OWNER_SHARES_FROM,
  DEMO_PAYOUT,
  DEMO_PERIOD,
  DEMO_RECIPIENTS,
  DEMO_REVENUE_GOALS_KR,
  DEMO_TITLES,
} from "./catalog";

/** "Nu" för demon: svenskt datum och hel timme (0–23). Sista dagen säljer fram till timmen. */
export interface DemoClock {
  date: IsoDate;
  hour: number;
}

export const DEMO_DEFAULT_CLOCK: DemoClock = {
  date: DEMO_NOW.date,
  hour: DEMO_LAST_DAY_CUTOFF_HOUR,
};

/** Katalogen för ett visst "nu". Fälten motsvarar DEMO_* i catalog.ts. */
export interface DemoCatalog {
  clock: DemoClock;
  /** Dagar som berättelsen flyttats (0 för originalet). */
  shiftDays: number;
  period: { start: IsoDate; end: IsoDate };
  now: { date: IsoDate; time: string };
  /** Sista dagen säljer automaterna bara före den här timmen. */
  cutoffHour: number;
  /** Prefix för inköpsordernas nycklar, t.ex. "IO-2026-". */
  purchaseOrderPrefix: string;
  machines: typeof DEMO_MACHINES;
  titles: typeof DEMO_TITLES;
  contracts: typeof DEMO_CONTRACTS;
  agreements: typeof DEMO_AGREEMENTS;
  backorder: typeof DEMO_BACKORDER;
  revenueGoalsKr: typeof DEMO_REVENUE_GOALS_KR;
  activeMachineGoals: typeof DEMO_ACTIVE_MACHINE_GOALS;
  baselines: typeof DEMO_BASELINES;
  baselinePeriod: { from: IsoDate; to: IsoDate };
  effect: typeof DEMO_EFFECT;
  fixedCosts: typeof DEMO_FIXED_COSTS;
  ownerSharesFrom: IsoDate;
  leads: typeof DEMO_LEADS;
  recipients: typeof DEMO_RECIPIENTS;
  incidents: typeof DEMO_INCIDENTS;
  payout: {
    deviationMonth: string;
    missingOrders: number;
    linesMonth: string;
    referencePrefix: string;
  };
  /** Berättelsens datum för ett verkligt datum (säsong och lov). */
  storyDate(date: IsoDate): IsoDate;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_MONTH = /^\d{4}-\d{2}$/;

const MONTHS = [
  "januari",
  "februari",
  "mars",
  "april",
  "maj",
  "juni",
  "juli",
  "augusti",
  "september",
  "oktober",
  "november",
  "december",
] as const;
const ABBREVIATIONS = [
  "jan",
  "feb",
  "mar",
  "apr",
  "maj",
  "jun",
  "jul",
  "aug",
  "sep",
  "okt",
  "nov",
  "dec",
];
const WEEKDAYS = ["måndag", "tisdag", "onsdag", "torsdag", "fredag", "lördag", "söndag"];

/** Originalets år för fritext utan år ("31 dec"). */
const STORY_YEAR = 2026;

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function isValidClock(clock: DemoClock): boolean {
  return (
    ISO_DATE.test(clock.date) &&
    !Number.isNaN(Date.parse(`${clock.date}T00:00:00Z`)) &&
    Number.isInteger(clock.hour) &&
    clock.hour >= 0 &&
    clock.hour <= 23
  );
}

/** Flyttar allt i katalogen Δ dagar (se filhuvudet). */
export function demoCatalog(clock: DemoClock = DEMO_DEFAULT_CLOCK): DemoCatalog {
  if (!isValidClock(clock)) {
    throw new RangeError(`Ogiltigt "nu" för demon: ${clock.date} kl. ${clock.hour}.`);
  }
  const shift = daysBetween(DEMO_NOW.date, clock.date);
  const date = (d: IsoDate): IsoDate => (shift === 0 ? d : addDays(d, shift));
  // Månader flyttas ett helt antal månader (närmast Δ), så att två månader aldrig blir en.
  const monthShift = Math.round(shift / 30.436875);
  const month = (m: string): string => (monthShift === 0 ? m : addMonths(m, monthShift));

  const textDate = (day: number, monthIndex: number, year: number): IsoDate =>
    date(`${year}-${pad(monthIndex + 1)}-${pad(day)}`);

  const text = (value: string): string => {
    if (shift === 0) return value;
    return value.replace(
      /(?:(\d{1,2}) )?\b(januari|februari|mars|april|maj|juni|juli|augusti|september|oktober|november|december|jan|feb|mar|apr|jun|jul|aug|sep|okt|nov|dec)\b(?: (20\d\d))?/g,
      (whole, dayText: string | undefined, name: string, yearText: string | undefined) => {
        const full = MONTHS.indexOf(name as (typeof MONTHS)[number]);
        const abbr = ABBREVIATIONS.indexOf(name);
        const index = full >= 0 ? full : abbr;
        const year = yearText ? Number(yearText) : STORY_YEAR;
        if (dayText) {
          const shifted = textDate(Number(dayText), index, year);
          const [y, m, d] = shifted.split("-").map(Number) as [number, number, number];
          const names = full >= 0 ? MONTHS : ABBREVIATIONS;
          return `${d} ${names[m - 1]}${yearText ? ` ${y}` : ""}`;
        }
        if (full < 0) return whole; // förkortning utan dag: rör inte
        const shifted = month(`${year}-${pad(index + 1)}`);
        const [y, m] = shifted.split("-").map(Number) as [number, number];
        return `${MONTHS[m - 1]}${yearText ? ` ${y}` : ""}`;
      },
    );
  };

  /** Går igenom ett katalogvärde: datum, månadsnycklar och fritext flyttas. */
  const walk = <T>(value: T): T => {
    if (typeof value === "string") {
      if (ISO_DATE.test(value)) return date(value) as T;
      if (ISO_MONTH.test(value)) return month(value) as T;
      return text(value) as T;
    }
    if (Array.isArray(value)) return value.map((v) => walk(v)) as T;
    if (value !== null && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [key, v] of Object.entries(value)) {
        out[ISO_MONTH.test(key) ? month(key) : key] = walk(v);
      }
      return out as T;
    }
    return value;
  };

  const incidents = walk(DEMO_INCIDENTS).map((incident) => ({
    ...incident,
    description:
      shift === 0
        ? incident.description
        : incident.description.replace(
            /\b(måndag|tisdag|onsdag|torsdag|fredag|lördag|söndag)\b/g,
            () => WEEKDAYS[dayOfWeek(incident.date) - 1] ?? "",
          ),
  }));

  const cutoffHour = clock.hour;
  return {
    clock,
    shiftDays: shift,
    period: { start: date(DEMO_PERIOD.start), end: clock.date },
    now: { date: clock.date, time: `${pad(cutoffHour)}:00:00` },
    cutoffHour,
    purchaseOrderPrefix: `IO-${clock.date.slice(0, 4)}-`,
    machines: walk(DEMO_MACHINES),
    titles: walk(DEMO_TITLES),
    contracts: walk(DEMO_CONTRACTS),
    agreements: walk(DEMO_AGREEMENTS),
    backorder: walk(DEMO_BACKORDER),
    revenueGoalsKr: walk(DEMO_REVENUE_GOALS_KR),
    activeMachineGoals: walk(DEMO_ACTIVE_MACHINE_GOALS),
    baselines: walk(DEMO_BASELINES),
    baselinePeriod: (() => {
      const m = month(DEMO_BASELINE_PERIOD.from.slice(0, 7));
      const [y, mo] = m.split("-").map(Number) as [number, number];
      const last = new Date(Date.UTC(y, mo, 0)).getUTCDate();
      return { from: `${m}-01`, to: `${m}-${pad(last)}` };
    })(),
    effect: walk(DEMO_EFFECT),
    fixedCosts: walk(DEMO_FIXED_COSTS),
    ownerSharesFrom: date(DEMO_OWNER_SHARES_FROM),
    leads: walk(DEMO_LEADS),
    recipients: walk(DEMO_RECIPIENTS),
    incidents,
    payout: walk({ ...DEMO_PAYOUT }),
    storyDate: (d: IsoDate) => (shift === 0 ? d : addDays(d, -shift)),
  };
}

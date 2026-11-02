/**
 * Typer för försäljningsprognosen per titel × automat.
 *
 * Antal pack anges i tusendelar ("milli": 1 500 = 1,5 pack), belopp i öre, andelar och
 * faktorer i bp (10 000 = 1,0 = 100 %). Varianser anges i milli² per dag.
 */

import type { IsoDate, OrderLine, Period, Settings } from "@/domain";
import type { MachineRef, TitleRef } from "../todos/types";
import type { PlanEvidence } from "./common";

/** Inställningar för prognosen. Alla har standardvärden (`FORECAST_DEFAULTS`). */
export interface ForecastOptions {
  /** Antal dagar framåt. Standard 28 (4 veckor). */
  readonly horizonDays?: number;
  /** Veckor historik som modellen anpassas på. Standard 8. */
  readonly historyWeeks?: number;
  /**
   * Krympning av veckodagsfaktorerna mot 1,0: varje veckodag får så många "snittdagar"
   * extra. Standard 2. 0 = ingen krympning.
   */
  readonly weekdayPriorDays?: number;
  /** Trenden får som mest flytta nivån så här mycket, i bp. Standard 3 000 (±30 %). */
  readonly maxTrendBp?: number;
  /** Minsta antal dagar med data i varje halva av historiken för att trend ska räknas. Standard 7. */
  readonly trendMinDaysPerHalf?: number;
  /** Minsta antal sålda pack i historiken för att trend ska räknas. Standard 10. */
  readonly trendMinUnits?: number;
  /** Färre dagar med data än så här ger status 'low-data'. Standard 14. */
  readonly minHistoryDays?: number;
  /**
   * Osäkerhetsintervallets täckning i bp: 5 000, 8 000, 9 000, 9 500 eller 9 900.
   * Standard 8 000 (80 %-intervall: utfallet väntas hamna utanför ungefär var femte gång).
   */
  readonly intervalCoverageBp?: number;
  /** Dagar bakåt som snittpriset räknas på. Standard 28. */
  readonly priceWindowDays?: number;
  /** Antal ursprung i backtesten. Standard 6. */
  readonly backtestOrigins?: number;
  /** Dagar som varje backtest-ursprung förutsäger. Standard 7. */
  readonly backtestHorizonDays?: number;
  /** Dagar mellan två backtest-ursprung. Standard 7. */
  readonly backtestStepDays?: number;
}

/** En dag då titeln inte gick att köpa i automaten (t.ex. slutsåld). Räknas inte som efterfrågan 0. */
export interface UnavailableDay {
  readonly machineId: string;
  readonly titleId: string;
  readonly date: IsoDate;
}

/** Indata till `forecastSales`. */
export interface ForecastInput {
  /** Order (ett pack per order). Order utan automat räknas inte (de kan inte knytas till en serie). */
  readonly orders: readonly OrderLine[];
  /** Sista hela dag med data (oftast i går). Prognosen börjar dagen efter. */
  readonly asOf: IsoDate;
  /** Moms (intäkten är exklusive moms). */
  readonly settings: Settings;
  readonly titles?: readonly TitleRef[];
  /** Automater. Dagar utanför drifttiden räknas inte, och prognosen är 0 efter `activeTo`. */
  readonly machines?: readonly MachineRef[];
  /** Dagar som inte ska räknas som efterfrågan (slutsålt). Se `stockoutUnavailableDays` i `@/analytics/lost-sales`. */
  readonly unavailable?: readonly UnavailableDay[];
  readonly options?: ForecastOptions;
}

/** En vecka i historiken och dess vikt i nivån. */
export interface HistoryWeek {
  readonly start: IsoDate;
  readonly end: IsoDate;
  /** Sålda pack på dagar med data. */
  readonly units: number;
  /** Dagar med data (inte slutsålt, automaten i drift, titeln i sortimentet). */
  readonly availableDays: number;
  /** Vikt i det glidande medlet: 1 för äldsta veckan … `historyWeeks` för senaste. */
  readonly weight: number;
}

/** Modellens komponenter, så att prognosen kan förklaras och räknas efter. */
export interface ForecastComponents {
  /** Sista dag i historiken. */
  readonly origin: IsoDate;
  /** Historiken som modellen anpassades på. */
  readonly history: Period;
  /** Nivå: veckodagsjusterat, viktat glidande medel, pack/dag i tusendelar. */
  readonly levelMilli: number;
  /** Veckodagsfaktorer i bp, index 0 = måndag … 6 = söndag. Summan är 70 000 (snitt 1,0). */
  readonly weekdayFactorsBp: readonly number[];
  /** Trend: förändring i pack/dag per vecka, i tusendelar. 0 om trenden inte räknas. */
  readonly trendMilliPerWeek: number;
  readonly trendApplied: boolean;
  /** Varför trenden inte räknas, om den inte gör det. */
  readonly trendNote: string | null;
  /**
   * Hur långt bakåt nivån ligger (viktade medelpunkten), i veckor som bråk `num/den`.
   * Trenden räknas från den punkten.
   */
  readonly levelLagWeeks: { readonly num: number; readonly den: number };
  readonly weeks: readonly HistoryWeek[];
  /** Sålda pack och dagar med data i historiken. */
  readonly units: number;
  readonly availableDays: number;
  /** Dagar i historiken som inte räknades (slutsålt, ur drift, före första försäljningen). */
  readonly excludedDays: number;
}

/** En dag i prognosen. */
export interface ForecastDay {
  readonly date: IsoDate;
  /** Veckodag 1 = måndag … 7 = söndag. */
  readonly weekday: number;
  /** Nivå + trend före veckodagsfaktorn, i tusendelar. */
  readonly baseMilli: number;
  /** Trendens bidrag (ingår i `baseMilli`). */
  readonly trendMilli: number;
  readonly factorBp: number;
  /** Prognos: pack i tusendelar. */
  readonly unitsMilli: number;
  /** Prognos: intäkt exkl. moms i öre (antal × snittpris). */
  readonly revenueOre: number;
}

/** En summa med osäkerhetsintervall. */
export interface ForecastTotal {
  readonly period: Period;
  readonly days: number;
  readonly unitsMilli: number;
  readonly unitsLowMilli: number;
  readonly unitsHighMilli: number;
  readonly revenueOre: number;
  readonly revenueLowOre: number;
  readonly revenueHighOre: number;
}

/** Status för en serie. */
export type ForecastStatus = "ok" | "low-data";

/** Varifrån snittpriset kommer. */
export type PriceSource = "series" | "series-history" | "title" | "none";

/** Prognos för en titel i en automat. */
export interface SeriesForecast {
  readonly key: string;
  readonly titleId: string;
  readonly machineId: string;
  readonly status: ForecastStatus;
  readonly components: ForecastComponents;
  /** Snittpris exkl. moms per pack, i öre. 0 om det saknas. */
  readonly avgPriceOre: number;
  readonly priceSource: PriceSource;
  /** Varians per dag (milli²) som intervallen bygger på. */
  readonly dayVarianceMilli2: number;
  /** Varifrån variansen kommer: backtestens residualer eller Poisson-golvet (= prognosen). */
  readonly varianceSource: "residuals" | "poisson";
  readonly days: readonly ForecastDay[];
  /** Fyra rullande veckor (7 dagar var) från dagen efter `asOf`. */
  readonly weeks: readonly ForecastTotal[];
  readonly total: ForecastTotal;
  readonly accuracy: AccuracyMetrics;
  /** T.ex. "Pokémon 151 i Automat 3: ca 42 pack och ca 2 100 kr kommande 4 veckor (80 %: 35–50 pack)." */
  readonly text: string;
  /** Komponenterna i en mening. */
  readonly explanation: string;
  readonly evidence: PlanEvidence;
}

/** Summa av flera serier (per titel, per automat eller totalt). */
export interface AggregateForecast {
  /** Titel- eller automat-id, eller 'total'. */
  readonly key: string;
  readonly seriesKeys: readonly string[];
  readonly days: readonly {
    readonly date: IsoDate;
    readonly unitsMilli: number;
    readonly revenueOre: number;
  }[];
  readonly weeks: readonly ForecastTotal[];
  readonly total: ForecastTotal;
  /** Summan av seriernas dagsvarianser (serierna antas oberoende). */
  readonly dayVarianceMilli2: number;
  readonly text: string;
  readonly evidence: PlanEvidence;
}

/** En punkt i backtesten: en dag som förutsades från ett ursprung. */
export interface BacktestPoint {
  readonly origin: IsoDate;
  readonly date: IsoDate;
  readonly actualMilli: number;
  readonly forecastMilli: number;
  /** Enkel jämförelse: snittet de 7 dagarna före ursprunget. */
  readonly naiveMilli: number;
}

/** Summa per ursprung i backtesten. */
export interface BacktestOrigin {
  readonly origin: IsoDate;
  readonly period: Period;
  readonly days: number;
  readonly actualMilli: number;
  readonly forecastMilli: number;
  readonly naiveMilli: number;
}

/** Träffsäkerhet. Alla mått i bp; `null` när det inte går att räkna (ingen försäljning). */
export interface AccuracyMetrics {
  /** Σ |prognos − utfall| / Σ utfall, per dag. */
  readonly wapeBp: number | null;
  /** Snittet av |prognos − utfall| / utfall per ursprung (summan över ursprungets dagar). */
  readonly mapeBp: number | null;
  /** Σ (prognos − utfall) / Σ utfall. Positivt = prognosen för hög. */
  readonly biasBp: number | null;
  /** WAPE för den enkla jämförelsen (snittet förra veckan). */
  readonly naiveWapeBp: number | null;
  readonly points: number;
  readonly origins: number;
  readonly actualMilli: number;
  readonly forecastMilli: number;
}

/** Backtest för en serie. */
export interface SeriesBacktest {
  readonly key: string;
  readonly titleId: string;
  readonly machineId: string;
  readonly origins: readonly BacktestOrigin[];
  readonly points: readonly BacktestPoint[];
  readonly metrics: AccuracyMetrics;
}

/** Träffsäkerhet för alla serier, för visning. */
export interface ForecastAccuracy {
  /** Mätt per serie och dag (fel tar inte ut varandra mellan automater). */
  readonly series: AccuracyMetrics;
  /** Mätt på summan av alla serier per dag (det som avgör totalintäkten). */
  readonly total: AccuracyMetrics;
  /** T.ex. "Träffsäkerhet de senaste 6 veckorna: …". */
  readonly text: string;
  readonly evidence: PlanEvidence;
}

/** Resultatet av `forecastSales`. */
export interface ForecastResult {
  readonly asOf: IsoDate;
  readonly horizon: Period;
  readonly series: readonly SeriesForecast[];
  readonly byTitle: readonly AggregateForecast[];
  readonly byMachine: readonly AggregateForecast[];
  readonly total: AggregateForecast;
  readonly accuracy: ForecastAccuracy;
  readonly backtests: readonly SeriesBacktest[];
  /** Order som inte kunde räknas (saknar automat). */
  readonly ordersWithoutMachine: number;
}

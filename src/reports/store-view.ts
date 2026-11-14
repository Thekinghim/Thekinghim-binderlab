/**
 * Vad butiksrapporten visar. Butiken ska kunna räkna efter sin andel, men får inte våra
 * detaljer (försäljning per titel, servicebesök) utan att be om det.
 *
 * Standard (kort rapport, en sida): rubriken med beloppet, nyckeltalen (summor),
 * uträkningen, försäljning per vecka, butikens automater och en rad om att underlaget per
 * titel finns på begäran. Med butikens val "Visa detaljer i rapporten" visas också
 * titlarna och service, som förut.
 *
 * Valet sparas i rapporten när den räknas (`StoreReport.details`), så en rapport visar
 * alltid det den visade när den skapades. Rapporter från före valet fanns saknar fältet:
 * `storeDetailsOf` avgör dem. Ren modul: samma regler för sidan, PDF:en, mejlet och
 * butiksportalen.
 */

import type { StoreReport } from "./store-report";
import { isWholeMonth, krText, monthNameText, periodText } from "./text";

/** Sista raden i den korta rapporten. */
export const TITLES_ON_REQUEST = "Underlag per titel finns på begäran.";

/**
 * Visar rapporten detaljer (titlar och service)?
 *
 * - Rapporten har valet sparat: det gäller, oavsett vad butiken har valt sedan dess.
 * - Äldre rapport utan sparat val: en rapport som är godkänd eller skickad (`locked`)
 *   visas som den skickades, med detaljer. Ett utkast följer den nya standarden, utan
 *   detaljer.
 */
export function storeDetailsOf(report: Pick<StoreReport, "details">, locked: boolean): boolean {
  return report.details ?? locked;
}

/** "oktober", eller för eget datum "15–31 okt. 2026". */
function periodNameOf(report: Pick<StoreReport, "month" | "period">): string {
  return isWholeMonth(report.period) ? monthNameText(report.month) : periodText(report.period);
}

/** Rubriken i den korta rapporten: "Er ersättning för oktober: 7 493 kr." */
export function storeHeadline(
  report: Pick<StoreReport, "month" | "period" | "compensation">,
): string {
  return `Er ersättning för ${periodNameOf(report)}: ${krText(report.compensation.totalOre)}.`;
}

export type StoreKpi = "sales" | "orders" | "average" | "compensation";
export type StoreSection = "calculation" | "weeks" | "titles" | "machines" | "service";

export interface StoreReportView {
  /** Sant: titlar och service visas (två sidor, som förut). */
  readonly details: boolean;
  /** Rubriken överst: beloppet i den korta rapporten, annars rapportens slutsats. */
  readonly headline: string;
  readonly kpis: readonly StoreKpi[];
  /** Avsnitten i ordning. */
  readonly sections: readonly StoreSection[];
  /** Avslutande rad (bara den korta rapporten). */
  readonly closing: string | null;
}

/**
 * Rapportens innehåll och ordning. Utan `details` (standard): inga titlar, inget snittköp,
 * inga påfyllningsbesök och ingen "Flest köp".
 */
export function storeReportView(report: StoreReport): StoreReportView {
  if (report.details === true) {
    return {
      details: true,
      headline: report.conclusion.text,
      kpis: ["sales", "orders", "average", "compensation"],
      sections: ["calculation", "weeks", "titles", "machines", "service"],
      closing: null,
    };
  }
  return {
    details: false,
    headline: storeHeadline(report),
    kpis: ["sales", "orders", "compensation"],
    sections: ["calculation", "weeks", "machines"],
    closing: TITLES_ON_REQUEST,
  };
}

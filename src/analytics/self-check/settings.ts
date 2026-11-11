/**
 * Kontroll 7, "Inställningar": två inställningar som gör vinsten för hög utan att något
 * ser fel ut. Bara varningar (inget larm); appen ändrar ingenting själv.
 *
 *   kortavgift 0 % men kortköp finns   varning med kronor: vad 1,5 % hade dragit i år
 *   moms 0 % och försäljningen i år    varning när årets försäljning passerar gränsen
 *   närmar sig momsgränsen             (120 000 kr om inget annat ställts in) före årets
 *                                      slut i nuvarande takt. Stängs med "Revisorn har koll".
 *
 * Används både av den dagliga kontrollen och direkt av Inställningar (rubriken), så att
 * raden försvinner i samma stund som inställningen ändras. Rent.
 */

import { formatInt, NBSP } from "@/lib/format";

import { resultOf } from "./common";
import type { CheckFinding, CheckResult } from "./types";

/** Vanlig kortavgift i en automat (1,5 %): det vi räknar exemplet med. */
export const TYPICAL_CARD_FEE_BP = 150;
/** Skatteverkets gräns för momsbefrielse: 120 000 kr per år. */
export const DEFAULT_VAT_LIMIT_ORE = 12_000_000;
/** Takten räknas på så här många hela dagar bakåt. */
export const PACE_DAYS = 30;

/** Länkarna säger vilken inställning fyndet gäller (Hem och Inställningar läser dem). */
export const CARD_FEE_LINK = "/installningar#kortavgift";
export const VAT_LINK = "/installningar#moms";

export interface SettingsCheckInput {
  readonly cardFeeBp: number;
  readonly vatRateBp: number;
  /** Gränsen vi varnar vid, i öre. */
  readonly vatLimitOre: number;
  /** "Revisorn har koll" är tryckt i det här räkenskapsåret (vatAckValid). */
  readonly vatAcknowledged: boolean;
  /** Betalt belopp i år (räkenskapsåret hittills), testköp borträknade. */
  readonly yearSalesOre: number;
  /** Den del av årets belopp som betalats med kort (eller där betalsättet inte anges). */
  readonly yearCardSalesOre: number;
  /** Betalt belopp de senaste PACE_DAYS hela dagarna. */
  readonly recentSalesOre: number;
  /** Dagar kvar av räkenskapsåret efter i dag. */
  readonly daysLeftInYear: number;
}

/** Början på raden när årets försäljning redan är över gränsen (Hem läser den). */
const OVER_LIMIT = "Det är över";

export type SettingsIssueKind = "card_fee" | "vat";

export interface SettingsIssue {
  readonly kind: SettingsIssueKind;
  /** Hela meningen, på enkel svenska med talen. */
  readonly text: string;
  /** Första meningen (rubriken på Inställningar). */
  readonly title: string;
  /** Resten av texten. */
  readonly rest: string;
  readonly link: string;
}

function kr(ore: number): string {
  return `${formatInt(Math.round(ore / 100))}${NBSP}kr`;
}

/** Kronor avrundat till närmaste tiotal: "ca 1 470 kr". */
function roughKr(ore: number): string {
  const kronor = ore / 100;
  const rounded = kronor >= 100 ? Math.round(kronor / 10) * 10 : Math.round(kronor);
  return `${formatInt(rounded)}${NBSP}kr`;
}

/** Vad kortavgiften hade dragit från årets vinst med den vanliga satsen. */
export function cardFeeEffectOre(yearCardSalesOre: number): number {
  return Math.round((Math.max(0, yearCardSalesOre) * TYPICAL_CARD_FEE_BP) / 10_000);
}

/**
 * Dagar tills årets försäljning passerar gränsen i nuvarande takt. 0 = redan över,
 * null = ingen försäljning de senaste dagarna (går inte att säga).
 */
export function daysToVatLimit(
  input: Pick<SettingsCheckInput, "yearSalesOre" | "recentSalesOre" | "vatLimitOre">,
): number | null {
  const left = input.vatLimitOre - input.yearSalesOre;
  if (left <= 0) return 0;
  if (input.recentSalesOre <= 0) return null;
  return Math.max(1, Math.ceil(left / (input.recentSalesOre / PACE_DAYS)));
}

/** "I morgon", "Om några dagar", "Om ungefär en vecka", "Om ungefär 3 veckor", "Om ungefär 2 månader". */
export function roughWhen(days: number): string {
  if (days <= 1) return "I morgon";
  if (days <= 4) return "Om några dagar";
  if (days <= 10) return "Om ungefär en vecka";
  if (days <= 45) return `Om ungefär ${formatInt(Math.round(days / 7))}${NBSP}veckor`;
  return `Om ungefär ${formatInt(Math.round(days / 30))}${NBSP}månader`;
}

/**
 * "Revisorn har koll" gäller räkenskapsåret det trycktes i. Nästa år börjar försäljningen om
 * från noll mot gränsen, så då säger appen till igen. `vatOkAt` är tidpunkten som text
 * ('ÅÅÅÅ-MM-DD…'), `fiscalStart` årets första dag.
 */
export function vatAckValid(vatOkAt: string | null | undefined, fiscalStart: string): boolean {
  return vatOkAt != null && vatOkAt.slice(0, 10) >= fiscalStart;
}

/** Det som behöver kollas i inställningarna, viktigast först. Tom lista = allt är inställt. */
export function settingsIssues(input: SettingsCheckInput): SettingsIssue[] {
  const out: SettingsIssue[] = [];
  if (input.cardFeeBp === 0 && input.yearCardSalesOre > 0) {
    const title = `Kortavgiften står på 0${NBSP}%.`;
    const rest = `Med 1,5${NBSP}% är vinsten i år ca ${roughKr(cardFeeEffectOre(input.yearCardSalesOre))} lägre. Kolla din utbetalning.`;
    out.push({ kind: "card_fee", title, rest, text: `${title} ${rest}`, link: CARD_FEE_LINK });
  }
  if (input.vatRateBp === 0 && !input.vatAcknowledged && input.yearSalesOre > 0) {
    const days = daysToVatLimit(input);
    const limit = kr(input.vatLimitOre);
    const title = `Du har sålt för ${kr(input.yearSalesOre)} i år.`;
    const ask = "Då kan du behöva momsregistrera dig. Fråga din revisor.";
    if (days === 0) {
      const rest = `${OVER_LIMIT} ${limit}. ${ask}`;
      out.push({ kind: "vat", title, rest, text: `${title} ${rest}`, link: VAT_LINK });
    } else if (days !== null && days <= input.daysLeftInYear) {
      const rest = `${roughWhen(days)} passerar du ${limit}. ${ask}`;
      out.push({ kind: "vat", title, rest, text: `${title} ${rest}`, link: VAT_LINK });
    }
  }
  return out;
}

/** Rubriken på Inställningar. */
export function settingsCheckHeadline(issues: readonly SettingsIssue[]): {
  readonly title: string;
  readonly line: string | null;
  readonly ok: boolean;
} {
  const [first] = issues;
  if (!first) return { title: "Allt är inställt.", line: null, ok: true };
  return { title: first.title, line: first.rest, ok: false };
}

export function settingsCheck(input: SettingsCheckInput): CheckResult {
  const issues = settingsIssues(input);
  const findings: CheckFinding[] = issues.map((i) => ({
    level: "warn",
    text: i.text,
    link: i.link,
  }));
  return resultOf("installningar", {
    findings,
    figures: [
      { label: "Kortavgift", value: input.cardFeeBp, unit: "bp" },
      { label: "Moms", value: input.vatRateBp, unit: "bp" },
      { label: "Sålt i år", value: input.yearSalesOre, unit: "ore" },
      { label: "Momsgräns", value: input.vatLimitOre, unit: "ore" },
    ],
    summary: {
      pass: "Kortavgiften och momsen är inställda.",
      warn: findings.length === 1 ? "En inställning att kolla." : "Två inställningar att kolla.",
    },
  });
}

/**
 * Fynden ur en sparad körning som fortfarande gäller med dagens inställningar: en ändrad
 * kortavgift eller moms, eller "Revisorn har koll", tar bort raden utan en ny körning.
 */
export function stillValid(
  finding: CheckFinding,
  now: {
    readonly cardFeeBp: number;
    readonly vatRateBp: number;
    readonly vatAcknowledged: boolean;
  },
): boolean {
  if (finding.link === CARD_FEE_LINK) return now.cardFeeBp === 0;
  if (finding.link === VAT_LINK) return now.vatRateBp === 0 && !now.vatAcknowledged;
  return true;
}

/** Raden på Hem för en varning i inställningarna (kort, utan punkt), eller null. */
export function settingsHomeNotice(
  findings: readonly CheckFinding[],
  now: Parameters<typeof stillValid>[1],
): string | null {
  const left = findings.filter((f) => stillValid(f, now));
  if (left.some((f) => f.link === CARD_FEE_LINK)) return `Kortavgiften står på 0${NBSP}%`;
  const vat = left.find((f) => f.link === VAT_LINK);
  // Redan över gränsen ska inte heta "närmar dig".
  if (vat)
    return vat.text.includes(OVER_LIMIT) ? "Du är över momsgränsen" : "Du närmar dig momsgränsen";
  return null;
}

/**
 * De flytande knapparna på mobilen (under lg): "Fyll på" för den som fyller på (ägare, admin,
 * påfyllare) och "Fråga AI".
 * På telefonen (under md) finns ingen flytande AI-knapp: den skymde innehåll till höger, och
 * AI nås alltid från toppraden. Mellan md och lg står den kvar.
 * Rena regler, så att skalet (luften under sidan), bottenraden och AI-knappen räknar med
 * samma mått och aldrig döljer innehåll. Testas i fab.test.ts.
 */

import type { Role } from "./nav";

/** Bottenradens höjd (utan säkerhetsmarginalen nedtill på iPhone). */
export const BOTTOM_NAV_PX = 56;
/** Knapparnas höjd. */
export const FAB_SIZE_PX = 44;
/** Luft mellan bottenraden, knappen och innehållet. */
export const FAB_GAP_PX = 12;

/** Rollerna som fyller på (samma som Fyll på, FIELD_REFILL_ROLES): ägare, admin och påfyllare. */
const REFILL_ROLES: ReadonlySet<Role> = new Set<Role>(["owner", "admin", "refiller"]);

/** Sant för rollerna som når Fyll på (genvägen på mobilen och raden i sidomenyn). */
export function canRefill(role: Role): boolean {
  return REFILL_ROLES.has(role);
}

/**
 * Genvägen "Fyll på" ovanför bottenraden, för alla som fyller på (ägare, admin, påfyllare).
 * Inte på fältsidorna (Påfyllning och Besök), som har en egen knapp nedtill. Läsaren fyller
 * inte på och får ingen.
 */
export function showsRefillShortcut(role: Role, pathname: string | null | undefined): boolean {
  const path = pathname ?? "";
  return canRefill(role) && path !== "/drift/pafyllning" && !path.startsWith("/drift/besok");
}

export interface FabLayout {
  /** Avstånd från bottenradens överkant till "Fyll på" (null = ingen knapp). */
  readonly refillBottom: number | null;
  /** Avstånd till AI-knappen (null = ingen knapp). */
  readonly assistantBottom: number | null;
  /** Luft under sidans innehåll, så att sista raden går att rulla fram ovanför knapparna. */
  readonly mainPaddingBottom: number;
}

/**
 * Var knapparna står och hur mycket luft sidan behöver (px, plus säkerhetsmarginalen).
 * Med "Fyll på" visas ingen flytande AI-knapp: den viktigaste knappen i fält får platsen,
 * och AI nås från toppraden.
 */
export function fabLayout(options: { refill: boolean; assistant: boolean }): FabLayout {
  const slot = BOTTOM_NAV_PX + FAB_GAP_PX;
  const refillBottom = options.refill ? slot : null;
  const assistantBottom = options.assistant && !options.refill ? slot : null;
  const any = refillBottom !== null || assistantBottom !== null;
  return {
    refillBottom,
    assistantBottom,
    mainPaddingBottom: any ? slot + FAB_SIZE_PX + FAB_GAP_PX : BOTTOM_NAV_PX,
  };
}

/** Knapparna på telefonen (under md): som fabLayout, men utan flytande AI-knapp. */
export function phoneFabLayout(options: { refill: boolean }): FabLayout {
  return fabLayout({ refill: options.refill, assistant: false });
}

/** Rullar man så här långt (px) åt ett håll byter knappen läge. */
const SCROLL_STEP_PX = 8;
/** Nära toppen syns knappen alltid. */
const TOP_ZONE_PX = 80;

/**
 * Ska AI-knappen synas efter en rullning från `lastY` till `y`? Den glider undan när man
 * rullar nedåt (läser) och kommer tillbaka när man rullar uppåt, är nära toppen eller har
 * kommit till slutet (där sidan har luft under sig). Små rörelser ändrar inget.
 */
export function fabVisibleAfterScroll(
  visible: boolean,
  lastY: number,
  y: number,
  atEnd = false,
): boolean {
  if (y <= TOP_ZONE_PX || atEnd) return true;
  const dy = y - lastY;
  if (dy > SCROLL_STEP_PX) return false;
  if (dy < -SCROLL_STEP_PX) return true;
  return visible;
}

/**
 * Varningen i "Placera/Flytta automat" och "Lägg till automat": butiken har inget avtal
 * från den valda dagen, så den räknas som 0 % (ingen andel, ingen hyra) tills ett avtal
 * läggs in. Samma uppslag som beräkningarna (agreementOn i @/domain). Ren.
 */

import { agreementOn, isIsoDate } from "@/domain";

import type { StoreOption } from "./types";

/** Varningen, eller null när butiken har avtal den dagen (eller avtalen inte är kända). */
export function placementAgreementWarning(
  store: StoreOption | undefined,
  day: string,
): string | null {
  if (!store || store.agreements === undefined || !isIsoDate(day)) return null;
  if (agreementOn(store.agreements, store.id, day) !== null) return null;
  const later = store.agreements.some((a) => a.storeId === store.id && a.validFrom > day);
  return later
    ? `${store.name} har inget avtal från den dagen än. Butiken räknas som 0 % tills avtalet börjar.`
    : `${store.name} har inget avtal – butiken räknas som 0 %.`;
}

/** Raden om kontraktet i samma rutor. */
export const CONTRACT_NOT_SIGNED = "Kontraktet är inte signerat. Signera först eller placera ändå.";

/**
 * "Kontraktet är inte signerat. Signera först eller placera ändå." när den valda butiken
 * saknar signerat kontrakt (osignerat eller inget alls). Null när det är signerat eller
 * inte är känt. Det är en upplysning: automaten går att placera ändå. Ren.
 */
export function placementContractWarning(store: StoreOption | undefined): string | null {
  if (!store || store.contract === undefined || store.contract === "signed") return null;
  return CONTRACT_NOT_SIGNED;
}

/**
 * Kontrakt per butik: har butiken ett signerat kontrakt i dag? Samma regel på Kontrakt,
 * Butiker, butikens sida och Att göra ("Sega gubben saknar kontrakt").
 *
 *   signerat   = kontraktet gäller i dag eller senare (inte utgånget) och är antingen
 *                signerat (signed_at) eller registrerat för hand (ingen mall: ett befintligt
 *                papperskontrakt räknas som signerat)
 *   osignerat  = ett kontrakt från mallen som inte är signerat (utkast eller skickat)
 *   saknas     = inget kontrakt som gäller
 *
 * Arkiverade kontrakt ska inte skickas hit. Rent, testas i signed.test.ts.
 */

import type { IsoDate } from "@/domain";

import { contractStatus, contractTerm } from "./contracts";
import type { Contract } from "./types";

/** Kontraktet med det som avgör om det är signerat. */
export interface SignableContract extends Contract {
  /** Mallen kontraktet skapades från, null = registrerat för hand. Saknas = för hand. */
  readonly template?: string | null;
  /** Tidpunkt (från databasen) eller null; bara om den finns spelar roll här. */
  readonly sentAt?: unknown;
  readonly signedAt?: unknown;
}

export type StoreContractState = "signed" | "unsigned" | "missing";

/** Kontraktet har inte gått ut (det kan börja senare). */
export function contractInForce(c: Contract, today: IsoDate): boolean {
  if (c.validTo !== null && c.validTo < c.validFrom) return false;
  const term = contractTerm(c, today < c.validFrom ? c.validFrom : today);
  return contractStatus(c, term, today) !== "expired";
}

/** Signerat eller registrerat för hand. */
export function isSigned(c: SignableContract): boolean {
  return (c.template ?? null) === null || (c.signedAt ?? null) !== null;
}

/** Butikens läge: signerat, osignerat (utkast/skickat) eller saknas. */
export function storeContractState(
  contracts: readonly SignableContract[],
  storeId: string,
  today: IsoDate,
): StoreContractState {
  const live = contracts.filter((c) => c.storeId === storeId && contractInForce(c, today));
  if (live.some(isSigned)) return "signed";
  return live.length > 0 ? "unsigned" : "missing";
}

/** Läget för varje butik (id → läge). */
export function storeContractStates(
  contracts: readonly SignableContract[],
  storeIds: readonly string[],
  today: IsoDate,
): Map<string, StoreContractState> {
  return new Map(storeIds.map((id) => [id, storeContractState(contracts, id, today)]));
}

/**
 * "X av Y butiker har signerat kontrakt": Y = butikerna med automat i dag (de måste ha
 * kontrakt). Utan automater räknas alla butiker.
 */
export function signedCount(
  states: ReadonlyMap<string, StoreContractState>,
  withMachine: ReadonlySet<string>,
): { signed: number; total: number } {
  const ids = [...states.keys()];
  const counted = withMachine.size > 0 ? ids.filter((id) => withMachine.has(id)) : ids;
  return {
    signed: counted.filter((id) => states.get(id) === "signed").length,
    total: counted.length,
  };
}

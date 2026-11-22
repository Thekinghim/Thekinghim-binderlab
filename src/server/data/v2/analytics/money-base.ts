/**
 * Gemensamma laddare för Pengar i V2 (G4). Korten läser samma memoiserade underlag en gång
 * per förfrågan: Lönsamhets modell och indata för vald period (samma som /lonsamhet) och
 * ett års indata för hela organisationen (tabellen per månad och bästsäljarnas veckor).
 * React `cache` jämför argumenten med ===, så sökparametrarna skickas som en sträng.
 *
 * Bara roller som ser ekonomi (ägare, admin, läsare): varje laddare returnerar null för
 * påfyllaren, och den underliggande laddaren kontrollerar rollen igen mot databasen.
 */

import "server-only";

import { cache } from "react";

import type { SearchParamsInput } from "@/components/shell/period-state";
import { addDays, maxDate, monthOf, monthStart, type IsoDate } from "@/domain";
import { loadContext } from "@/server/data/core";
import type { DomainInput } from "@/server/data/core/types";
import { requestPageLoaders, type PageLoaders } from "@/server/data/page-loaders";

import { loadLonsamhetWith, type LonsamhetData } from "@/app/(app)/lonsamhet/_lib/data";

/** Parametrarna som styr Pengars siffror (period och filter), i fast ordning. */
const KEYS = ["period", "from", "to", "butik", "automat", "agare", "andel", "vmb"] as const;

type Plain = Record<string, string | undefined>;

/** Sökparametrarna som en nyckel för `cache` (bara de som påverkar talen). */
export function moneyKey(sp: SearchParamsInput): string {
  const get = (k: string): string | undefined => {
    if (typeof (sp as { get?: unknown }).get === "function") {
      return (sp as { get(name: string): string | null }).get(k) ?? undefined;
    }
    const v = (sp as Record<string, string | string[] | undefined>)[k];
    return Array.isArray(v) ? v[0] : v;
  };
  const out: Plain = {};
  for (const k of KEYS) {
    const v = get(k);
    if (v !== undefined && v !== "") out[k] = v;
  }
  return JSON.stringify(out);
}

export const parseMoneyKey = (key: string): Plain => JSON.parse(key) as Plain;

/** Lönsamhets modell och indata för perioden, eller null utan ekonomi. */
export const loadMoneyProfit = cache(async (key: string): Promise<LonsamhetData | null> => {
  const ctx = await loadContext();
  if (!ctx.canSeeEconomy) return null;
  return loadLonsamhetWith(requestPageLoaders(), parseMoneyKey(key));
});

/** Antal månader i tabellen (den pågående inräknad). */
export const YEAR_MONTHS = 12;

export interface MoneyYear {
  readonly input: DomainInput;
  readonly today: IsoDate;
  /** Första dagen i tabellen (första dagen med data eller 12 månader bakåt). */
  readonly start: IsoDate;
}

/**
 * Hela organisationens indata från början av månaden för 11 månader sedan t.o.m. i dag
 * (eller från första dagen med data). Inget filter: tabellen visar alla automater.
 */
export const loadMoneyYear = cache(async (): Promise<MoneyYear | null> => {
  const ctx = await loadContext();
  if (!ctx.canSeeEconomy) return null;
  return loadMoneyYearWith(requestPageLoaders());
});

/**
 * Samma med givna laddare (sidan med förfrågans, testerna med en given användare). Rollen
 * kontrolleras av laddarna (loadDomainInputFor kastar för påfyllaren).
 */
export async function loadMoneyYearWith(
  loaders: Pick<PageLoaders, "context" | "period" | "domainInput">,
): Promise<MoneyYear> {
  const [ctx, p] = await Promise.all([loaders.context(), loaders.period({})]);
  const first = monthStart(monthOf(ctx.today));
  let start = first;
  for (let i = 1; i < YEAR_MONTHS; i++) start = monthStart(monthOf(addDays(start, -1)));
  if (p.dataStart) start = maxDate(start, p.dataStart);
  if (start > ctx.today) start = ctx.today;
  const input = await loaders.domainInput({
    period: { start, end: ctx.today },
    compare: null,
  });
  return { input, today: ctx.today, start };
}

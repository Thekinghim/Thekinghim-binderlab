/**
 * Gissning mot utfall, steg 1: spara gissningen när en plats i pipelinen blir butik
 * (migreringen 20261206000000_gissning_pa_plats.sql). Gissningen är samma uppskattning som
 * sidan Expansion visar för platsen (expansionPipeline, skalets standardperiod), räknad
 * innan platsen kopplas till butiken. Den sparas en gång och skrivs aldrig över.
 *
 * Utan beroende på Next; testas i test/db/r2-t6-gissning.test.ts. Ingenting visas än.
 */

import "server-only";

import { and, eq, isNull } from "drizzle-orm";

import { expansionPipeline, siteHistories, type StoreProfile } from "@/analytics/expansion";
import type { Tx } from "@/db/client";
import * as s from "@/db/schema";
import type { IsoDate } from "@/domain";
import {
  businessToday,
  loadDataStartFor,
  loadDomainInputFor,
  type Viewer,
} from "@/server/data/core/loaders";
import { resolveAppPeriod } from "@/server/data/core/period";

import { clipToData, defaultInvestment, toAnalyticsLead } from "../../../expansion/_lib/model";
import { loadLeadsFor, loadStoreProfilesFor } from "../../../expansion/_lib/service";

/** Gissningen för en plats: vinst per automat och månad i öre. */
export interface LeadGuess {
  readonly profitPerMonthOre: number;
  readonly lowOre: number;
  readonly highOre: number;
  /** Dagen gissningen gjordes. */
  readonly on: IsoDate;
}

/**
 * Uppskattningen för platsen just nu, eller null när den inte går att räkna (platsen finns
 * inte, eller ingen befintlig butik är tillräckligt lik). Ägare, admin och läsare.
 */
export async function leadGuessFor(
  viewer: Viewer,
  leadId: string,
  now: Date = new Date(),
): Promise<LeadGuess | null> {
  const timeZone = viewer.organization.timezone;
  const today = businessToday(now, timeZone);
  const leads = await loadLeadsFor(viewer);
  const lead = leads.find((l) => l.id === leadId);
  if (!lead) return null;
  const dataStart = await loadDataStartFor(viewer);
  // Samma period som Expansion räknar på utan eget val: skalets standard, klippt till datan.
  const period = clipToData(
    resolveAppPeriod({}, { timeZone, dataStart, now }).period,
    dataStart,
  ).period;
  const [input, profiles] = await Promise.all([
    loadDomainInputFor(viewer, { period }, now),
    loadStoreProfilesFor(viewer),
  ]);
  const stores: StoreProfile[] = profiles
    .filter((p) => !p.archived)
    .map((p) => ({
      id: p.id,
      name: p.name,
      storeType: p.storeType,
      city: p.city,
      openHoursPerWeek: p.openHoursPerWeek,
      areaSqm: p.areaSqm,
    }));
  const [potential] = expansionPipeline({
    leads: [toAnalyticsLead(lead)],
    stores,
    histories: siteHistories(input.current),
    period: input.current.period,
    defaultInvestment: defaultInvestment(input.investments, today)?.plan ?? {
      purchaseOre: 0,
      installationOre: 0,
    },
  });
  const range = potential?.estimate.status === "ok" ? potential.estimate.profitPerMonthOre : null;
  if (!range) return null;
  return { profitPerMonthOre: range.expected, lowOre: range.low, highOre: range.high, on: today };
}

/** Som leadGuessFor, men ett fel stoppar inte det som anropar: då sparas ingen gissning. */
export function leadGuessSafe(viewer: Viewer, leadId: string): Promise<LeadGuess | null> {
  return leadGuessFor(viewer, leadId).catch((error: unknown) => {
    console.error("[ny butik] Gissningen kunde inte räknas:", error);
    return null;
  });
}

/**
 * Sparar gissningen på platsen, bara om ingen redan är sparad. Körs i anroparens
 * transaktion (som användaren, RLS). Sant om den sparades.
 */
export async function saveLeadGuess(
  tx: Tx,
  organizationId: string,
  leadId: string,
  guess: LeadGuess,
): Promise<boolean> {
  const rows = await tx
    .update(s.expansionLeads)
    .set({
      guessProfitMonthOre: guess.profitPerMonthOre,
      guessLowMonthOre: guess.lowOre,
      guessHighMonthOre: guess.highOre,
      guessOn: guess.on,
    })
    .where(
      and(
        eq(s.expansionLeads.organizationId, organizationId),
        eq(s.expansionLeads.id, leadId),
        isNull(s.expansionLeads.guessOn),
      ),
    )
    .returning({ id: s.expansionLeads.id });
  return rows.length > 0;
}

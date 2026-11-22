/**
 * Indata som flera laddare läser i samma förfrågan, en gång per förfrågan och användare
 * (React cache), så att menyns räknare, Hem och Rutt inte läser samma sak två gånger per
 * sidladdning:
 *
 * - maskinhälsans indata (loadHealthData): flottans läge (./fleet.ts) och besöksplanen
 *   (../todos.ts), för samma dag och klocka;
 * - Startklar-listan (loadMachineReadinessSafe): flottans läge och Att göras Startklar-rad.
 *
 * Utanför en serverrendering (jobb, tester) minns React cache inget: då läses de varje gång,
 * som förut. Bara läsning som användaren (RLS); rollen kontrolleras av den som anropar
 * (Startklar-listan kontrollerar själv och är tom för roller som inte ser den).
 */

import "server-only";

import { cache } from "react";

import type { IsoDate } from "@/domain";
import { withUserDbFor } from "@/server/access";
import { loadHealthData, type HealthData } from "@/server/alerts/inputs";
import type { MachineReadiness } from "@/server/onboarding/machine-ready";
import { loadMachineReadinessSafe } from "@/server/onboarding/machine-ready-load";

import type { Viewer } from "../core/loaders";

const healthInRequest = cache(
  (userId: string, email: string, orgId: string, today: IsoDate, nowMs: number) =>
    withUserDbFor({ userId, email }, (tx) => loadHealthData(tx, orgId, today, new Date(nowMs))),
);

/** loadHealthData som användaren, delad inom förfrågan (samma organisation, dag och klocka). */
export function healthDataInRequest(
  viewer: Viewer,
  today: IsoDate,
  now: Date,
): Promise<HealthData> {
  return healthInRequest(
    viewer.user.userId,
    viewer.user.email,
    viewer.organization.id,
    today,
    now.getTime(),
  );
}

const readinessInRequest = cache(
  (userId: string, email: string, orgId: string): Promise<MachineReadiness[]> =>
    loadMachineReadinessSafe({ userId, email }, orgId),
);

/** loadMachineReadinessSafe (fel: tom lista), delad inom förfrågan. */
export function machineReadinessInRequest(viewer: Viewer): Promise<MachineReadiness[]> {
  return readinessInRequest(viewer.user.userId, viewer.user.email, viewer.organization.id);
}

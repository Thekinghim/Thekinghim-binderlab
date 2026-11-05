/**
 * /plattform: bara plattformsoperatörer (ägare/admin i en organisation i
 * private.platform_operators). Andra får 404, så att sidan inte ens syns finnas.
 * Kontrollen här ger tidiga svar; RPC:erna i databasen nekar ändå alla andra.
 * Aldrig från en demo (Demo för kunder): är den aktiva organisationen en demo blir det
 * 404, och databasen räknar aldrig en demoorganisation som plattformsorganisation.
 */

import "server-only";

import { notFound } from "next/navigation";
import { cache } from "react";

import type { IsoDate } from "@/domain";
import { todayIn } from "@/server/portal/model";
import { isDemoFor } from "@/server/demo/guard";
import { getActiveOrganization, requireUser, type SessionUser } from "@/server/session";
import { isPlatformOperatorFor } from "@/server/subscriptions/service";

/** Plattformen räknar i svensk tid (Binderlab fakturerar från Sverige). */
export const PLATFORM_TIME_ZONE = "Europe/Stockholm";

/** Plattformsoperatör och den aktiva organisationen är inte en demo. */
export async function platformAllowedFor(user: SessionUser): Promise<boolean> {
  if (!(await isPlatformOperatorFor(user))) return false;
  const organization = await getActiveOrganization();
  return !(organization && (await isDemoFor(user, organization.id)));
}

export const requirePlatform = cache(async (): Promise<{ user: SessionUser; today: IsoDate }> => {
  const user = await requireUser();
  if (!(await platformAllowedFor(user))) notFound();
  return { user, today: todayIn(PLATFORM_TIME_ZONE) };
});

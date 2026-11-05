/**
 * /plattform: bara plattformsoperatörer (ägare/admin i en organisation i
 * private.platform_operators). Andra får 404, så att sidan inte ens syns finnas.
 * Kontrollen här ger tidiga svar; RPC:erna i databasen nekar ändå alla andra.
 */

import "server-only";

import { notFound } from "next/navigation";
import { cache } from "react";

import type { IsoDate } from "@/domain";
import { todayIn } from "@/server/portal/model";
import { requireUser, type SessionUser } from "@/server/session";
import { isPlatformOperatorFor } from "@/server/subscriptions/service";

/** Plattformen räknar i svensk tid (Binderlab fakturerar från Sverige). */
export const PLATFORM_TIME_ZONE = "Europe/Stockholm";

export const requirePlatform = cache(async (): Promise<{ user: SessionUser; today: IsoDate }> => {
  const user = await requireUser();
  if (!(await isPlatformOperatorFor(user))) notFound();
  return { user, today: todayIn(PLATFORM_TIME_ZONE) };
});

"use server";

/**
 * Server actions för Lönsamhet. Tunna omslag: organisationen är den aktiva (läses på
 * servern), rollen kontrolleras här och mot databasen i tjänsten, och allt skrivs som
 * användaren under RLS. Ändringen loggas i audit_log av triggern.
 */

import { unstable_rethrow } from "next/navigation";

import type { ActionResult } from "@/server/auth/flows";
import { revalidateAppData } from "@/server/data/core";

import { currentViewer } from "../lager/_lib/session";
import { ADVICE_MESSAGES, setTargetMarginFor } from "./_lib/price-advice";

/** Prisråd: sparar målet för marginalen (1–90 %, i baspunkter). Ägare och admin. */
export async function setTargetMargin(input: {
  targetMarginBp: number;
}): Promise<ActionResult<{ targetMarginBp: number }>> {
  let viewer;
  try {
    viewer = await currentViewer();
  } catch (error) {
    // Omdirigeringar (utloggad, Enkel vy) ska gå igenom.
    unstable_rethrow(error);
    return { ok: false, error: ADVICE_MESSAGES.forbidden };
  }
  const result = await setTargetMarginFor(viewer, {
    targetMarginBp: Number(input?.targetMarginBp),
  });
  if (result.ok) revalidateAppData();
  return result;
}

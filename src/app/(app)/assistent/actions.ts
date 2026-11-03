"use server";

/**
 * Server actions för rådgivarens förslag (Att göra och Assistent). Användaren och
 * organisationen läses på servern; rollen (ägare eller admin) kontrolleras mot databasen
 * och statusändringen görs under RLS.
 */

import { revalidatePath } from "next/cache";

import type { ActionResult } from "@/server/auth/flows";
import { runAdvisor, setSuggestionStatusFor } from "@/server/assistant/advisor/service";
import { requestVmbView } from "@/server/data/core";
import type { Viewer } from "@/server/data/core/loaders";
import { AuthorizationError, getActiveOrganization, requireUser } from "@/server/session";

const FORBIDDEN = "Bara ägare och administratörer kan hantera förslagen.";

async function currentViewer(): Promise<Viewer | null> {
  try {
    const user = await requireUser();
    const organization = await getActiveOrganization();
    return organization ? { user, organization } : null;
  } catch (error) {
    if (error instanceof AuthorizationError) return null;
    throw error;
  }
}

function refresh(): void {
  revalidatePath("/att-gora");
  revalidatePath("/assistent");
}

/** Klar, avfärdad eller tillbaka till ny. */
export async function setSuggestionStatus(input: {
  id: string;
  status: "done" | "dismissed" | "new";
}): Promise<ActionResult> {
  if (!["done", "dismissed", "new"].includes(input?.status)) {
    return { ok: false, error: "Ogiltig status." };
  }
  const viewer = await currentViewer();
  if (!viewer) return { ok: false, error: FORBIDDEN };
  try {
    const ok = await setSuggestionStatusFor(viewer, String(input.id), input.status);
    if (!ok) return { ok: false, error: "Förslaget finns inte." };
  } catch (error) {
    if (error instanceof AuthorizationError) return { ok: false, error: FORBIDDEN };
    throw error;
  }
  refresh();
  return { ok: true };
}

/** "Generera nya förslag": högst 3 per dag och organisation. */
export async function generateSuggestions(): Promise<ActionResult<{ accepted: number }>> {
  const viewer = await currentViewer();
  if (!viewer) return { ok: false, error: FORBIDDEN };
  try {
    // Underlaget följer vyknappen "Med VMB" på sidan där knappen trycktes.
    const r = await runAdvisor({ viewer, trigger: "manual", vmb: await requestVmbView() });
    switch (r.status) {
      case "ok":
        refresh();
        return { ok: true, data: { accepted: r.accepted } };
      case "empty":
        refresh();
        return {
          ok: false,
          error: "Inga förslag klarade kontrollen mot underlaget den här gången.",
        };
      case "budget":
        refresh();
        return { ok: false, error: "Månadens AI-budget är slut." };
      case "error":
        refresh();
        return { ok: false, error: r.message };
      default:
        return { ok: false, error: r.message };
    }
  } catch (error) {
    if (error instanceof AuthorizationError) return { ok: false, error: FORBIDDEN };
    throw error;
  }
}

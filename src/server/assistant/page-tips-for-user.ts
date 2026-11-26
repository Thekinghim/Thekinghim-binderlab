/**
 * Rådgivarens öppna förslag för den inloggade, högst ett per sida (GET /assistent/tips och
 * tipsraden i AI-panelen). Bara läsning. Tomt vid fel, utan organisation och för roller utan
 * förslag (loadAdvisorStateFor avgör rollen).
 */

import "server-only";

import { loadAdvisorStateFor } from "@/server/assistant/advisor/service";
import { getActiveOrganization, requireUser } from "@/server/session";

import { tipsByRoute, type PageTip, type TipRoute } from "./page-tips";

export async function pageTipsForUser(): Promise<Partial<Record<TipRoute, PageTip>>> {
  try {
    const user = await requireUser();
    const organization = await getActiveOrganization();
    if (!organization) return {};
    const state = await loadAdvisorStateFor({ user, organization });
    return state ? tipsByRoute(state.suggestions) : {};
  } catch (error) {
    console.error("[assistent] förslagen kunde inte läsas:", error);
    return {};
  }
}

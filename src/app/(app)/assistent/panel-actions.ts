"use server";

/**
 * Server actions för AI-panelen i skalet (src/components/assistant): om assistenten kan
 * svara just nu (nyckel, månadstak, roll). Rådgivarens förslag per sida: GET /assistent/tips. Bara läsning;
 * frågorna går till POST /assistent/fraga som på sidan Assistent.
 */

import { routeById } from "@/components/shell/nav";
import { budgetState, isDemoBlocked } from "@/server/assistant/advisor/service";
import { getAssistantConfig } from "@/server/assistant/config";
import { budgetLeftShare } from "@/server/assistant/service";
import { loadOptionalContext } from "@/server/data/core";

export interface PanelState {
  /** ready: frågor går att ställa. off: ingen nyckel/fel inställning. budget: taket nått. */
  readonly status: "ready" | "off" | "budget" | "forbidden";
  /** En kort mening när status inte är ready. */
  readonly message: string | null;
  readonly local: boolean;
  /** Andel av månadens budget kvar (0–1) när mindre än 20 % är kvar, annars null. */
  readonly budgetLeft: number | null;
}

export async function assistantPanelState(): Promise<PanelState> {
  const ctx = await loadOptionalContext();
  if (!ctx || !routeById("assistent").roles.includes(ctx.role)) {
    return {
      status: "forbidden",
      message: "Din roll har ingen assistent.",
      local: false,
      budgetLeft: null,
    };
  }
  const config = getAssistantConfig();
  if (config.status !== "ready") {
    return {
      status: "off",
      message:
        config.status === "not-configured" ? "AI är inte påslagen än." : "AI är avstängd just nu.",
      local: false,
      budgetLeft: null,
    };
  }
  if (config.provider === "local") {
    return { status: "ready", message: null, local: true, budgetLeft: null };
  }
  if (isDemoBlocked(ctx.organization.slug, process.env)) {
    return { status: "off", message: "AI är avstängd i demon.", local: false, budgetLeft: null };
  }
  try {
    const budget = await budgetState();
    if (budget.exceeded) {
      return {
        status: "budget",
        message: "Månadens AI-budget är slut. Den fylls på den 1:a.",
        local: false,
        budgetLeft: 0,
      };
    }
    return { status: "ready", message: null, local: false, budgetLeft: budgetLeftShare(budget) };
  } catch (error) {
    console.error("[assistent] AI-budgeten kunde inte läsas:", error);
    return { status: "off", message: "AI svarar inte just nu.", local: false, budgetLeft: null };
  }
}

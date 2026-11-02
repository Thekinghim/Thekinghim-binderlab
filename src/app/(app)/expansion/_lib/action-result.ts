/**
 * Svaret från server actions under Expansion, Enhetsekonomi och Effekt. Fel har ett
 * svenskt meddelande och, för formulär, fel per fält.
 */

import { unstable_rethrow } from "next/navigation";
import { ZodError } from "zod";

import { AuthorizationError } from "@/server/access";
import { dbErrorMessage, pgErrorOf } from "@/server/errors";

import { ExpansionError } from "./service";

export type ActionResult<T = undefined> =
  { ok: true; data: T } | { ok: false; error: string; fieldErrors?: Record<string, string> };

/** Unik nyckel som bryts: vad det betyder i varje tabell. */
const DUPLICATE: Record<string, string> = {
  goals_scope_key: "Det finns redan ett mål för samma månad, mått och omfattning.",
  baselines_scope_key: "Det finns redan ett utgångsläge för samma mått och omfattning.",
  effect_measurements_key: "Det finns redan ett mätvärde för samma månad och mått.",
};

export function failure(
  error: unknown,
  area: string,
): { ok: false; error: string; fieldErrors?: Record<string, string> } {
  // redirect() (utloggad) och andra Next-signaler ska inte bli felmeddelanden.
  unstable_rethrow(error);
  if (error instanceof ZodError) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of error.issues) {
      const key = String(issue.path[0] ?? "");
      if (key && !fieldErrors[key]) fieldErrors[key] = issue.message;
    }
    return {
      ok: false,
      error: error.issues[0]?.message ?? "Ogiltiga uppgifter.",
      fieldErrors,
    };
  }
  if (error instanceof AuthorizationError || error instanceof ExpansionError) {
    return { ok: false, error: error.message };
  }
  const pg = pgErrorOf(error);
  if (pg?.code === "23505") {
    const hit = Object.entries(DUPLICATE).find(([k]) => pg.message.includes(k));
    if (hit) return { ok: false, error: hit[1] };
  }
  console.error(`[${area}]`, error);
  return { ok: false, error: dbErrorMessage(error) };
}

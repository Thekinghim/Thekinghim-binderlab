/**
 * Skapa en organisation för en ny operatör, utan beroende på Next (användaren skickas
 * in). Testas i test/db/onboarding-organisation.test.ts; ./actions.ts kopplar ihop
 * flödet med sessionen och sätter den aktiva organisationen.
 *
 * Organisationen skapas med RPC:n create_organization (ägarmedlemskap, inställningar,
 * centrallager och profil i en transaktion), körd som användaren. Bara den som inte är
 * med i någon organisation och inte har ett butikskonto får skapa en här: andra har
 * redan en väg in, och ett nytt medlemskap kräver annars en inbjudan.
 */

import "server-only";

import { sql } from "drizzle-orm";
import { z } from "zod";

import { listOrganizationsFor, withUserDbFor, type SessionUser } from "@/server/access";
import type { ActionResult } from "@/server/auth/flows";
import { dbErrorMessage, pgErrorOf } from "@/server/errors";
import { queryPortalStores } from "@/server/portal/queries";

export const CREATE_ORGANIZATION_MESSAGES = {
  notLoggedIn: "Du är inte inloggad.",
  nameMissing: "Ange organisationens namn.",
  nameTooLong: "Namnet får vara högst 120 tecken.",
  alreadyMember: "Du är redan med i en organisation. Byt organisation i menyn.",
  storeAccount: "Kontot är ett butikskonto. Logga in med ett annat konto för att skapa en organisation.",
  failed: "Organisationen kunde inte skapas. Försök igen.",
} as const;

const M = CREATE_ORGANIZATION_MESSAGES;

const input = z.object({
  name: z
    .string({ error: M.nameMissing })
    .transform((v) => v.replace(/\s+/g, " ").trim())
    .pipe(z.string().min(2, M.nameMissing).max(120, M.nameTooLong)),
});

const FOLD: Record<string, string> = { å: "a", ä: "a", ö: "o", æ: "ae", ø: "o", ü: "u", ß: "ss" };

/**
 * Kortnamn för organisationen ur namnet: gemener a–z, siffror och bindestreck, högst
 * 48 tecken ("Kortautomater Väst AB" → "kortautomater-vast-ab"). Aldrig tomt.
 */
export function slugFromName(name: string): string {
  const folded = name
    .toLowerCase()
    .replace(/[åäöæøüß]/g, (c) => FOLD[c] ?? c)
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "");
  const slug = folded
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  return slug || "organisation";
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 6).padEnd(4, "0");
}

/**
 * Skapar organisationen med användaren som ägare. Returnerar organisationens id.
 * Kortnamnet görs unikt med ett slumpat tillägg om det redan finns.
 */
export async function createOrganizationFor(
  user: SessionUser | null,
  raw: unknown,
): Promise<ActionResult<{ organizationId: string }>> {
  if (!user) return { ok: false, error: M.notLoggedIn };
  const parsed = input.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? M.nameMissing };
  }
  const name = parsed.data.name;

  if ((await listOrganizationsFor(user)).length > 0) {
    return { ok: false, error: M.alreadyMember };
  }
  if ((await withUserDbFor(user, queryPortalStores)).length > 0) {
    return { ok: false, error: M.storeAccount };
  }

  const base = slugFromName(name);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const slug = attempt === 0 ? base : `${base}-${randomSuffix()}`;
    try {
      const id = await withUserDbFor(user, async (tx) => {
        const result = Array.from(
          await tx.execute(sql`select public.create_organization(${name}, ${slug}) as id`),
        ) as Array<{ id?: unknown }>;
        return result[0]?.id;
      });
      if (typeof id !== "string") return { ok: false, error: M.failed };
      return { ok: true, data: { organizationId: id } };
    } catch (error) {
      // Kortnamnet finns redan: försök igen med ett tillägg.
      if (pgErrorOf(error)?.code === "23505") continue;
      console.error("[onboarding] create_organization misslyckades:", error);
      return { ok: false, error: dbErrorMessage(error, M.failed) };
    }
  }
  return { ok: false, error: M.failed };
}

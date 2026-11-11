"use server";

/**
 * Veckosammanfattningen (notisen på måndag morgon): personens egen knapp på/av.
 * Bara ägare och admin får sammanfattningen, så bara de kan läsa och ändra knappen. Var och
 * en sin egen rad (RLS). Fungerar också i den enkla vyn (knappen ligger i menyn där).
 *
 * - loadWeeklySummarySetting: läget, push-nyckeln och personens påslagna telefoner.
 * - saveWeeklySummarySetting: på eller av.
 */

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { OPERATOR_ROLES, requireContextRole } from "@/server/data/core";
import { pushStatus } from "@/server/notify/push";
import { withUserDb } from "@/server/session";
import { loadWeeklyPref, saveWeeklyPref } from "@/server/weekly/prefs";

export interface WeeklySummarySetting {
  readonly on: boolean;
  /** Publik push-nyckel; null = push går inte att slå på i den här miljön. */
  readonly publicKey: string | null;
  /** Personens påslagna telefoner (push-adresser). */
  readonly endpoints: string[];
}

export async function loadWeeklySummarySetting(): Promise<
  { ok: true; setting: WeeklySummarySetting } | { ok: false; error: string }
> {
  const ctx = await requireContextRole(OPERATOR_ROLES);
  try {
    const [pref, push] = await Promise.all([
      withUserDb((tx) => loadWeeklyPref(tx, ctx.organization.id, ctx.user.id)),
      pushStatus(),
    ]);
    return {
      ok: true,
      setting: {
        on: pref.on,
        publicKey: push.configured ? push.publicKey : null,
        endpoints: pref.endpoints,
      },
    };
  } catch (error) {
    console.error("[vecka] Kunde inte läsa inställningen", error);
    return { ok: false, error: "Det gick inte att läsa. Försök igen." };
  }
}

const saveInput = z.object({ on: z.boolean() }).strict();

export async function saveWeeklySummarySetting(
  input: unknown,
): Promise<{ ok: true; on: boolean } | { ok: false; error: string }> {
  const ctx = await requireContextRole(OPERATOR_ROLES);
  const parsed = saveInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Det gick inte att spara. Försök igen." };
  try {
    await withUserDb((tx) =>
      saveWeeklyPref(
        tx,
        { orgId: ctx.organization.id, userId: ctx.user.id, email: ctx.user.email },
        parsed.data.on,
      ),
    );
  } catch (error) {
    console.error("[vecka] Kunde inte spara inställningen", error);
    return { ok: false, error: "Det gick inte att spara. Försök igen." };
  }
  revalidatePath("/drift/larm");
  return { ok: true, on: parsed.data.on };
}

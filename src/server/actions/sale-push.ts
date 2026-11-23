"use server";

/**
 * Notis vid varje försäljning: personens egen knapp på/av och "Tyst på natten".
 * Bara ägare, admin och läsare (ECONOMY_ROLES, de som får läsa orderna); påfyllaren ser inga
 * enskilda köp och får ingen notis (src/server/sales-push/job.ts). Butiksportalen når inte hit.
 * Var och en sin egen rad (RLS). I en demo skickas aldrig något, så knappen sparas inte.
 */

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { ECONOMY_ROLES, requireContextRole } from "@/server/data/core";
import { DEMO_MESSAGES, isDemoFor } from "@/server/demo/guard";
import { pushStatus } from "@/server/notify/push";
import { loadSalePushPref, saveSalePushPref } from "@/server/sales-push/prefs";
import { withUserDb } from "@/server/session";

export interface SalePushSetting {
  readonly on: boolean;
  readonly quiet: boolean;
  /** Publik push-nyckel; null = push går inte att slå på i den här miljön. */
  readonly publicKey: string | null;
  /** Personens påslagna telefoner (push-adresser). */
  readonly endpoints: string[];
}

export async function loadSalePushSetting(): Promise<
  { ok: true; setting: SalePushSetting } | { ok: false; error: string }
> {
  const ctx = await requireContextRole(ECONOMY_ROLES);
  try {
    const [pref, push] = await Promise.all([
      withUserDb((tx) => loadSalePushPref(tx, ctx.organization.id, ctx.user.id)),
      pushStatus(),
    ]);
    return {
      ok: true,
      setting: {
        on: pref.on,
        quiet: pref.quiet,
        publicKey: push.configured ? push.publicKey : null,
        endpoints: pref.endpoints,
      },
    };
  } catch (error) {
    console.error("[försäljning] Kunde inte läsa inställningen", error);
    return { ok: false, error: "Det gick inte att läsa. Försök igen." };
  }
}

const saveInput = z
  .object({ on: z.boolean().optional(), quiet: z.boolean().optional() })
  .strict()
  .refine((v) => v.on !== undefined || v.quiet !== undefined);

export async function saveSalePushSetting(
  input: unknown,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const ctx = await requireContextRole(ECONOMY_ROLES);
  const parsed = saveInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Det gick inte att spara. Försök igen." };
  if (await isDemoFor({ userId: ctx.user.id, email: ctx.user.email }, ctx.organization.id)) {
    return { ok: false, error: DEMO_MESSAGES.email };
  }
  try {
    await withUserDb((tx) =>
      saveSalePushPref(
        tx,
        { orgId: ctx.organization.id, userId: ctx.user.id, email: ctx.user.email },
        parsed.data,
      ),
    );
  } catch (error) {
    console.error("[försäljning] Kunde inte spara inställningen", error);
    return { ok: false, error: "Det gick inte att spara. Försök igen." };
  }
  revalidatePath("/drift/larm");
  revalidatePath("/");
  return { ok: true };
}

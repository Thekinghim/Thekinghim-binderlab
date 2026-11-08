"use server";

/**
 * Språkväljaren ("Language / Språk"): personen väljer sitt eget språk. Sparas i profilen i
 * alla organisationer personen är med i (RLS: bara den egna profilen, profiles_update) och i
 * språkkakan, så att inloggningen efter utloggning visas på samma språk. Utan inloggning
 * (inloggningssidan) sparas bara kakan.
 */

import { sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";

import { isLocale, LOCALE_COOKIE, LOCALE_COOKIE_MAX_AGE } from "@/i18n/locale";
import { getServerEnv } from "@/lib/env";
import { withUserDbFor } from "@/server/access";
import type { ActionResult } from "@/server/auth/flows";
import { dbErrorMessage } from "@/server/errors";
import { getSessionUser } from "@/server/session";

export async function setMyLocale(raw: unknown): Promise<ActionResult> {
  if (!isLocale(raw)) return { ok: false, error: "Okänt språk." };
  const user = await getSessionUser().catch(() => null);
  if (user) {
    try {
      await withUserDbFor(user, (tx) =>
        tx.execute(
          sql`update public.profiles set locale = ${raw}
              where user_id = (select auth.uid()) and locale <> ${raw}`,
        ),
      );
    } catch (error) {
      return { ok: false, error: dbErrorMessage(error) };
    }
  }
  let secure = true;
  try {
    secure = getServerEnv().APP_ENV !== "development";
  } catch {
    // Felkonfigurerad miljö: kakan blir säker.
  }
  (await cookies()).set(LOCALE_COOKIE, raw, {
    path: "/",
    maxAge: LOCALE_COOKIE_MAX_AGE,
    sameSite: "lax",
    secure,
    httpOnly: false,
  });
  revalidatePath("/", "layout");
  return { ok: true };
}

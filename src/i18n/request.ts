/**
 * Språket i förfrågan utan inloggning: kakan LOCALE_COOKIE, annars Accept-Language. För
 * rotlayoutens <html lang> och sidorna före inloggningen. Läser ingen databas.
 */

import "server-only";

import { cookies, headers } from "next/headers";
import { cache } from "react";

import { DEFAULT_LOCALE, isLocale, LOCALE_COOKIE, requestLocale, type Locale } from "./locale";

export const getRequestLocale = cache(async (): Promise<Locale> => {
  try {
    const [jar, h] = await Promise.all([cookies(), headers()]);
    return requestLocale(jar.get(LOCALE_COOKIE)?.value, h.get("accept-language"));
  } catch {
    return DEFAULT_LOCALE;
  }
});

/** Språket i kakan, eller null om personen inte valt något i den här webbläsaren. */
export const getCookieLocale = cache(async (): Promise<Locale | null> => {
  try {
    const value = (await cookies()).get(LOCALE_COOKIE)?.value;
    return isLocale(value) ? value : null;
  } catch {
    return null;
  }
});

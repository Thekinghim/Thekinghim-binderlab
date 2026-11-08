/**
 * Språket på servern.
 *
 * - getLocale(): den inloggades språk (profiles.locale i den aktiva organisationen, läst i
 *   kontexten utan en extra fråga), annars getRequestLocale() (kakan, Accept-Language).
 * - getT(): katalogen och formateringen för getLocale() (eller ett givet språk).
 */

import "server-only";

import { loadOptionalContextIfSignedIn } from "@/server/data/core";

import { formatters, type Formatters } from "./format";
import { messages } from "./index";
import type { Locale } from "./locale";
import { getRequestLocale } from "./request";
import type { Messages } from "./sv";

export { getRequestLocale } from "./request";

export async function getLocale(): Promise<Locale> {
  const ctx = await loadOptionalContextIfSignedIn();
  return ctx?.locale ?? getRequestLocale();
}

export async function getT(locale?: Locale): Promise<{
  locale: Locale;
  t: Messages;
  f: Formatters;
}> {
  const l = locale ?? (await getLocale());
  return { locale: l, t: messages(l), f: formatters(l) };
}

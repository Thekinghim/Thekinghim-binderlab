/**
 * Språk i appen. Rent och klientsäkert.
 *
 * Varje person väljer svenska eller engelska för hela appen (profiles.locale). Före
 * inloggningen (inloggning, inbjudan) gäller kakan LOCALE_COOKIE och annars webbläsarens
 * Accept-Language. Butiksriktade dokument (rapporter, PDF:er, avtal, mejl till butiker)
 * är alltid på svenska och går aldrig via det här.
 */

export const LOCALES = ["sv", "en"] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "sv";

/** Kakan med senast använda språk (inte hemlig; bara för sidorna före inloggningen). */
export const LOCALE_COOKIE = "bl_lang";

/** Ett år. */
export const LOCALE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (LOCALES as readonly string[]).includes(value);
}

/** Språkets namn på det egna språket (för språkväljaren). */
export const LOCALE_NAME: Record<Locale, string> = { sv: "Svenska", en: "English" };

/** Intl-språket för tal och datum: svenska som i resten av appen, engelska med brittisk gruppering. */
export const INTL_LOCALE: Record<Locale, string> = { sv: "sv-SE", en: "en-GB" };

/**
 * Språket ur en Accept-Language-header: det första av sv/en i webbläsarens ordning (med
 * q-värden). Annat (eller ingen header) ger svenska.
 */
export function localeFromAcceptLanguage(header: string | null | undefined): Locale {
  if (!header) return DEFAULT_LOCALE;
  const ranked = header
    .split(",")
    .map((part, index) => {
      const [tag = "", ...params] = part.trim().split(";");
      const q = params
        .map((p) => p.trim())
        .find((p) => p.startsWith("q="))
        ?.slice(2);
      const quality = q === undefined ? 1 : Number(q);
      return {
        lang: tag.trim().toLowerCase().split("-")[0] ?? "",
        q: Number.isFinite(quality) ? quality : 0,
        index,
      };
    })
    .filter((x) => x.lang && x.q > 0)
    .sort((a, b) => b.q - a.q || a.index - b.index);
  for (const r of ranked) {
    if (r.lang === "sv") return "sv";
    if (r.lang === "en") return "en";
  }
  return DEFAULT_LOCALE;
}

/** Kakans värde, annars webbläsarens språk. */
export function requestLocale(
  cookie: string | null | undefined,
  acceptLanguage: string | null | undefined,
): Locale {
  return isLocale(cookie) ? cookie : localeFromAcceptLanguage(acceptLanguage);
}

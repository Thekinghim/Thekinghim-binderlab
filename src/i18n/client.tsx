"use client";

/**
 * Språket i klientkomponenter: LocaleProvider (sätts av skalet med personens språk) och
 * useT()/useLocale()/useFormat(). Utan provider: svenska, så att komponenter som ännu inte
 * har en provider ovanför sig fungerar som förut.
 */

import { createContext, useContext, useEffect, type ReactNode } from "react";

import { formatters, type Formatters } from "./format";
import { messages } from "./index";
import { DEFAULT_LOCALE, LOCALE_COOKIE, LOCALE_COOKIE_MAX_AGE, type Locale } from "./locale";
import type { Messages } from "./sv";

const LocaleContext = createContext<Locale>(DEFAULT_LOCALE);

export function LocaleProvider({ locale, children }: { locale: Locale; children: ReactNode }) {
  return <LocaleContext.Provider value={locale}>{children}</LocaleContext.Provider>;
}

export function useLocale(): Locale {
  return useContext(LocaleContext);
}

export function useT(): Messages {
  return messages(useLocale());
}

export function useFormat(): Formatters {
  return formatters(useLocale());
}

/**
 * Håller <html lang> och språkkakan i takt med personens språk (profilen), så att
 * inloggningssidan efter utloggning visas på samma språk. Rotlayouten läser bara kakan.
 */
export function LocaleSync({ locale }: { locale: Locale }) {
  useEffect(() => {
    document.documentElement.lang = locale;
    const current = document.cookie
      .split("; ")
      .find((c) => c.startsWith(`${LOCALE_COOKIE}=`))
      ?.slice(LOCALE_COOKIE.length + 1);
    if (current !== locale) {
      const secure = window.location.protocol === "https:" ? "; Secure" : "";
      document.cookie = `${LOCALE_COOKIE}=${locale}; Path=/; Max-Age=${LOCALE_COOKIE_MAX_AGE}; SameSite=Lax${secure}`;
    }
  }, [locale]);
  return null;
}

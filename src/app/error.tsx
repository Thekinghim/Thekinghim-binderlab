"use client";

import Link from "next/link";
import { useState } from "react";

import { V2Logo } from "@/components/v2/shell/nav-icon";
import { LocaleProvider } from "@/i18n/client";
import { isLocale, type Locale } from "@/i18n/locale";

import { RouteError, type RouteErrorProps } from "./_fel/route-error";
import "./logga-in/auth.css";

/**
 * Felgränsen under rotlayouten. Fångar fel i skalet (`(app)/layout.tsx`, t.ex. när
 * databasen inte svarar), i inloggningen, inbjudan och rapporterna. Skalet finns inte
 * här, så sidan har samma V2-ram som inloggningen och 404-sidan: loggan överst och felet
 * i ett vitt kort mitt på den grå ytan (data-ui="v2", bara ljust läge).
 */
export default function Error(props: RouteErrorProps) {
  // Utanför skalet (ingen LocaleProvider): språket i <html lang> (kakan, se rotlayouten).
  const [locale] = useState<Locale>(() => {
    const lang = typeof document === "undefined" ? null : document.documentElement.lang;
    return isLocale(lang) ? lang : "sv";
  });
  return (
    <LocaleProvider locale={locale}>
      <div lang={locale} data-ui="v2" className="v2-auth">
        <header className="v2-auth-top">
          <Link href="/" className="v2-auth-brand" aria-label="Binderlab, till startsidan">
            <V2Logo size={28} />
            Binderlab
          </Link>
        </header>
        <main id="main" className="v2-auth-main">
          <div className="v2-enter flex w-full justify-center">
            <RouteError {...props} />
          </div>
        </main>
        <footer className="v2-auth-foot" />
      </div>
    </LocaleProvider>
  );
}

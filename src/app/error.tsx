"use client";

import Link from "next/link";
import { useState } from "react";

import { Wordmark } from "@/components/brand/wordmark";
import { ThemeToggle } from "@/components/shell/theme-toggle";
import { LocaleProvider } from "@/i18n/client";
import { isLocale, type Locale } from "@/i18n/locale";

import { RouteError, type RouteErrorProps } from "./_fel/route-error";

/**
 * Felgränsen under rotlayouten. Fångar fel i skalet (`(app)/layout.tsx`, t.ex. när
 * databasen inte svarar), i inloggningen, inbjudan och rapporterna. Skalet finns inte
 * här, så sidan har samma enkla ram som inloggningen: ordmärke, temaknapp och felet.
 */
export default function Error(props: RouteErrorProps) {
  // Utanför skalet (ingen LocaleProvider): språket i <html lang> (kakan, se rotlayouten).
  const [locale] = useState<Locale>(() => {
    const lang = typeof document === "undefined" ? null : document.documentElement.lang;
    return isLocale(lang) ? lang : "sv";
  });
  return (
    <LocaleProvider locale={locale}>
      <div className="min-h-dvh overflow-x-clip bg-bg">
        <div className="mx-auto flex min-h-dvh w-full max-w-[1280px] flex-col px-4 md:px-8">
          <header className="flex h-16 items-center justify-between">
            <Link href="/" className="rounded-xs">
              <Wordmark size="md" />
            </Link>
            <ThemeToggle />
          </header>
          <main id="main" className="flex flex-1 flex-col pt-16 pb-16 md:pt-32">
            <div className="w-full max-w-2xl md:ml-16">
              <RouteError {...props} />
            </div>
          </main>
        </div>
      </div>
    </LocaleProvider>
  );
}

"use client";

import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";
import { useEffect } from "react";

import { THEME_STORAGE_KEY } from "@/lib/theme";

import { RouteError, type RouteErrorProps } from "./_fel/route-error";
import "./globals.css";

/**
 * Sista felgränsen: ersätter rotlayouten när den själv inte kan renderas. Har därför egna
 * `<html>` och `<body>`, typsnitt och stilmall, och läser temat ur localStorage själv.
 */
export default function GlobalError(props: RouteErrorProps) {
  useEffect(() => {
    try {
      const t = localStorage.getItem(THEME_STORAGE_KEY);
      if (t === "light" || t === "dark") document.documentElement.dataset.theme = t;
    } catch {
      // Utan lagring står det mörka läget kvar.
    }
  }, []);
  return (
    <html
      lang="sv"
      data-theme="dark"
      className={`${GeistSans.variable} ${GeistMono.variable}`}
      suppressHydrationWarning
    >
      <body>
        <title>Fel · Binderlab</title>
        <main className="mx-auto min-h-dvh w-full max-w-[1280px] bg-bg px-4 pt-16 pb-16 md:px-8 md:pt-32">
          <div className="w-full max-w-2xl md:ml-16">
            <RouteError {...props} homeHref={null} />
          </div>
        </main>
      </body>
    </html>
  );
}

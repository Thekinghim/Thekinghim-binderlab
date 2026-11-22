"use client";

import { Google_Sans } from "next/font/google";
import Link from "next/link";

import { V2Logo } from "@/components/v2/shell/nav-icon";

import { RouteError, type RouteErrorProps } from "./_fel/route-error";
import "./globals.css";
import "./logga-in/auth.css";

/** Samma typsnitt som rotlayouten (V2: Google Sans); rotlayouten finns inte här. */
const googleSans = Google_Sans({
  subsets: ["latin", "latin-ext"],
  weight: "variable",
  display: "swap",
  variable: "--font-google-sans",
  adjustFontFallback: false,
});

/**
 * Sista felgränsen: ersätter rotlayouten när den själv inte kan renderas. Har därför egna
 * `<html>` och `<body>`, typsnitt och stilmall. V2 som app/error.tsx: loggan överst och felet
 * i ett vitt kort på den grå ytan, bara ljust läge (data-ui="v2").
 */
export default function GlobalError(props: RouteErrorProps) {
  return (
    <html lang="sv" data-theme="light" className={googleSans.variable} suppressHydrationWarning>
      <body>
        <title>Fel · Binderlab</title>
        <div data-ui="v2" className="v2-auth">
          <header className="v2-auth-top">
            <Link href="/" className="v2-auth-brand" aria-label="Binderlab, till startsidan">
              <V2Logo size={28} />
              Binderlab
            </Link>
          </header>
          <main id="main" className="v2-auth-main">
            <div className="flex w-full justify-center">
              <RouteError {...props} homeHref={null} />
            </div>
          </main>
          <footer className="v2-auth-foot" />
        </div>
      </body>
    </html>
  );
}

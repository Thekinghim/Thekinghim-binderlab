import type { Metadata, Viewport } from "next";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import { cookies } from "next/headers";
import { ThemeSync } from "@/components/shell/theme-sync";
import { ToastProvider } from "@/components/ui/toast";
import { THEME_COOKIE, themeFromCookie } from "@/lib/theme";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Binderlab", template: "%s · Binderlab" },
  description: "Kontrollpanel för varuautomater med samlarkort.",
  // Installerad på iPhone (Safari → Dela → Lägg till på hemskärmen): egen app utan
  // webbläsarens ramar. Statusraden följer theme-color (temat nedan).
  appleWebApp: { capable: true, title: "Binderlab", statusBarStyle: "default" },
  formatDetection: { telephone: false },
  // Next skriver bara "mobile-web-app-capable"; äldre iOS läser den med apple-prefix.
  other: { "apple-mobile-web-app-capable": "yes" },
};

/** Webbläsarens färg (adressfältet på mobilen) följer temat: --bl-bg i src/styles/tokens.css. */
export async function generateViewport(): Promise<Viewport> {
  const theme = themeFromCookie((await cookies()).get(THEME_COOKIE)?.value);
  return {
    themeColor: theme === "light" ? "#f4f3ef" : "#0a0a0b",
    width: "device-width",
    initialScale: 1,
    // Hela skärmen på iPhone med notch och hemindikator; sidorna lägger till
    // env(safe-area-inset-*) där det behövs (bottenmenyn, Fyll på).
    viewportFit: "cover",
  };
}

/**
 * Temat renderas på servern ur cookien (src/lib/theme.ts): rätt `data-theme` redan i
 * första HTML-svaret, utan inline-skript. Det gör alla sidor dynamiska, vilket de
 * inloggade sidorna redan är.
 */
export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const theme = themeFromCookie((await cookies()).get(THEME_COOKIE)?.value);
  return (
    <html
      lang="sv"
      data-theme={theme}
      className={`${GeistSans.variable} ${GeistMono.variable}`}
      suppressHydrationWarning
    >
      <body>
        <ThemeSync />
        <ToastProvider>{children}</ToastProvider>
      </body>
    </html>
  );
}

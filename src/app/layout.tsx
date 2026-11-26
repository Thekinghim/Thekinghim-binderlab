import type { Metadata, Viewport } from "next";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import { Google_Sans, Google_Sans_Code } from "next/font/google";
import { cookies } from "next/headers";
import { ThemeSync } from "@/components/shell/theme-sync";
import { ViewportPin } from "@/components/v2/shell/viewport-pin-mount";
import { ToastProvider } from "@/components/ui/toast";
import { getRequestLocale } from "@/i18n/request";
import { THEME_COOKIE, themeColorFromCookie, themeFromCookie } from "@/lib/theme";
import "./globals.css";

/**
 * V2-typsnitten (src/styles/v2.css): Google Sans för allt i V2-skalet, Google Sans Code bara
 * för tangenten Ctrl K. Geist står kvar för de orörda delarna (portal, rapporter, inloggning).
 */
const googleSans = Google_Sans({
  subsets: ["latin", "latin-ext"],
  weight: "variable",
  display: "swap",
  variable: "--font-google-sans",
  // Next har inga mått för Google Sans (varning vid varje sida). Reservtypsnittet med uppmätta
  // mått står i src/styles/v2.css ("V2 Google Sans Fallback") och ligger i --v2-sans.
  adjustFontFallback: false,
});
const googleSansCode = Google_Sans_Code({
  subsets: ["latin"],
  weight: ["400", "500"],
  display: "swap",
  variable: "--font-google-sans-code",
  adjustFontFallback: false,
  preload: false,
});

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

/**
 * Webbläsarens färg (adressfältet på mobilen): ljust som standard (src/lib/theme.ts), mörkt
 * bara för den som valt mörkt. Layouterna under kan sätta en egen (appen, portalen).
 */
export async function generateViewport(): Promise<Viewport> {
  return {
    themeColor: themeColorFromCookie((await cookies()).get(THEME_COOKIE)?.value),
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
  const [jar, locale] = await Promise.all([cookies(), getRequestLocale()]);
  const theme = themeFromCookie(jar.get(THEME_COOKIE)?.value);
  // Språket ur kakan (eller webbläsaren). Inloggade: skalet håller kakan och lang i takt med
  // profilen (LocaleSync), så att nästa förfrågan redan har rätt språk.
  return (
    <html
      lang={locale}
      data-theme={theme}
      className={`${GeistSans.variable} ${GeistMono.variable} ${googleSans.variable} ${googleSansCode.variable}`}
      suppressHydrationWarning
    >
      <body>
        <ThemeSync />
        <ViewportPin />
        <ToastProvider locale={locale}>{children}</ToastProvider>
      </body>
    </html>
  );
}

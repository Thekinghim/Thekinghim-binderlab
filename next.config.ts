import { withSentryConfig } from "@sentry/nextjs/config";
import type { NextConfig } from "next";

import { APP_REDIRECTS } from "./src/lib/redirects";
import { securityHeaderRules } from "./src/lib/security-headers";

/**
 * Största fil som laddas upp med en server action: avtalsfiler (20 MB) plus
 * formulärdata. Importen laddar upp i bitar om 768 KiB och berörs inte.
 * OBS: Vercel Functions tar emot högst 4,5 MB per förfrågan oavsett detta.
 */
const MAX_ACTION_BODY = "21mb";

const nextConfig: NextConfig = {
  // Egen byggmapp per utvecklingsserver (NEXT_DIST_DIR), så att flera kan köra i samma träd.
  ...(process.env.NEXT_DIST_DIR ? { distDir: process.env.NEXT_DIST_DIR } : {}),
  reactStrictMode: true,
  // Avslöja inte ramverket i varje svar.
  poweredByHeader: false,
  // Ingen dev-indikator ("N") över sidan: demon körs med next dev (dev-inloggningen spärras
  // i next start), och indikatorn täckte användarnamnet i sidomenyn och Hem i mobilmenyn.
  // Kompilerings- och körfel visas ändå.
  devIndicators: false,
  // PDF på Vercel: @sparticuz/chromium läser sin packade Chromium ur node_modules/…/bin
  // vid körning. Paketet får därför inte buntas, och bin/ måste följa med till de
  // funktioner som skapar PDF (rapporter, avräkningar, avtal, bokföring, portalen, cron).
  serverExternalPackages: ["@sparticuz/chromium", "puppeteer-core"],
  outputFileTracingIncludes: Object.fromEntries(
    [
      "/rapport/**",
      "/butiker/**",
      "/portal/**",
      "/avtal/**",
      "/ekonomi/**",
      "/signera/**",
      "/api/cron/**",
    ].map((route) => [route, ["./node_modules/@sparticuz/chromium/bin/**"]]),
  ),
  experimental: {
    serverActions: { bodySizeLimit: MAX_ACTION_BODY },
    // Proxyn buffrar förfrågans kropp; standard 10 MB skulle klippa avtalsfiler.
    proxyClientMaxBodySize: MAX_ACTION_BODY,
  },
  // CSP, inramningsförbud, nosniff, Referrer-Policy m.fl. (src/lib/security-headers.ts).
  async headers() {
    return securityHeaderRules({
      dev: process.env.NODE_ENV === "development",
      sentryDsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
    });
  },
  // Adresser som bara pekar vidare (/kontrakt → /avtal), utan att rendera en sida.
  async redirects() {
    return [...APP_REDIRECTS];
  },
  // Bygget typkontrollerar bara appens kod. Tester och skript kontrolleras av
  // npm run typecheck (tsconfig.json) i CI, så att ett halvfärdigt test aldrig
  // stoppar en driftsättning men ändå stoppar en sammanslagning.
  typescript: { tsconfigPath: "tsconfig.build.json" },
  // Miljön (development/preview/production) behövs i webbläsaren för Sentry.
  env: {
    NEXT_PUBLIC_APP_ENV: process.env.APP_ENV ?? "development",
  },
};

// Sentry-bygget (källkartor och release) bara när en token finns, t.ex. på Vercel.
// Utan token körs Sentry ändå i drift om SENTRY_DSN/NEXT_PUBLIC_SENTRY_DSN är satta.
export default process.env.SENTRY_AUTH_TOKEN
  ? withSentryConfig(nextConfig, {
      org: process.env.SENTRY_ORG,
      project: process.env.SENTRY_PROJECT,
      authToken: process.env.SENTRY_AUTH_TOKEN,
      silent: !process.env.CI,
      telemetry: false,
      widenClientFileUpload: true,
    })
  : nextConfig;

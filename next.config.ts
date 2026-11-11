import { execSync } from "node:child_process";

import { withSentryConfig } from "@sentry/nextjs/config";
import type { NextConfig } from "next";

import { APP_REDIRECTS } from "./src/lib/redirects";
import { APP_REWRITES } from "./src/lib/rewrites";
import { securityHeaderRules } from "./src/lib/security-headers";

/**
 * Största fil som laddas upp med en server action: avtalsfiler (20 MB) plus
 * formulärdata. Importen laddar upp i bitar om 768 KiB och berörs inte.
 * OBS: Vercel Functions tar emot högst 4,5 MB per förfrågan oavsett detta.
 */
const MAX_ACTION_BODY = "21mb";

/**
 * Byggets id (src/lib/build-id.ts): telefonen jämför det med serverns (/api/version) och
 * visar "Ny version av appen finns" efter en driftsättning. På Vercel driftsättningens id
 * (nytt vid varje driftsättning), annars incheckningen, git eller "lokal". Samma värde i
 * alla byggprocesser (ingen tidsstämpel), så att sidan och servern alltid är överens.
 */
function buildId(): string {
  const fromVercel = process.env.VERCEL_DEPLOYMENT_ID || process.env.VERCEL_GIT_COMMIT_SHA;
  if (fromVercel) return fromVercel.slice(0, 80);
  try {
    const sha = execSync("git rev-parse --short=12 HEAD", {
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
    if (/^[0-9a-f]{4,40}$/.test(sha)) return sha;
  } catch {
    // Ingen git (t.ex. e2e-kopian): ett fast id räcker lokalt.
  }
  return "lokal";
}

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
  // Adresser som visar en annan sidas rutt (/fyll-pa/<automat> → /fyll-pa), före filsystemet
  // så att de går före den dynamiska rutten (src/lib/rewrites.ts).
  async rewrites() {
    return { beforeFiles: [...APP_REWRITES], afterFiles: [], fallback: [] };
  },
  // Bygget typkontrollerar bara appens kod. Tester och skript kontrolleras av
  // npm run typecheck (tsconfig.json) i CI, så att ett halvfärdigt test aldrig
  // stoppar en driftsättning men ändå stoppar en sammanslagning.
  typescript: { tsconfigPath: "tsconfig.build.json" },
  // Miljön (development/preview/production) behövs i webbläsaren för Sentry, byggets id
  // för "Ny version av appen finns".
  env: {
    NEXT_PUBLIC_APP_ENV: process.env.APP_ENV ?? "development",
    NEXT_PUBLIC_BUILD_ID: buildId(),
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

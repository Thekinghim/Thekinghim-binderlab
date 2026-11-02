import { withSentryConfig } from "@sentry/nextjs/config";
import type { NextConfig } from "next";

import { securityHeaderRules } from "./src/lib/security-headers";

/**
 * Största fil som laddas upp med en server action: avtalsfiler (20 MB) plus
 * formulärdata. Importen laddar upp i bitar om 768 KiB och berörs inte.
 * OBS: Vercel Functions tar emot högst 4,5 MB per förfrågan oavsett detta.
 */
const MAX_ACTION_BODY = "21mb";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Avslöja inte ramverket i varje svar.
  poweredByHeader: false,
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

import { withSentryConfig } from "@sentry/nextjs/config";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
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

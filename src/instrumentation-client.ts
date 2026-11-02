/**
 * Sentry i webbläsaren. Startas bara när NEXT_PUBLIC_SENTRY_DSN finns.
 * NEXT_PUBLIC_APP_ENV sätts från APP_ENV i next.config.ts.
 */

import * as Sentry from "@sentry/nextjs";

import { sentryOptions } from "./server/observability/sentry-options";

const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;

if (dsn) {
  Sentry.init(
    sentryOptions({ dsn, environment: process.env.NEXT_PUBLIC_APP_ENV ?? "development" }),
  );
}

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;

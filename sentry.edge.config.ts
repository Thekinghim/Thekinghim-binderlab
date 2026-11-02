// Sentry i edge-miljön. Laddas från src/instrumentation.ts. Startas bara när SENTRY_DSN finns.
import * as Sentry from "@sentry/nextjs";

import { sentryOptions } from "./src/server/observability/sentry-options";

const dsn = process.env.SENTRY_DSN;

if (dsn) {
  Sentry.init(sentryOptions({ dsn, environment: process.env.APP_ENV ?? "development" }));
}

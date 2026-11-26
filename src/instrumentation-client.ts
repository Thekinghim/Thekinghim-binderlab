/**
 * Sentry i webbläsaren. Startas bara när NEXT_PUBLIC_SENTRY_DSN finns.
 * NEXT_PUBLIC_APP_ENV sätts från APP_ENV i next.config.ts.
 *
 * Sentry hämtas med en dynamisk import: paketet ligger då i en egen del som laddas efter
 * sidan och fördröjer aldrig appens start. Utan DSN tas importen bort vid bygget (värdet
 * skrivs in i koden), och ingenting av Sentry hämtas.
 */

import type * as SentryNext from "@sentry/nextjs";

type SentryClient = typeof SentryNext;

const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;

let sentry: SentryClient | null = null;

if (dsn) {
  void Promise.all([import("@sentry/nextjs"), import("./server/observability/sentry-options")])
    .then(([client, { sentryOptions }]) => {
      client.init(
        sentryOptions({ dsn, environment: process.env.NEXT_PUBLIC_APP_ENV ?? "development" }),
      );
      sentry = client;
    })
    .catch(() => {
      // Utan Sentry fungerar appen som vanligt.
    });
}

/** Sidbyten som spårning (först när Sentry har laddats; byten innan dess räknas inte). */
export function onRouterTransitionStart(
  ...args: Parameters<SentryClient["captureRouterTransitionStart"]>
): void {
  sentry?.captureRouterTransitionStart(...args);
}

/**
 * Serverstart (Next instrumentation). Ligger i src/ eftersom projektet har
 * src/app (Next letar bara här då).
 *
 * 1. Kontrollerar miljövariablerna och dev-inloggningens spärr.
 * 2. Startar Sentry (bara om SENTRY_DSN finns).
 */

import * as Sentry from "@sentry/nextjs";

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { verifyServerStartup } = await import("./server/startup");
    verifyServerStartup();
    await import("../sentry.server.config");
  }
  if (process.env.NEXT_RUNTIME === "edge") {
    await import("../sentry.edge.config");
  }
}

export const onRequestError = Sentry.captureRequestError;

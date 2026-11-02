/**
 * Sentry för driftfel som fångas i koden (misslyckad import, rapport eller schemalagt jobb).
 *
 * Fel som kastas ut ur en route handler eller serverkomponent fångas redan av
 * `onRequestError` (src/instrumentation.ts). Fel som koden själv fångar och visar som ett
 * svenskt meddelande når inte dit, och skickas därför härifrån.
 *
 * Sentry laddas bara när `SENTRY_DSN` finns (då har sentry.server.config.ts startat SDK:n);
 * annars görs ingenting. `beforeSend` (src/server/observability/sentry-options.ts) tar bort
 * e-postadresser och hemligheter innan något skickas.
 */

import "server-only";

/** Det som skickas till Sentry för ett driftfel. Inga personuppgifter i taggar eller extra. */
export interface FailureEvent {
  /** Felet som fångades, eller null när det inte finns något (t.ex. mottagare som studsade). */
  readonly error: unknown;
  /** Kort beskrivning på svenska; används som meddelande när `error` saknas. */
  readonly message: string;
  /** Sökbara taggar i Sentry, t.ex. area=import, kind=import_failed, organization_id=… */
  readonly tags: Readonly<Record<string, string>>;
  /** Mer underlag (id:n och antal). */
  readonly extra?: Readonly<Record<string, string | number | boolean | null>>;
  /** Grupperar händelserna: samma problem blir ett ärende i Sentry. */
  readonly fingerprint: readonly string[];
}

/** Skickar en händelse. Returnerar Sentrys id, eller null när inget skickades. */
export type FailureCapture = (event: FailureEvent) => Promise<string | null>;

/** Sant när Sentry är påslaget i den här processen (SENTRY_DSN finns). */
export function sentryEnabled(env: Readonly<Record<string, string | undefined>> = process.env) {
  return Boolean(env.SENTRY_DSN?.trim());
}

/** Standard: @sentry/nextjs när SENTRY_DSN finns, annars ingenting. Kastar aldrig. */
export const captureToSentry: FailureCapture = async (event) => {
  if (!sentryEnabled()) return null;
  try {
    const Sentry = await import("@sentry/nextjs");
    const context = {
      level: "error" as const,
      tags: { ...event.tags },
      extra: { ...event.extra, beskrivning: event.message },
      fingerprint: [...event.fingerprint],
    };
    return event.error instanceof Error
      ? Sentry.captureException(event.error, context)
      : Sentry.captureMessage(event.message, context);
  } catch (error) {
    console.error("[monitoring] Kunde inte skicka till Sentry", error);
    return null;
  }
};

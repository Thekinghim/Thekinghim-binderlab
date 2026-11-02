/**
 * Sentry för driftfel som fångas i koden (misslyckad import, rapport eller schemalagt jobb).
 *
 * Fel som kastas ut ur en route handler eller serverkomponent fångas redan av
 * `onRequestError` (src/instrumentation.ts). Fel som koden själv fångar och visar som ett
 * svenskt meddelande når inte dit, och skickas därför härifrån.
 *
 * Sentry laddas bara när `SENTRY_DSN` finns (då har sentry.server.config.ts startat SDK:n);
 * annars görs ingenting. `beforeSend` (src/server/observability/sentry-options.ts) tar bort
 * e-postadresser och hemligheter innan något skickas; meddelandet och extra tvättas dessutom
 * här. Efter varje händelse väntar vi (högst 2 s) på att den skickas: på Vercel fryses
 * funktionen när svaret är skickat, och en händelse i kön går då förlorad.
 */

import "server-only";

import { scrubString } from "@/server/observability/sentry-options";

/** Hur länge ett fångat fel får vänta på att skickas (serverlösa funktioner fryses efteråt). */
const FLUSH_MS = 2_000;

function scrubExtra(
  extra: Readonly<Record<string, string | number | boolean | null>> | undefined,
): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {};
  for (const [k, v] of Object.entries(extra ?? {}))
    out[k] = typeof v === "string" ? scrubString(v) : v;
  return out;
}

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
    const message = scrubString(event.message);
    const context = {
      level: "error" as const,
      tags: { ...event.tags },
      extra: { ...scrubExtra(event.extra), beskrivning: message },
      fingerprint: [...event.fingerprint],
    };
    const id =
      event.error instanceof Error
        ? Sentry.captureException(event.error, context)
        : Sentry.captureMessage(message, context);
    await Sentry.flush(FLUSH_MS);
    return id;
  } catch (error) {
    console.error("[monitoring] Kunde inte skicka till Sentry", error);
    return null;
  }
};

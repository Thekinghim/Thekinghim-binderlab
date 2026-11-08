/**
 * Vilket bygge av appen som körs ("build id"). Sätts vid bygget i next.config.ts
 * (NEXT_PUBLIC_BUILD_ID: Vercels driftsättning eller incheckning, annars git eller "lokal").
 *
 * Telefonen jämför byggets id i sidan den visar med det som servern kör nu (/api/version).
 * Skiljer de sig har en ny version driftsatts och appen visar "Ny version av appen finns"
 * (src/components/pwa/app-update.tsx).
 */

/** Byggets id, inbakat vid bygget. */
export const BUILD_ID: string = process.env.NEXT_PUBLIC_BUILD_ID || "lokal";

/**
 * Kaka som e2e-testerna sätter för att låtsas att ett nytt bygge har driftsatts. Läses
 * BARA av next dev (NODE_ENV development) och aldrig när APP_ENV är production.
 */
export const TEST_BUILD_COOKIE = "binderlab-test-build";

const ID = /^[A-Za-z0-9._-]{1,80}$/;

/** Ett giltigt byggid: kort, bara bokstäver, siffror och . _ -. */
export function isBuildId(value: unknown): value is string {
  return typeof value === "string" && ID.test(value);
}

/**
 * Byggets id som servern svarar med. Testkakan räknas bara i utvecklingsläget (next dev)
 * och aldrig i drift, så att ingen kan få appen att tro att en ny version finns.
 */
export function resolveBuildId({
  baked,
  testOverride,
  nodeEnv,
  appEnv,
}: {
  baked: string;
  testOverride?: string | null;
  nodeEnv: string | undefined;
  appEnv: string | undefined;
}): string {
  if (
    nodeEnv === "development" &&
    appEnv !== "production" &&
    appEnv !== "preview" &&
    isBuildId(testOverride)
  ) {
    return testOverride;
  }
  return baked;
}

/**
 * "Om Awish krånglar" i Datakällor: en rad per Awish-väg (public.awish_path_health) på enkel
 * svenska. Rent (testas i awish-health.test.ts); laddas av ./awish-health-load.ts.
 *
 *   Fungerar                         Open API (eller webbpanelen för det som bara finns där)
 *   Reservväg: webbpanelen            Open API svarar inte, webbpanelen gör det
 *   Senast kända 14:52               ingen väg nu, Binderlab visar senaste datan
 *   Fungerar inte sedan 14:52         ingen väg och ingen data att visa
 *
 * Under raden: senaste felet ("Senaste fel 03:05: Awish internt fel (13)").
 */

import {
  AWISH_PATH_LABEL,
  awishErrorText,
  type AwishPathFacts,
  type AwishPathName,
  type WhenText,
} from "@/analytics/watch";

export type AwishHealthState = "ok" | "fallback" | "stale" | "broken";

export interface AwishHealthRowView {
  readonly key: string;
  readonly path: AwishPathName;
  readonly label: string;
  readonly state: AwishHealthState;
  /** "Fungerar · 14:52", "Reservväg: webbpanelen", "Senast kända 14:52", … */
  readonly text: string;
  /** "Senaste fel 03:05: Awish internt fel (13)", eller null. */
  readonly error: string | null;
}

/** Vägarna i den ordning ägaren läser dem (det viktigaste först). */
const ORDER: readonly AwishPathName[] = [
  "orders",
  "stock",
  "machines",
  "push",
  "slots",
  "goods",
  "merchant",
  "campaigns",
  "free_packs",
];

/** Vägar där webbpanelen ÄR den vanliga vägen (inte en reserv). */
const WEB_NATIVE: ReadonlySet<AwishPathName> = new Set(["push", "goods", "slots"]);

/** Vägar som visar senaste datan när ingen väg fungerar (lager, automater, försäljning). */
const KEEPS_LAST: ReadonlySet<AwishPathName> = new Set(["orders", "stock", "machines"]);

export function awishHealthRow(p: AwishPathFacts, when: WhenText): AwishHealthRowView {
  const label = AWISH_PATH_LABEL[p.path];
  const key = `${p.sourceId}:${p.path}`;
  const errorDetail = p.lastErrorKind
    ? `${awishErrorText(p.lastErrorKind, p.lastErrorCode)}${p.lastErrorCode !== null ? ` (${p.lastErrorCode})` : ""}`
    : null;
  const failing = p.failingSince !== null;
  // Felet visas när vägen inte fungerar som vanligt, eller felet är nyare än senaste lyckade.
  const showError =
    errorDetail !== null &&
    p.lastErrorAt !== null &&
    (failing ||
      (p.activeRoute === "webbpanelen" && !WEB_NATIVE.has(p.path)) ||
      p.lastSuccessAt === null ||
      p.lastErrorAt > p.lastSuccessAt);
  const error = showError ? `Senaste fel ${when(p.lastErrorAt!)}: ${errorDetail}` : null;

  if (failing) {
    if (KEEPS_LAST.has(p.path) && p.lastSuccessAt) {
      return {
        key,
        path: p.path,
        label,
        state: "stale",
        text: `Senast kända ${when(p.lastSuccessAt)}`,
        error,
      };
    }
    return {
      key,
      path: p.path,
      label,
      state: "broken",
      text: `Fungerar inte sedan ${when(p.failingSince!)}`,
      error,
    };
  }
  if (p.activeRoute === "webbpanelen" && !WEB_NATIVE.has(p.path)) {
    const since = p.fallbackSince ? ` sedan ${when(p.fallbackSince)}` : "";
    return {
      key,
      path: p.path,
      label,
      state: "fallback",
      text: `Reservväg: webbpanelen${since}`,
      error,
    };
  }
  const at = p.lastSuccessAt ? ` · ${when(p.lastSuccessAt)}` : "";
  return { key, path: p.path, label, state: "ok", text: `Fungerar${at}`, error };
}

/** Raderna i läsordning. Vägar som aldrig har provats visas inte. */
export function awishHealthRows(
  paths: readonly AwishPathFacts[],
  when: WhenText,
): AwishHealthRowView[] {
  const tried = paths.filter((p) => p.lastAttemptAt !== null || p.lastSuccessAt !== null);
  return [...tried]
    .sort((a, b) => ORDER.indexOf(a.path) - ORDER.indexOf(b.path))
    .map((p) => awishHealthRow(p, when));
}

/** Kort sammanfattning för rubriken: "Allt fungerar", "Reservvägen används", … */
export function awishHealthSummary(rows: readonly AwishHealthRowView[]): {
  readonly tone: "ok" | "warn" | "bad";
  readonly text: string;
} {
  if (rows.some((r) => r.state === "broken" || r.state === "stale")) {
    return { tone: "bad", text: "Något fungerar inte just nu" };
  }
  if (rows.some((r) => r.state === "fallback")) {
    return { tone: "warn", text: "Reservvägen används" };
  }
  return { tone: "ok", text: "Allt fungerar" };
}

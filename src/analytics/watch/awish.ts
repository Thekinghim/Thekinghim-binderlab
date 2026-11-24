/**
 * Vakten för Awish per väg ("Om Awish krånglar", docs/operations.md).
 *
 * Varje del av Binderlab som pratar med Awish sparar vilken väg som fungerade
 * (public.awish_path_health, src/server/awish/health.ts). Här blir raderna larm och
 * statusrader:
 *
 *   lager       ingen väg på 30 min          kritisk  "Lagret har inte lästs sedan …"
 *   automater   ingen status på 30 min       varning  "Vi vet inte om automaterna är online …"
 *               på 2 h                        kritisk
 *   påfyllning  inloggningen fungerar inte   kritisk direkt
 *               väntar mer än 60 min          kritisk  "Påfyllningen … har inte nått Awish"
 *
 * Fungerar reservvägen (webbpanelen) blir det bara en statusrad, inget larm och ingen push:
 * ägaren ska inte störas av något som Binderlab redan har löst. Orderna har ingen reservväg;
 * de larmar som förut (syncLine) men pekar på uppladdningen av orderlistan.
 *
 * Rent: inga anrop, ingen klocka.
 */

import type { WatchLevel, WatchLine, WhenText } from "./index";

export type AwishPathName =
  | "orders"
  | "machines"
  | "stock"
  | "merchant"
  | "push"
  | "goods"
  | "slots"
  | "campaigns"
  | "free_packs";

export type AwishRouteName = "open_api" | "webbpanelen" | "senast_kanda" | "manuell" | "ingen";

/** En rad ur public.awish_path_health. */
export interface AwishPathFacts {
  readonly sourceId: string;
  readonly path: AwishPathName;
  readonly activeRoute: AwishRouteName;
  readonly lastSuccessAt: string | null;
  readonly lastSuccessRoute: AwishRouteName | null;
  readonly lastAttemptAt: string | null;
  readonly lastErrorAt: string | null;
  readonly lastErrorKind: string | null;
  readonly lastErrorCode: number | null;
  /** Första felet i rad utan någon fungerande väg (null = någon väg fungerar). */
  readonly failingSince: string | null;
  readonly breakerRoute: AwishRouteName | null;
  readonly breakerOpenUntil: string | null;
  /** På reservvägen (webbpanelen) sedan, utan att Open API har fungerat. */
  readonly fallbackSince: string | null;
}

/** Påfyllningar som inte har nått Awish (automater vars senaste sändning felade). */
export interface AwishPushFacts {
  readonly pendingMachines: number;
  /** När den äldsta väntande sändningen felade (ISO), null utan väntande. */
  readonly oldestAt: string | null;
}

export interface AwishWatchFacts {
  readonly paths: readonly AwishPathFacts[];
  readonly push: AwishPushFacts | null;
}

const MINUTE_MS = 60_000;

/** Lagret: så länge utan någon väg innan det larmar. */
export const AWISH_STOCK_MAX_MINUTES = 30;
/** Automaternas status: varning efter, kritisk efter. */
export const AWISH_MACHINES_WARN_MINUTES = 30;
export const AWISH_MACHINES_CRIT_MINUTES = 120;
/** Påfyllningar som väntar längre än så (efter de automatiska försöken) larmar. */
export const AWISH_PUSH_MAX_MINUTES = 60;
/** Reservvägen längre än så: Kontroll säger "kontakta Awish". */
export const AWISH_FALLBACK_MAX_HOURS = 24;

/** Larmnycklarna (en per väg och organisation): `watch:awish:<väg>`. */
export const AWISH_WATCH_KEYS = ["awish:stock", "awish:machines", "awish:push"] as const;

function minutesSince(iso: string | null, now: Date): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.max(0, Math.floor((now.getTime() - t) / MINUTE_MS)) : null;
}

/** Felets art och gRPC-kod på enkel svenska ("Awish internt fel"). */
export function awishErrorText(kind: string | null, code: number | null = null): string {
  if (code === 13) return "Awish internt fel";
  if (code === 14) return "Awish svarar inte";
  if (code === 4) return "Awish svarar för långsamt";
  if (code === 8) return "Awish tar inte emot fler anrop just nu";
  switch (kind) {
    case "auth":
      return "inloggningen fungerar inte";
    case "unavailable":
      return "Awish svarar inte";
    case "timeout":
      return "Awish svarar för långsamt";
    case "server":
      return "Awish internt fel";
    case "invalid_response":
      return "Awish svarade med konstiga data";
    case "changed":
      return "Awish har ändrat något";
    case "not_found":
      return "finns inte i Awish";
    case "budget":
      return "tiden tog slut";
    case null:
    case undefined:
      return "okänt fel";
    default:
      return "okänt fel";
  }
}

/**
 * Sedan när vägen inte har fungerat alls (ingen väg): senaste lyckade, annars första felet.
 * null = någon väg fungerar.
 */
export function brokenSince(p: AwishPathFacts): string | null {
  if (!p.failingSince) return null;
  return p.lastSuccessAt ?? p.failingSince;
}

/** Den sämsta raden för vägen bland organisationens källor (längst utan fungerande väg). */
export function worstPath(
  paths: readonly AwishPathFacts[],
  path: AwishPathName,
): AwishPathFacts | null {
  let worst: AwishPathFacts | null = null;
  let worstMs = Infinity;
  for (const p of paths) {
    if (p.path !== path) continue;
    const since = brokenSince(p);
    const ms = since ? Date.parse(since) : Infinity;
    if (worst === null || ms < worstMs) {
      worst = p;
      worstMs = ms;
    }
  }
  return worst;
}

function line(
  key: string,
  level: WatchLevel,
  title: string,
  detail: string,
  href: string,
  action: string,
): WatchLine {
  return { key, level, title, detail, href, action };
}

/** "Lagret har inte lästs sedan …" när varken Open API eller webbpanelen har fungerat. */
export function awishStockLine(f: AwishWatchFacts, now: Date, when: WhenText): WatchLine | null {
  const p = worstPath(f.paths, "stock");
  if (!p) return null;
  const since = brokenSince(p);
  const minutes = minutesSince(since, now);
  if (since === null || minutes === null || minutes <= AWISH_STOCK_MAX_MINUTES) return null;
  const title = p.lastSuccessAt
    ? `Lagret har inte lästs sedan ${when(p.lastSuccessAt)}`
    : "Lagret har aldrig lästs från Awish";
  const why =
    p.lastErrorKind === "auth"
      ? "Inloggningen till webbpanelen fungerar inte. Byt lösenord i Datakällor."
      : `Varken Open API eller webbpanelen svarar (${awishErrorText(p.lastErrorKind, p.lastErrorCode)}).`;
  return line(
    "awish:stock",
    "critical",
    title,
    `${why} Fyll på och Lager visar senaste läsningen. Påfyllningar sparas som vanligt.`,
    "/datakallor#awish-halsa",
    "Öppna Datakällor",
  );
}

/** "Vi vet inte om automaterna är online sedan …" (bara Open API visar statusen). */
export function awishMachinesLine(f: AwishWatchFacts, now: Date, when: WhenText): WatchLine | null {
  const p = worstPath(f.paths, "machines");
  if (!p) return null;
  const since = brokenSince(p);
  const minutes = minutesSince(since, now);
  if (since === null || minutes === null || minutes <= AWISH_MACHINES_WARN_MINUTES) return null;
  return line(
    "awish:machines",
    minutes > AWISH_MACHINES_CRIT_MINUTES ? "critical" : "warning",
    `Vi vet inte om automaterna är online sedan ${when(since)}`,
    `Awish visar inte automaternas status (${awishErrorText(p.lastErrorKind, p.lastErrorCode)}). Larmen om automater som står still väntar så länge. Försäljning och lager hämtas ändå.`,
    "/datakallor#awish-halsa",
    "Öppna Datakällor",
  );
}

/** Inloggningen fungerar inte (direkt), eller påfyllningar som har väntat mer än 60 min. */
export function awishPushLine(f: AwishWatchFacts, now: Date, when: WhenText): WatchLine | null {
  const auth = f.paths.find(
    (p) =>
      p.path === "push" &&
      p.lastErrorKind === "auth" &&
      (p.failingSince !== null ||
        (p.breakerRoute === "webbpanelen" &&
          p.breakerOpenUntil !== null &&
          Date.parse(p.breakerOpenUntil) > now.getTime())),
  );
  if (auth) {
    return line(
      "awish:push",
      "critical",
      "Inloggningen till webbpanelen fungerar inte",
      "Påfyllningarna sparas i Binderlab men når inte Awish. Byt lösenord i Datakällor.",
      "/datakallor#awish",
      "Byt lösenord",
    );
  }
  const push = f.push;
  if (!push || push.pendingMachines === 0) return null;
  const minutes = minutesSince(push.oldestAt, now);
  if (minutes === null || minutes <= AWISH_PUSH_MAX_MINUTES) return null;
  const n = push.pendingMachines;
  return line(
    "awish:push",
    "critical",
    n === 1
      ? "Påfyllningen i en automat har inte nått Awish"
      : `Påfyllningarna i ${n} automater har inte nått Awish`,
    `Sparat i Binderlab, väntar sedan ${when(push.oldestAt!)}. Binderlab försöker igen själv. Tryck Försök igen i Fyll på, eller skriv antalet i Awish.`,
    "/fyll-pa",
    "Öppna Fyll på",
  );
}

/** Awish-raderna som larmar (lager, automater, påfyllningar). */
export function awishLines(f: AwishWatchFacts, now: Date, when: WhenText): WatchLine[] {
  return [
    awishStockLine(f, now, when),
    awishMachinesLine(f, now, when),
    awishPushLine(f, now, when),
  ].filter((l): l is WatchLine => l !== null);
}

/** Vad raden heter för ägaren. */
export const AWISH_PATH_LABEL: Readonly<Record<AwishPathName, string>> = {
  orders: "Försäljning",
  machines: "Automaternas status",
  stock: "Lager i automaterna",
  merchant: "Awish-kontots slutdag",
  push: "Påfyllningar till Awish",
  goods: "Varor i Awish",
  slots: "Fack i webbpanelen",
  campaigns: "Kampanjer",
  free_packs: "Gratis-pack",
};

export interface AwishStatusLine {
  readonly key: string;
  readonly text: string;
}

/**
 * Statusrader (inget larm, ingen push): vägar där reservvägen fungerar just nu.
 * "Lager i automaterna läses via webbpanelen sedan 03:05 (Open API: Awish internt fel)."
 */
export function awishStatusLines(f: AwishWatchFacts, when: WhenText): AwishStatusLine[] {
  const out: AwishStatusLine[] = [];
  const seen = new Set<AwishPathName>();
  for (const p of f.paths) {
    if (seen.has(p.path)) continue;
    if (p.activeRoute !== "webbpanelen" || p.failingSince !== null) continue;
    seen.add(p.path);
    const since = p.fallbackSince ? ` sedan ${when(p.fallbackSince)}` : "";
    const why = p.lastErrorKind
      ? ` (Open API: ${awishErrorText(p.lastErrorKind, p.lastErrorCode)})`
      : "";
    out.push({
      key: `awish-reserv:${p.path}`,
      text: `${AWISH_PATH_LABEL[p.path]}: via webbpanelen${since}${why}.`,
    });
  }
  return out;
}

/** Vägar som har gått på reservvägen längre än ett dygn. */
export function longFallbacks(
  paths: readonly AwishPathFacts[],
  now: Date,
  hours = AWISH_FALLBACK_MAX_HOURS,
): AwishPathFacts[] {
  return paths.filter((p) => {
    const m = minutesSince(p.fallbackSince, now);
    return m !== null && m > hours * 60 && p.activeRoute !== "open_api";
  });
}

// ---------------------------------------------------------------------------
// Hem och Drift: hur färsk datan är
// ---------------------------------------------------------------------------

export interface AwishFreshnessFacts {
  /** Senaste lyckade orderhämtningen (ISO). */
  readonly ordersAt: string | null;
  /** Senaste läsningen av facken (ISO), vilken väg som helst. */
  readonly stockAt: string | null;
  /** Vägen för facken just nu. */
  readonly stockVia: AwishRouteName | null;
}

/** "Försäljning 14:52 · Lager 14:50 (via webbpanelen)", null utan något att visa. */
export function awishFreshnessText(f: AwishFreshnessFacts, clock: WhenText): string | null {
  const parts: string[] = [];
  if (f.ordersAt) parts.push(`Försäljning ${clock(f.ordersAt)}`);
  if (f.stockAt) {
    const via = f.stockVia === "webbpanelen" ? " (via webbpanelen)" : "";
    parts.push(`Lager ${clock(f.stockAt)}${via}`);
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}

/**
 * Bannern på Hem när orderna inte har hämtats på 30 min: "Försäljningen är inte uppdaterad
 * sedan 14:52. Awish svarar inte. Ladda upp orderlistan i Datakällor."
 */
export function ordersBannerText(lastSuccessAt: string | null, when: WhenText): string {
  const since = lastSuccessAt
    ? `Försäljningen är inte uppdaterad sedan ${when(lastSuccessAt)}.`
    : "Försäljningen har inte hämtats från Awish än.";
  return `${since} Awish svarar inte. Ladda upp orderlistan i Datakällor.`;
}

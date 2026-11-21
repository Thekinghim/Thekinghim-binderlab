/**
 * Automatens läge i V2 (docs/design/v2/byggplan.md avsnitt 3.1): EN status per automat som
 * Hem, Automater, Rutt och menyns räknare visar likadant. Ren funktion.
 *
 * Statusen väljs i den här ordningen (första som stämmer):
 *
 *   1. offline    maskinhälsan säger offline (aldrig när strömmen är av enligt butikens tider:
 *                 hälsan räknar det som "strömmen av", src/analytics/health/power.ts)
 *   2. tom        Σ pack i automaten = 0
 *   3. fyll-pa    något fack tomt, eller fyllnaden ≤ LOW_FILL_BP (25 %)
 *   4. startklar  ny automat med steg kvar (loadStartklarFor / machineReadiness)
 *   5. strom-av   strömmen är av just nu enligt butikens tider
 *   6. tom-snart  tom inom SOON_DAYS (3) dagar med nuvarande takt ("Tom om 2 d")
 *   7. i-drift    allt annat
 *
 * Listorna sorteras på `FLEET_STATUS_RANK` (som prototypen): offline, tom, fyll på i dag,
 * startklar, tom om N d, i drift och sist ström av (planerat och lugnt).
 * Offline är ett larm, ström av är planerat: de ser aldrig likadana ut (prick + text).
 */

/** Automatens läge. */
export type FleetStatus =
  "offline" | "tom" | "fyll-pa" | "startklar" | "strom-av" | "tom-snart" | "i-drift";

/** Fyllnad (bp) som ger "Fyll på i dag" (25 %, prototypens värde). */
export const LOW_FILL_BP = 2_500;
/** "Tom om N d" visas när automaten är tom inom så här många dagar. */
export const SOON_DAYS = 3;

/** Sorteringsordning i listorna (lägre först). */
export const FLEET_STATUS_RANK: Readonly<Record<FleetStatus, number>> = {
  offline: 0,
  tom: 1,
  "fyll-pa": 2,
  startklar: 3,
  "tom-snart": 4,
  "i-drift": 5,
  "strom-av": 6,
};

/** Kräver något av någon i dag (Kräver åtgärd på Hem, filtret "Behöver påfyllning"). */
export const ACTION_STATUSES: ReadonlySet<FleetStatus> = new Set([
  "offline",
  "tom",
  "fyll-pa",
  "startklar",
]);

/** Behöver påfyllning (tom, fyll på i dag, startklar). */
export const NEEDS_FILL_STATUSES: ReadonlySet<FleetStatus> = new Set([
  "tom",
  "fyll-pa",
  "startklar",
]);

export interface FleetStatusInput {
  /** Maskinhälsan säger offline (och strömmen är inte av enligt schemat). */
  readonly offline: boolean;
  /** Strömmen är av just nu enligt butikens tider. */
  readonly powerOff: boolean;
  /** Ny automat med steg kvar (ägare och admin; andra roller får false). */
  readonly startklar: boolean;
  /** Pack i automaten (Awish-läsningen, annars lagret). null = okänt. */
  readonly units: number | null;
  /** Fyllnad i bp ur Awish-läsningen. null = okänd. */
  readonly fillBp: number | null;
  /** Tomma fack enligt Awish. */
  readonly emptyChannels: number;
  /** Hela dagar tills tom med nuvarande takt. null = säljer inte / okänt. */
  readonly daysLeft: number | null;
}

/** Statusen enligt reglerna ovan. */
export function fleetStatusOf(input: FleetStatusInput): FleetStatus {
  if (input.offline) return "offline";
  if (input.units !== null && input.units <= 0) return "tom";
  if (input.emptyChannels > 0 || (input.fillBp !== null && input.fillBp <= LOW_FILL_BP)) {
    return "fyll-pa";
  }
  if (input.startklar) return "startklar";
  if (input.powerOff) return "strom-av";
  if (input.daysLeft !== null && input.daysLeft <= SOON_DAYS) return "tom-snart";
  return "i-drift";
}

/** Etiketten: "Offline", "Tom", "Fyll på i dag", "Startklar", "Ström av", "Tom om 2 d", "I drift". */
export function fleetStatusLabel(status: FleetStatus, daysLeft?: number | null): string {
  switch (status) {
    case "offline":
      return "Offline";
    case "tom":
      return "Tom";
    case "fyll-pa":
      return "Fyll på i dag";
    case "startklar":
      return "Startklar";
    case "strom-av":
      return "Ström av";
    case "tom-snart":
      return daysLeft === null || daysLeft === undefined
        ? "Tom snart"
        : daysLeft <= 0
          ? "Tom i dag"
          : `Tom om ${daysLeft} d`;
    case "i-drift":
      return "I drift";
  }
}

/** Ton för märket (Badge/StatusDot i src/components/v2). */
export type FleetStatusTone = "critical" | "warning" | "info" | "neutral" | "off";

export const FLEET_STATUS_TONE: Readonly<Record<FleetStatus, FleetStatusTone>> = {
  offline: "critical",
  tom: "critical",
  "fyll-pa": "warning",
  startklar: "info",
  "tom-snart": "neutral",
  "i-drift": "neutral",
  "strom-av": "off",
};

/** Jämför två automater för listorna: status, sedan kortast tid till tom, sedan kod. */
export function compareFleetRows(
  a: { readonly status: FleetStatus; readonly daysLeft: number | null; readonly code: string },
  b: { readonly status: FleetStatus; readonly daysLeft: number | null; readonly code: string },
): number {
  return (
    FLEET_STATUS_RANK[a.status] - FLEET_STATUS_RANK[b.status] ||
    (a.daysLeft ?? 9_999) - (b.daysLeft ?? 9_999) ||
    a.code.localeCompare(b.code, "sv")
  );
}

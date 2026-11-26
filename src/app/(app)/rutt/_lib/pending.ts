/**
 * Rutt utan väntan: det man tryckt på syns direkt (useOptimistic), innan servern svarat. Rent
 * och testat (pending.test.ts). Går åtgärden inte fram släpper React det tillfälliga läget och
 * stoppet står där igen (med "Ingen kontakt").
 */
import type { DayRoute, RouteStop } from "@/server/data/v2/types";

import type { RouteChangeKind } from "./service";

/**
 * Pågående tryck: automatens id → ändringen (Hoppa över, Till i morgon, Lägg till), eller
 * en ändrings id → "undo" (Ångra).
 */
export type InFlight = Readonly<Record<string, RouteChangeKind | "undo">>;

export type InFlightAction = { readonly key: string; readonly kind: RouteChangeKind | "undo" };

export function addInFlight(state: InFlight, action: InFlightAction): InFlight {
  return { ...state, [action.key]: action.kind };
}

/** Stoppet lämnar dagens lista direkt (Hoppa över, Till i morgon). */
export function leavesToday(inFlight: InFlight, machineId: string): boolean {
  const kind = inFlight[machineId];
  return kind === "skip" || kind === "later";
}

/**
 * Dagens rutt som den ser ut med de pågående trycken: stoppen som hoppas över eller flyttas
 * är borta ur listan och ur grupperna (tomma grupper försvinner). Kollade offline-stopp
 * (`checked`, bara i den här telefonen) räknas som klara.
 */
export function visibleRoute(
  route: Pick<DayRoute, "stops" | "groups">,
  inFlight: InFlight,
  checked: ReadonlySet<string> = new Set(),
): {
  stops: RouteStop[];
  groups: DayRoute["groups"][number][];
  /** Stopp som är kvar att göra. */
  remaining: RouteStop[];
  /** Något stopp har just tagits bort (för texten när listan blir tom). */
  removedNow: boolean;
} {
  const stops = route.stops.filter((s) => !leavesToday(inFlight, s.machineId));
  const ids = new Set(stops.map((s) => s.machineId));
  const packsOf = new Map(stops.map((s) => [s.machineId, s.packs]));
  const groups = route.groups
    .map((g) => {
      const machineIds = g.machineIds.filter((id) => ids.has(id));
      return machineIds.length === g.machineIds.length
        ? g
        : { ...g, machineIds, packs: machineIds.reduce((a, id) => a + (packsOf.get(id) ?? 0), 0) };
    })
    .filter((g) => g.machineIds.length > 0);
  const remaining = stops.filter(
    (s) => !s.done && !(s.kind === "check" && checked.has(s.machineId)),
  );
  return { stops, groups, remaining, removedNow: stops.length < route.stops.length };
}

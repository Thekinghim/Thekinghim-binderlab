/**
 * Ruttordning för en besöksdag: enkel TSP-heuristik över fågelvägen.
 *
 *   avstånd       = haversine mellan koordinaterna (meter, avrundat till hela meter)
 *   start         = depån om den finns, annars den mest brådskande automaten
 *   närmaste granne: gå alltid till närmaste ej besökta automat
 *   2-opt         : vänd delsträckor så länge rutten blir kortare (förbättringen måste vara
 *                   minst 1 meter, så att flyttalsbrus aldrig ger oändliga byten)
 *   med depå räknas återresan till depån in i totalen
 *
 * Avstånd är inte pengar; de räknas med flyttal men avrundas till hela meter innan de jämförs
 * eller visas, så att samma indata alltid ger samma ordning. Lika avstånd avgörs på id.
 */

import { DomainError } from "@/domain";

/** Koordinat i decimala grader (WGS 84). */
export interface GeoPoint {
  readonly lat: number;
  readonly lng: number;
}

/** Jordens medelradie i meter. */
export const EARTH_RADIUS_M = 6_371_009;

function assertPoint(p: GeoPoint): void {
  if (
    !Number.isFinite(p.lat) ||
    !Number.isFinite(p.lng) ||
    Math.abs(p.lat) > 90 ||
    Math.abs(p.lng) > 180
  ) {
    throw new DomainError("invalid_input", `Ogiltig koordinat: ${JSON.stringify(p)}.`);
  }
}

/** Fågelvägen mellan två punkter i hela meter (haversine). Stockholm C–Uppsala C ≈ 64 km. */
export function distanceMeters(a: GeoPoint, b: GeoPoint): number {
  assertPoint(a);
  assertPoint(b);
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h))));
}

/** En punkt i rutten. */
export interface RoutePoint {
  readonly id: string;
  readonly location: GeoPoint;
}

/** Resultat: ordningen, sträckan till varje stopp och totalen (meter). */
export interface Route {
  readonly order: string[];
  /** Sträcka från föregående punkt (depån för första stoppet, om depå finns; annars 0). */
  readonly legs: number[];
  /** Total sträcka, inklusive återresa till depån om depå finns. */
  readonly totalMeters: number;
}

function length(
  order: readonly number[],
  dist: (i: number, j: number) => number,
  depot: boolean,
): number {
  let sum = 0;
  for (let k = 1; k < order.length; k++) sum += dist(order[k - 1] as number, order[k] as number);
  if (depot && order.length > 0) {
    sum += dist(-1, order[0] as number) + dist(order[order.length - 1] as number, -1);
  }
  return sum;
}

/**
 * Ordnar punkterna med närmaste granne + 2-opt. Utan depå börjar rutten i `points[0]`
 * (anroparen lägger den mest brådskande först) och räknas som öppen (ingen återresa).
 */
export function planRoute(points: readonly RoutePoint[], depot: GeoPoint | null = null): Route {
  const n = points.length;
  if (n === 0) return { order: [], legs: [], totalMeters: 0 };
  const matrix: number[][] = points.map((a) =>
    points.map((b) => distanceMeters(a.location, b.location)),
  );
  const fromDepot = depot ? points.map((p) => distanceMeters(depot, p.location)) : [];
  const dist = (i: number, j: number): number => {
    if (i === -1) return fromDepot[j] ?? 0;
    if (j === -1) return fromDepot[i] ?? 0;
    return matrix[i]?.[j] ?? 0;
  };
  const idOf = (i: number) => points[i]?.id ?? "";

  // Närmaste granne.
  const visited = new Set<number>();
  const order: number[] = [];
  let current = -1;
  if (!depot) {
    order.push(0);
    visited.add(0);
    current = 0;
  }
  while (order.length < n) {
    let best = -1;
    let bestD = Infinity;
    for (let j = 0; j < n; j++) {
      if (visited.has(j)) continue;
      const d = dist(current, j);
      if (d < bestD || (d === bestD && idOf(j) < idOf(best))) {
        best = j;
        bestD = d;
      }
    }
    order.push(best);
    visited.add(best);
    current = best;
  }

  // 2-opt. Utan depå ligger första punkten fast.
  const first = depot ? 0 : 1;
  let improved = true;
  let guard = 0;
  while (improved && guard++ < 1_000) {
    improved = false;
    for (let i = first; i < n - 1; i++) {
      for (let k = i + 1; k < n; k++) {
        const candidate = [
          ...order.slice(0, i),
          ...order.slice(i, k + 1).reverse(),
          ...order.slice(k + 1),
        ];
        if (length(candidate, dist, depot !== null) + 1 <= length(order, dist, depot !== null)) {
          order.splice(0, n, ...candidate);
          improved = true;
        }
      }
    }
  }

  const legs = order.map((idx, k) =>
    k === 0 ? (depot ? dist(-1, idx) : 0) : dist(order[k - 1] as number, idx),
  );
  return { order: order.map(idOf), legs, totalMeters: length(order, dist, depot !== null) };
}

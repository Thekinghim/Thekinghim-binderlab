/**
 * Underlag till klientkomponenter utan order-id. Underlaget (`evidence`) bär id för
 * varje order en siffra bygger på; med 100 000 order blev Expansion 12 MB och Effekt
 * 5 MB HTML. Klientkomponenterna visar bara antalet ("1 234 order"), så id:na byts mot
 * antalet (`orderCount`) innan datan går till klienten. Länkarna till underlaget räknas
 * på servern före bytet.
 */

/** Underlag med antalet order i stället för id:na (se withOrderCounts). */
export interface OrderCounted {
  readonly orderIds: readonly string[];
  readonly orderCount?: number;
}

/** Antalet order i ett underlag, med eller utan id:na. */
export function orderCountOf(evidence: OrderCounted): number {
  return evidence.orderCount ?? evidence.orderIds.length;
}

/**
 * Kopia av `value` där varje `orderIds` (på alla nivåer) är tom och antalet står i
 * `orderCount`. Allt annat är oförändrat. Bara för data som skickas till klienten.
 */
export function withOrderCounts<T>(value: T): T {
  return slim(value) as T;
}

function slim(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(slim);
  if (value === null || typeof value !== "object") return value;
  const proto = Object.getPrototypeOf(value) as unknown;
  if (proto !== Object.prototype && proto !== null) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) out[k] = slim(v);
  const ids = (value as { orderIds?: unknown }).orderIds;
  if (Array.isArray(ids) && ids.every((x) => typeof x === "string")) {
    out.orderIds = [];
    out.orderCount = (value as { orderCount?: number }).orderCount ?? ids.length;
  }
  return out;
}

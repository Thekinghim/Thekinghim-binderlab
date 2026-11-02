/**
 * Kolumntyper för Drizzle som inte finns inbyggda, och som garanterar att
 * pengar och andra stora heltal aldrig blir flyttal.
 *
 * - `safeBigint` (bigint i databasen) läses och skrivs som JS-`number`, men
 *   bara om värdet är ett säkert heltal (`Number.isSafeInteger`). Allt annat
 *   kastar `RangeError` i stället för att tyst tappa precision.
 * - `ore` är samma typ, för belopp i öre (`*_ore`).
 * - `citext` är skiftlägesokänslig text (e-post).
 */

import { customType } from "drizzle-orm/pg-core";

export function toSafeInteger(value: unknown, column = "värde"): number {
  let n: number;
  if (typeof value === "number") {
    n = value;
  } else if (typeof value === "bigint" || (typeof value === "string" && /^-?\d+$/.test(value))) {
    const big = BigInt(value);
    n = Number(big);
    if (BigInt(n) !== big) {
      throw new RangeError(`${column}: ${String(value)} är inte ett säkert heltal`);
    }
  } else {
    throw new TypeError(`${column}: förväntade heltal, fick ${typeof value}`);
  }
  if (!Number.isSafeInteger(n)) {
    throw new RangeError(`${column}: ${String(value)} är inte ett säkert heltal`);
  }
  return n;
}

export const safeBigint = customType<{
  data: number;
  driverData: string | number | bigint;
}>({
  dataType() {
    return "bigint";
  },
  fromDriver(value) {
    return toSafeInteger(value);
  },
  toDriver(value) {
    return toSafeInteger(value);
  },
});

/** Belopp i öre (bigint i databasen, säkert heltal i JS). */
export const ore = safeBigint;

export const citext = customType<{ data: string }>({
  dataType() {
    return "citext";
  },
});

/**
 * Kodning för värden som sparas mellan förfrågningar (Next:s datacache, som sparar JSON).
 *
 * JSON tappar Map, Set, Date, undefined och NaN/Infinity, och unstable_cache ger tillbaka
 * originalvärdet första gången men JSON.parse av det sparade sedan. Därför kodas värdet
 * före sparandet och avkodas efter, så att en träff ger exakt samma värde som en ny läsning.
 * Klassinstanser, funktioner, bigint och symboler går inte att spara: encodeForCache kastar
 * NotCacheableError, och den som anropar läser då utan cache.
 */

export class NotCacheableError extends Error {
  constructor(what: string) {
    super(`Värdet kan inte sparas mellan förfrågningar (${what}).`);
    this.name = "NotCacheableError";
  }
}

const TAG = "$c";

type Encoded = null | boolean | number | string | Encoded[] | { readonly [key: string]: Encoded };

function isPlainObject(value: object): boolean {
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Värdet som ren JSON (Map, Set, Date, undefined och NaN/Infinity märkta). */
export function encodeForCache(value: unknown): Encoded {
  switch (typeof value) {
    case "string":
    case "boolean":
      return value;
    case "number":
      return Number.isFinite(value) ? value : { [TAG]: "n", v: String(value) };
    case "undefined":
      return { [TAG]: "u" };
    case "object": {
      if (value === null) return null;
      if (Array.isArray(value)) return value.map((v) => encodeForCache(v));
      if (value instanceof Date) {
        const t = value.getTime();
        return { [TAG]: "d", v: Number.isNaN(t) ? null : value.toISOString() };
      }
      if (value instanceof Map) {
        return {
          [TAG]: "m",
          v: [...value.entries()].map(([k, v]) => [encodeForCache(k), encodeForCache(v)]),
        };
      }
      if (value instanceof Set) return { [TAG]: "s", v: [...value].map((v) => encodeForCache(v)) };
      if (!isPlainObject(value)) {
        throw new NotCacheableError(value.constructor?.name ?? "okänd klass");
      }
      const out: Record<string, Encoded> = {};
      for (const [k, v] of Object.entries(value)) out[k] = encodeForCache(v);
      // Ett eget fält som heter som märket: hela objektet märks, så att det inte tolkas fel.
      return TAG in out ? { [TAG]: "o", v: out } : out;
    }
    default:
      throw new NotCacheableError(typeof value);
  }
}

/** Tillbaka till värdet som encodeForCache fick. */
export function decodeFromCache(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => decodeFromCache(v));
  const obj = value as Record<string, unknown>;
  if (TAG in obj) {
    const v = obj.v;
    switch (obj[TAG]) {
      case "u":
        return undefined;
      case "n":
        return Number(v);
      case "d":
        return new Date(typeof v === "string" ? v : Number.NaN);
      case "m":
        return new Map(
          (v as [unknown, unknown][]).map(([k, x]) => [decodeFromCache(k), decodeFromCache(x)]),
        );
      case "s":
        return new Set((v as unknown[]).map((x) => decodeFromCache(x)));
      case "o":
        return decodePlain(v as Record<string, unknown>);
      default:
        break;
    }
  }
  return decodePlain(obj);
}

function decodePlain(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) out[k] = decodeFromCache(v);
  return out;
}

/**
 * Enkel begränsning av försök i minnet (fast fönster per nyckel).
 *
 * - `consume` räknar försöket INNAN det görs, för flera nycklar i ett enda
 *   synkront steg. Parallella förfrågningar kan därför inte passera
 *   kontrollen innan någon av dem har räknats.
 * - Varje nyckel kan ha en egen gräns (t.ex. per IP och e-post, och en högre
 *   gräns per konto).
 * - Minnet hålls nere (maxKeys), men en spärrad nyckel tas aldrig bort i
 *   förtid: den som fyller minnet med skräpnycklar kan inte radera någon
 *   annans räknare. Är minnet fullt av spärrade nycklar nekas nya nycklar
 *   (fail closed) tills fönstret har gått ut.
 *
 * Begränsning: minnet är per serverinstans. På Vercel kan flera instanser
 * köra samtidigt, så gränsen är ungefärlig. Supabase Auth har dessutom egna
 * gränser för inloggning.
 */

export interface RateLimitDecision {
  allowed: boolean;
  retryAfterMs: number;
}

export interface RateLimitEntry {
  key: string;
  /** Gräns för just den här nyckeln; standard är limiterns `limit`. */
  limit?: number;
}

export interface RateLimiter {
  /** Får ett försök göras nu? (Läser bara, räknar inget.) */
  check(key: string, limit?: number): RateLimitDecision;
  /** Räknar ett försök. */
  hit(key: string, limit?: number): void;
  /**
   * Kontrollerar och räknar ett försök för alla nycklar i ett steg. Är någon
   * nyckel spärrad räknas inget och svaret är `allowed: false`.
   */
  consume(entries: readonly RateLimitEntry[]): RateLimitDecision;
  /** Nollställer nyckeln (efter lyckad inloggning). */
  reset(key: string): void;
}

export interface RateLimiterOptions {
  /** Antal försök per fönster. */
  limit: number;
  windowMs: number;
  /** Högsta antal nycklar i minnet. Spärrade nycklar tas aldrig bort i förtid. */
  maxKeys?: number;
  now?: () => number;
}

interface Bucket {
  count: number;
  limit: number;
  resetAt: number;
}

export function createRateLimiter(options: RateLimiterOptions): RateLimiter {
  const { limit: defaultLimit, windowMs, maxKeys = 10_000 } = options;
  const now = options.now ?? Date.now;
  const buckets = new Map<string, Bucket>();

  function current(key: string): Bucket | undefined {
    const bucket = buckets.get(key);
    if (bucket && bucket.resetAt <= now()) {
      buckets.delete(key);
      return undefined;
    }
    return bucket;
  }

  function isBlocked(bucket: Bucket): boolean {
    return bucket.count >= bucket.limit;
  }

  /** Gör plats för en ny nyckel. Falskt om minnet är fullt av spärrade nycklar. */
  function makeRoom(): boolean {
    if (buckets.size < maxKeys) {
      return true;
    }
    const at = now();
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= at) {
        buckets.delete(key);
      }
    }
    if (buckets.size < maxKeys) {
      return true;
    }
    // Den äldsta nyckeln som inte är spärrad (Map behåller insättningsordningen).
    for (const [key, bucket] of buckets) {
      if (!isBlocked(bucket)) {
        buckets.delete(key);
        return true;
      }
    }
    return false;
  }

  function earliestResetMs(): number {
    let earliest = Number.POSITIVE_INFINITY;
    for (const bucket of buckets.values()) {
      earliest = Math.min(earliest, bucket.resetAt);
    }
    return Number.isFinite(earliest) ? Math.max(0, earliest - now()) : windowMs;
  }

  function increment(key: string, limit: number): boolean {
    const bucket = current(key);
    if (bucket) {
      bucket.count += 1;
      bucket.limit = Math.min(bucket.limit, limit);
      return true;
    }
    if (!makeRoom()) {
      return false;
    }
    buckets.set(key, { count: 1, limit, resetAt: now() + windowMs });
    return true;
  }

  return {
    check(key, limit = defaultLimit) {
      const bucket = current(key);
      if (!bucket || bucket.count < Math.min(bucket.limit, limit)) {
        return { allowed: true, retryAfterMs: 0 };
      }
      return { allowed: false, retryAfterMs: bucket.resetAt - now() };
    },
    hit(key, limit = defaultLimit) {
      increment(key, limit);
    },
    consume(entries) {
      // Allt nedan är synkront: ingen annan förfrågan hinner emellan.
      let blocked = false;
      let retryAfterMs = 0;
      for (const { key, limit = defaultLimit } of entries) {
        const bucket = current(key);
        if (bucket && bucket.count >= Math.min(bucket.limit, limit)) {
          blocked = true;
          retryAfterMs = Math.max(retryAfterMs, bucket.resetAt - now());
        }
      }
      if (blocked) {
        return { allowed: false, retryAfterMs };
      }
      for (const { key, limit = defaultLimit } of entries) {
        if (!increment(key, limit)) {
          // Minnet är fullt av spärrade nycklar: neka hellre än att släppa
          // igenom försök som inte kan räknas.
          return { allowed: false, retryAfterMs: earliestResetMs() };
        }
      }
      return { allowed: true, retryAfterMs: 0 };
    },
    reset(key) {
      buckets.delete(key);
    },
  };
}

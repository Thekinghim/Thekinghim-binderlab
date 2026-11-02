/**
 * Enkel begränsning av försök i minnet (fast fönster per nyckel).
 *
 * Begränsning: minnet är per serverinstans. På Vercel kan flera instanser
 * köra samtidigt, så gränsen är ungefärlig. Supabase Auth har dessutom egna
 * gränser för inloggning.
 */

export interface RateLimiter {
  /** Får ett försök göras nu? */
  check(key: string): { allowed: boolean; retryAfterMs: number };
  /** Räknar ett misslyckat försök. */
  hit(key: string): void;
  /** Nollställer nyckeln (efter lyckad inloggning). */
  reset(key: string): void;
}

export interface RateLimiterOptions {
  /** Antal misslyckade försök per fönster. */
  limit: number;
  windowMs: number;
  /** Högsta antal nycklar i minnet; de äldsta tas bort först. */
  maxKeys?: number;
  now?: () => number;
}

export function createRateLimiter(options: RateLimiterOptions): RateLimiter {
  const { limit, windowMs, maxKeys = 10_000 } = options;
  const now = options.now ?? Date.now;
  const buckets = new Map<string, { count: number; resetAt: number }>();

  function current(key: string): { count: number; resetAt: number } | undefined {
    const bucket = buckets.get(key);
    if (bucket && bucket.resetAt <= now()) {
      buckets.delete(key);
      return undefined;
    }
    return bucket;
  }

  return {
    check(key) {
      const bucket = current(key);
      if (!bucket || bucket.count < limit) {
        return { allowed: true, retryAfterMs: 0 };
      }
      return { allowed: false, retryAfterMs: bucket.resetAt - now() };
    },
    hit(key) {
      const bucket = current(key);
      if (bucket) {
        bucket.count += 1;
        return;
      }
      if (buckets.size >= maxKeys) {
        const oldest = buckets.keys().next();
        if (!oldest.done) {
          buckets.delete(oldest.value);
        }
      }
      buckets.set(key, { count: 1, resetAt: now() + windowMs });
    },
    reset(key) {
      buckets.delete(key);
    },
  };
}

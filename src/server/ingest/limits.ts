/**
 * Gränser för ingest-API:t (POST /api/ingest/awish och GET /api/ingest/awish/status).
 *
 * Gränsen per token räknas i minnet per serverinstans (src/server/rate-limit.ts), så den
 * är ungefärlig när flera instanser kör. Tillägget håller sig långt under: en batch om
 * 200 rader i sekunden när hela historiken läses, annars ett par anrop var 10:e minut.
 */

import { createRateLimiter, type RateLimiter } from "@/server/rate-limit";

import { MAX_BATCH_ROWS } from "@/import/adapters/awish-extension";

export { MAX_BATCH_ROWS };

/** Största begäran (JSON) som tas emot. 500 rader är normalt runt 200 kB. */
export const MAX_BODY_BYTES = 2 * 1024 * 1024;

/** Batcher (och rapporter) per token och minut. */
export const BATCHES_PER_MINUTE = 120;
/** Statusfrågor per token och minut. */
export const STATUS_PER_MINUTE = 120;
/** Försök med ogiltig token per IP-adress och minut. */
export const BAD_TOKEN_PER_MINUTE = 20;

/** Hur länge tillägget kan vara tyst innan larmet slår till (docs/awish-tillagg.md). */
export const SILENCE_ALERT_MINUTES = 120;

/** Så många av de senaste ordernumren skickas i status, för att tillägget ska veta var det ska sluta läsa. */
export const STATUS_KNOWN_IDS = 500;

export interface IngestLimiters {
  batches: RateLimiter;
  status: RateLimiter;
  badToken: RateLimiter;
}

export function createIngestLimiters(now?: () => number): IngestLimiters {
  return {
    batches: createRateLimiter({ limit: BATCHES_PER_MINUTE, windowMs: 60_000, now }),
    status: createRateLimiter({ limit: STATUS_PER_MINUTE, windowMs: 60_000, now }),
    badToken: createRateLimiter({ limit: BAD_TOKEN_PER_MINUTE, windowMs: 60_000, now }),
  };
}

const globalForIngest = globalThis as typeof globalThis & {
  __binderlabIngestLimiters?: IngestLimiters;
};

/** De delade gränserna för servern (en uppsättning per process). */
export function ingestLimiters(): IngestLimiters {
  return (globalForIngest.__binderlabIngestLimiters ??= createIngestLimiters());
}

/**
 * Gemensamma Sentry-inställningar för server, edge och webbläsare.
 *
 * - Sentry startas bara när en DSN finns.
 * - environment = APP_ENV.
 * - sendDefaultPii = false, och `scrubEvent` tar dessutom bort e-postadresser,
 *   cookies, Authorization-rubriker och inbjudningstoken från allt som skickas.
 * - Låg tracesSampleRate.
 *
 * Filen har inga serverberoenden och importeras även av
 * src/instrumentation-client.ts.
 */

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const INVITE_PATH = /\/inbjudan\/[0-9a-f]{16,}/gi;
const TOKEN_PARAM = /([?&](?:token_hash|token|code|access_token|refresh_token)=)[^&#\s]+/gi;
const SENSITIVE_KEY =
  /^(?:cookie|cookies|set-cookie|authorization|proxy-authorization|x-supabase-auth|password|token|access_token|refresh_token|token_hash)$/i;
const MAX_DEPTH = 12;

export const REDACTED = "[borttaget]";

export function scrubString(value: string): string {
  return value
    .replace(EMAIL, "[e-post]")
    .replace(INVITE_PATH, "/inbjudan/[token]")
    .replace(TOKEN_PARAM, `$1${REDACTED}`);
}

function scrubValue(value: unknown, depth: number): unknown {
  if (typeof value === "string") {
    return scrubString(value);
  }
  if (depth >= MAX_DEPTH || value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => scrubValue(item, depth + 1));
  }
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value)) {
    out[key] = SENSITIVE_KEY.test(key) ? REDACTED : scrubValue(inner, depth + 1);
  }
  return out;
}

/** Tar bort personuppgifter och hemligheter ur en Sentry-händelse (eller brödsmula). */
export function scrubEvent<T>(event: T): T {
  const scrubbed = scrubValue(event, 0) as T & {
    user?: Record<string, unknown>;
    request?: Record<string, unknown>;
  };
  if (scrubbed && typeof scrubbed === "object") {
    if (scrubbed.user) {
      // Bara ett id får följa med; aldrig e-post, IP eller namn.
      const id = scrubbed.user.id;
      scrubbed.user = id === undefined ? {} : { id };
    }
    if (scrubbed.request) {
      delete scrubbed.request.cookies;
      delete scrubbed.request.data;
    }
  }
  return scrubbed;
}

export interface SentryOptionsInput {
  dsn: string;
  environment: string;
}

/** Gemensamma init-inställningar. Spreads in i Sentry.init({...}). */
export function sentryOptions({ dsn, environment }: SentryOptionsInput) {
  return {
    dsn,
    environment,
    sendDefaultPii: false,
    tracesSampleRate: environment === "production" ? 0.05 : 0.1,
    beforeSend: <T>(event: T): T => scrubEvent(event),
    beforeSendTransaction: <T>(event: T): T => scrubEvent(event),
    beforeBreadcrumb: <T>(breadcrumb: T): T => scrubEvent(breadcrumb),
  };
}

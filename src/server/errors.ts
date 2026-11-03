/**
 * Databasfel → svenska meddelanden till användaren.
 *
 * Felkoderna BL001–BL020 (se den första migreringen) har redan svenska,
 * användarvänliga meddelanden och visas som de är. Andra fel får ett
 * allmänt meddelande, så att interna detaljer aldrig visas.
 */

export interface PgErrorInfo {
  code: string;
  message: string;
}

/** Postgres-felet (SQLSTATE) bakom ett fel från Drizzle/postgres.js. */
export function pgErrorOf(error: unknown): PgErrorInfo | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth += 1) {
    if (
      typeof current === "object" &&
      current !== null &&
      "code" in current &&
      "severity" in current &&
      typeof (current as { code: unknown }).code === "string"
    ) {
      const e = current as { code: string; message?: unknown };
      return { code: e.code, message: typeof e.message === "string" ? e.message : "" };
    }
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

const GENERIC: Record<string, string> = {
  "42501": "Du har inte behörighet till det här.",
  "23505": "Det finns redan.",
  "40001": "Någon annan ändrade samtidigt. Försök igen.",
  "40P01": "Någon annan ändrade samtidigt. Försök igen.",
};

/** Svenskt meddelande för ett fel från databasen. */
export function dbErrorMessage(error: unknown, fallback = "Något gick fel. Försök igen."): string {
  const pg = pgErrorOf(error);
  if (!pg) {
    return fallback;
  }
  if (/^BL0\d\d$/.test(pg.code) && pg.message) {
    return pg.message;
  }
  return GENERIC[pg.code] ?? fallback;
}

/**
 * Ett fel i en form som går att logga utan frågans parametrar. drizzles
 * DrizzleQueryError har "Failed query: ...\nparams: ..." i meddelandet, och
 * parametrarna kan vara hemligheter (t.ex. AppSecret till Vault). Bara namnet,
 * meddelandet fram till "params:" och Postgres felkod följer med.
 */
export function safeErrorForLog(error: unknown): { name: string; message: string; code?: string } {
  const pg = pgErrorOf(error);
  const name = error instanceof Error ? error.name : typeof error;
  const raw = error instanceof Error ? error.message : String(error);
  const cut = raw.search(/\n?params:/i);
  const message = (cut >= 0 ? raw.slice(0, cut) : raw).slice(0, 500);
  return pg ? { name, message, code: pg.code } : { name, message };
}

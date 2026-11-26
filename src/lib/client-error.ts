/**
 * Klientfel: det som telefonen eller webbläsaren skickar till POST /api/klientfel när en sida
 * inte kunde laddas (felrutan) eller när ett fel inte fångades alls. Samma regler i
 * webbläsaren (innan något skickas) och på servern (innan databasen anropas); databasen
 * (public.report_client_error) kortar och rensar en gång till.
 *
 * Inget som kan vara hemligt sparas: frågesträngar och fragment tas bort ur adresser,
 * e-postadresser byts mot "[e-post]" och långa token-liknande strängar mot "[token]".
 */

export const CLIENT_ERROR_LIMITS = {
  path: 300,
  message: 500,
  stack: 4000,
  digest: 100,
  buildId: 80,
  userAgent: 300,
} as const;

/**
 * Var felet fångades: felrutan (en felgräns) eller lyssnarna på window. "viewport" är inget fel
 * utan fältdata från bottenradens ViewportPin (se viewport-pin-telemetry.ts).
 */
export type ClientErrorSource = "boundary" | "error" | "unhandledrejection" | "viewport";

/** ViewportPins mått: kolumnnamn, skärmhöjd och högst 12 rader med tal. */
export interface ClientErrorViewport {
  cols: string;
  screen: number;
  rows: string[];
}

export interface ClientErrorExtra {
  source: ClientErrorSource;
  online?: boolean;
  standalone?: boolean;
  visibility?: string;
  vp?: ClientErrorViewport;
}

export interface ClientErrorReport {
  path: string;
  message: string;
  stack: string;
  digest: string | null;
  buildId: string | null;
  userAgent: string | null;
  extra: ClientErrorExtra;
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// Adress med frågesträng eller fragment: bara adressen fram till ? eller # behålls.
const URL_QUERY = /(https?:\/\/[^\s?#)]*)[?#][^\s)]*/g;
// JWT och andra långa slumpsträngar (sessionstoken, nycklar).
const TOKEN = /\beyJ[A-Za-z0-9_-]{10,}(?:\.[A-Za-z0-9_-]+){0,2}|\b[A-Za-z0-9_-]{40,}\b/g;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/** Text som får skickas och sparas, kortad till max tecken. */
export function scrubText(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  return value
    .slice(0, max * 2)
    .replace(CONTROL, "")
    .replace(URL_QUERY, "$1")
    .replace(EMAIL, "[e-post]")
    .replace(TOKEN, "[token]")
    .slice(0, max);
}

/** Bara sökvägen ("/drift?x=1#y" → "/drift"), kortad. */
export function scrubPath(value: unknown): string {
  if (typeof value !== "string") return "";
  const path = value.split("#")[0]?.split("?")[0] ?? "";
  return scrubText(path, CLIENT_ERROR_LIMITS.path);
}

/** Ett id (fel-id, bygge): bara bokstäver, siffror och . _ - :, annars null. */
function optionalId(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const id = value.slice(0, max);
  return /^[A-Za-z0-9._:-]+$/.test(id) ? id : null;
}

function optional(value: unknown, max: number): string | null {
  const text = scrubText(value, max);
  return text ? text : null;
}

const SOURCES: readonly ClientErrorSource[] = [
  "boundary",
  "error",
  "unhandledrejection",
  "viewport",
];
const VISIBILITY = /^(visible|hidden|prerender|unloaded)$/;
const VP_COLS = /^[A-Za-z,]{1,120}$/;
const VP_ROW = /^[A-Za-z0-9,-]{1,80}$/;
/** Så att extra ryms i databasens gräns (1000 byte, annars sparas {}). */
const VP_MAX_JSON = 800;

/** ViewportPins mått om de har rätt form (bara tal, kommatecken och händelsenamn), annars null. */
function clampViewport(value: unknown): ClientErrorViewport | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.cols !== "string" || !VP_COLS.test(v.cols)) return null;
  if (typeof v.screen !== "number" || !Number.isFinite(v.screen)) return null;
  if (!Array.isArray(v.rows) || v.rows.length > 12) return null;
  if (!v.rows.every((r) => typeof r === "string" && VP_ROW.test(r))) return null;
  const vp: ClientErrorViewport = {
    cols: v.cols,
    screen: Math.round(Math.max(0, Math.min(10_000, v.screen))),
    rows: v.rows as string[],
  };
  return JSON.stringify(vp).length <= VP_MAX_JSON ? vp : null;
}

/**
 * Ett giltigt klientfel ur det som skickades (okänd form), eller null om det inte går att
 * tolka eller saknar både meddelande och stack. Kastar aldrig.
 */
export function clampClientError(input: unknown): ClientErrorReport | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const v = input as Record<string, unknown>;
  const message = scrubText(v.message, CLIENT_ERROR_LIMITS.message);
  const stack = scrubText(v.stack, CLIENT_ERROR_LIMITS.stack);
  if (!message && !stack) return null;
  const rawExtra =
    v.extra && typeof v.extra === "object" && !Array.isArray(v.extra)
      ? (v.extra as Record<string, unknown>)
      : {};
  const source = SOURCES.includes(rawExtra.source as ClientErrorSource)
    ? (rawExtra.source as ClientErrorSource)
    : "boundary";
  const extra: ClientErrorExtra = { source };
  if (typeof rawExtra.online === "boolean") extra.online = rawExtra.online;
  if (typeof rawExtra.standalone === "boolean") extra.standalone = rawExtra.standalone;
  if (typeof rawExtra.visibility === "string" && VISIBILITY.test(rawExtra.visibility)) {
    extra.visibility = rawExtra.visibility;
  }
  if (source === "viewport") {
    const vp = clampViewport(rawExtra.vp);
    if (vp) extra.vp = vp;
  }
  return {
    path: scrubPath(v.path),
    message,
    stack,
    digest: optionalId(v.digest, CLIENT_ERROR_LIMITS.digest),
    buildId: optionalId(v.buildId, CLIENT_ERROR_LIMITS.buildId),
    userAgent: optional(v.userAgent, CLIENT_ERROR_LIMITS.userAgent),
    extra,
  };
}

/**
 * "TypeError: x is not a function" och stacken ur det som kastades (vad som helst). Kastar
 * aldrig, inte ens för ett objekt med en getter som kastar.
 */
export function describeThrown(thrown: unknown): {
  message: string;
  stack: string;
  digest: string | null;
} {
  try {
    if (thrown && typeof thrown === "object") {
      const e = thrown as { name?: unknown; message?: unknown; stack?: unknown; digest?: unknown };
      const name = typeof e.name === "string" && e.name ? e.name : "Error";
      const msg = typeof e.message === "string" ? e.message : "";
      return {
        message: `${name}: ${msg}`.trim(),
        stack: typeof e.stack === "string" ? e.stack : "",
        digest: typeof e.digest === "string" && e.digest ? e.digest : null,
      };
    }
    return { message: thrown == null ? String(thrown) : String(thrown), stack: "", digest: null };
  } catch {
    return { message: "Okänt fel", stack: "", digest: null };
  }
}

/**
 * Vilka sökvägar som är öppna utan inloggning, och säkra omdirigeringar.
 * Används av src/proxy.ts. /api/cron/* (CRON_SECRET) och /api/version (byggets id) är öppna. /design och /datamodell kräver inloggning: de visar hela schemat och roll-/RLS-modellen. Proxyn är bara en bekvämlighet: behörigheten
 * kontrolleras alltid i serverkoden (requireUser/requireRole) och i RLS.
 */

export const LOGIN_PATH = "/logga-in";

/**
 * Statiska filer: bara filer direkt i roten (favicon, sw.js, manifest, robots.txt)
 * och under public/icons. En sökväg under appen som råkar sluta på .json eller
 * .txt (t.ex. /inkorg/x.json) är INTE öppen, så att en framtida route med ett
 * dynamiskt segment inte tappar proxyns omdirigering.
 */
const STATIC_FILE =
  /^\/(?:icons\/)?[^/]+\.(?:svg|png|jpe?g|gif|webp|avif|ico|css|js|mjs|map|txt|xml|json|woff2?|ttf|otf|webmanifest)$/i;

function isPathOrBelow(pathname: string, base: string): boolean {
  return pathname === base || pathname.startsWith(`${base}/`);
}

/** Sökvägar som inte kräver inloggning. */
export function isPublicPath(pathname: string): boolean {
  return (
    isPathOrBelow(pathname, LOGIN_PATH) ||
    pathname.startsWith("/inbjudan/") ||
    // Signering av avtal på plats: token i adressen är beviset (src/server/contracts/signing.ts).
    pathname.startsWith("/signera/") ||
    pathname.startsWith("/rapport/") ||
    pathname.startsWith("/_next/") ||
    // Schemalagda jobb (Vercel Cron) har ingen session; varje route kräver CRON_SECRET.
    pathname.startsWith("/api/cron/") ||
    // Byggets id (för "Ny version av appen finns"): inga uppgifter, fungerar utloggad.
    pathname === "/api/version" ||
    STATIC_FILE.test(pathname)
  );
}

/**
 * En säker sökväg att skicka användaren till efter inloggning: bara lokala
 * sökvägar (börjar med ett ensamt "/"), annars "/". Stoppar öppna
 * omdirigeringar som "//evil.example", "/\\evil.example" och "https://…".
 */
export function safeRedirectPath(next: unknown, fallback = "/"): string {
  if (typeof next !== "string" || next.length === 0 || next.length > 2048) {
    return fallback;
  }
  if (!next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) {
    return fallback;
  }
  if (/[\u0000-\u001f\u007f\\]/.test(next)) {
    return fallback;
  }
  try {
    const url = new URL(next, "http://binderlab.invalid");
    if (url.origin !== "http://binderlab.invalid") {
      return fallback;
    }
    if (isPathOrBelow(url.pathname, LOGIN_PATH)) {
      return fallback;
    }
    const result = `${url.pathname}${url.search}${url.hash}`;
    // Kontrollera även RESULTATET: punktsegment ("/.//x", "/a/..//x",
    // "/%2e//x") normaliseras annars till "//x", som webbläsaren tolkar som
    // en adress till en annan värd.
    if (!result.startsWith("/") || result.startsWith("//") || /^\/[\\\u0000-\u0020]/.test(result)) {
      return fallback;
    }
    return result;
  } catch {
    return fallback;
  }
}

/** Inloggningssidan med `next` satt till den sökväg användaren försökte nå. */
export function loginRedirectPath(pathname: string, search = ""): string {
  const next = safeRedirectPath(`${pathname}${search}`, "");
  return next && next !== "/" ? `${LOGIN_PATH}?next=${encodeURIComponent(next)}` : LOGIN_PATH;
}

/**
 * Vilka sökvägar som är öppna utan inloggning, och säkra omdirigeringar.
 * Används av src/proxy.ts. Proxyn är bara en bekvämlighet: behörigheten
 * kontrolleras alltid i serverkoden (requireUser/requireRole) och i RLS.
 */

export const LOGIN_PATH = "/logga-in";

const STATIC_FILE =
  /\.(?:svg|png|jpe?g|gif|webp|avif|ico|css|js|mjs|map|txt|xml|json|woff2?|ttf|otf|webmanifest)$/i;

function isPathOrBelow(pathname: string, base: string): boolean {
  return pathname === base || pathname.startsWith(`${base}/`);
}

/** Sökvägar som inte kräver inloggning. */
export function isPublicPath(pathname: string): boolean {
  return (
    isPathOrBelow(pathname, LOGIN_PATH) ||
    pathname.startsWith("/inbjudan/") ||
    pathname.startsWith("/design") ||
    isPathOrBelow(pathname, "/datamodell") ||
    pathname.startsWith("/rapport/") ||
    pathname.startsWith("/_next/") ||
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
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return fallback;
  }
}

/** Inloggningssidan med `next` satt till den sökväg användaren försökte nå. */
export function loginRedirectPath(pathname: string, search = ""): string {
  const next = safeRedirectPath(`${pathname}${search}`, "");
  return next && next !== "/" ? `${LOGIN_PATH}?next=${encodeURIComponent(next)}` : LOGIN_PATH;
}

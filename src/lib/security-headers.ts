/**
 * Säkerhetshuvuden för alla svar. Används av next.config.ts (headers()).
 *
 * - Inramning är förbjuden (CSP frame-ancestors 'none' och X-Frame-Options DENY),
 *   så att ingen annan sida, inte heller en annan underdomän, kan lägga appen i en
 *   iframe och lura fram klick på "Byt roll", "Godkänn" eller "Skicka".
 * - CSP utan nonce: skript bara från appen själv. 'unsafe-inline' behövs för Next:s
 *   inbäddade RSC-data utan nonce; 'unsafe-eval' bara i development (React Refresh).
 *   object-src 'none', base-uri 'self' och form-action 'self' stänger de vanliga
 *   vägarna förbi en CSP med 'unsafe-inline'.
 * - Filerna som visas i webbläsaren (avtal och rapporter som PDF) får en egen,
 *   smalare policy utan object-src, eftersom webbläsarens PDF-visare annars kan
 *   blockeras. De förbjuder fortfarande inramning.
 * - HSTS skickas alltid; webbläsare ignorerar den över http (lokalt).
 */

export type HeaderRule = { source: string; headers: Array<{ key: string; value: string }> };

export type SecurityHeaderOptions = {
  /** next dev: tillåt eval för React Refresh och websocket för HMR. */
  dev: boolean;
  /** NEXT_PUBLIC_SENTRY_DSN: webbläsaren skickar fel dit. */
  sentryDsn?: string;
};

function origin(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" ? parsed.origin : null;
  } catch {
    return null;
  }
}

/** Content-Security-Policy för appens sidor. */
export function contentSecurityPolicy({ dev, sentryDsn }: SecurityHeaderOptions): string {
  const sentry = origin(sentryDsn);
  const directives: Array<[string, string[]]> = [
    ["default-src", ["'self'"]],
    ["script-src", ["'self'", "'unsafe-inline'", ...(dev ? ["'unsafe-eval'"] : [])]],
    ["style-src", ["'self'", "'unsafe-inline'"]],
    ["img-src", ["'self'", "data:", "blob:"]],
    ["font-src", ["'self'", "data:"]],
    ["connect-src", ["'self'", ...(sentry ? [sentry] : []), ...(dev ? ["ws:"] : [])]],
    ["worker-src", ["'self'", "blob:"]],
    ["manifest-src", ["'self'"]],
    ["frame-src", ["'self'"]],
    ["object-src", ["'none'"]],
    ["base-uri", ["'self'"]],
    ["form-action", ["'self'"]],
    ["frame-ancestors", ["'none'"]],
  ];
  return directives.map(([name, values]) => `${name} ${values.join(" ")}`).join("; ");
}

/** Policy för PDF:er som visas inline: ingen inramning, inga formulär eller base. */
export const FILE_CONTENT_SECURITY_POLICY =
  "frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

/** Rutterna som visar en uppladdad eller genererad PDF direkt i webbläsaren. */
export const INLINE_FILE_ROUTES = [
  "/avtal/:id/fil",
  "/rapport/:id/fil/:typ",
  "/portal/rapporter/:id/pdf",
] as const;

export function securityHeaderRules(options: SecurityHeaderOptions): HeaderRule[] {
  const common = [
    { key: "Content-Security-Policy", value: contentSecurityPolicy(options) },
    { key: "X-Frame-Options", value: "DENY" },
    { key: "X-Content-Type-Options", value: "nosniff" },
    // Sökvägar kan bära inbjudningstoken och id:n: skicka bara ursprunget utåt.
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    // Bara funktioner som Chromium känner igen; okända (t.ex. bluetooth) ger en
    // konsolvarning på varje sida.
    {
      key: "Permissions-Policy",
      value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), hid=()",
    },
    { key: "Strict-Transport-Security", value: "max-age=63072000" },
    { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
    { key: "X-DNS-Prefetch-Control", value: "off" },
  ];
  return [
    { source: "/(.*)", headers: common },
    // Senare regler vinner för samma rubrik.
    ...INLINE_FILE_ROUTES.map((source) => ({
      source,
      headers: [{ key: "Content-Security-Policy", value: FILE_CONTENT_SECURITY_POLICY }],
    })),
  ];
}

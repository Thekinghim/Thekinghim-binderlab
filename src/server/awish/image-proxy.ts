/**
 * Varubilder från Awish i Binderlabs sidor. Sidornas CSP tillåter bara bilder från appen
 * själv ('self'), och Awish lägger bilderna på sin egen adress. Därför visas de via
 * /inkopspriser/ny-produkt/bild, som hämtar bilden på servern.
 *
 * Det är ingen öppen proxy: adressen måste vara signerad (HMAC) av servern, och servern
 * signerar bara bildadresser som Awish själv svarat med (varans thumb/media). Signaturen
 * är bunden till organisationen: en adress som signerats för en organisation godtas inte
 * när en annan organisation är aktiv (inte heller en demo). Nyckeln
 * härleds ur en hemlighet som servern redan har (CRON_SECRET, annars DATABASE_URL); finns
 * ingen används en slumpad nyckel per process.
 */

import "server-only";

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const AWISH_IMAGE_ROUTE = "/inkopspriser/ny-produkt/bild";

let fallbackKey: Buffer | null = null;

function key(): Buffer {
  const secret = process.env.CRON_SECRET || process.env.DATABASE_URL || "";
  if (secret) return createHash("sha256").update(`binderlab:awish-bild:v1:${secret}`).digest();
  fallbackKey ??= randomBytes(32);
  return fallbackKey;
}

function sign(organizationId: string, url: string): string {
  return createHmac("sha256", key())
    .update(`${organizationId}\n${url}`)
    .digest("base64url")
    .slice(0, 32);
}

/**
 * Interna adresser (loopback, privata nät, länklokala som molnets metadata). Servern hämtar
 * bilden själv, så i drift får en bildadress från Awish aldrig peka hit. Lokalt kör
 * låtsas-panelen på 127.0.0.1 och tillåts.
 */
function internalHost(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".internal")) return true;
  if (h.includes(":")) {
    // IPv6: loopback, ospecificerad, unik lokal (fc00::/7), länklokal (fe80::/10), IPv4-mappad.
    return (
      h === "::1" ||
      h === "::" ||
      /^f[cd]/.test(h) ||
      /^fe[89ab]/.test(h) ||
      h.startsWith("::ffff:")
    );
  }
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(h);
  if (!m) return /^\d+$/.test(h) || /^0x/i.test(h);
  const [a, b] = [Number(m[1]), Number(m[2])];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  );
}

/** Bara http(s)-adresser utan inloggningsuppgifter (och i drift inga interna) visas. */
function allowedUrl(raw: string): URL | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username || url.password) return null;
  if (process.env.NODE_ENV === "production" && internalHost(url.hostname)) return null;
  return url;
}

/** Sidans bildadress för en bild från Awish (för organisationen), eller null. */
export function awishImageSrc(organizationId: string, url: string | null): string | null {
  if (!organizationId || !url || !allowedUrl(url)) return null;
  const q = new URLSearchParams({ u: url, s: sign(organizationId, url) });
  return `${AWISH_IMAGE_ROUTE}?${q.toString()}`;
}

/** Bildadressen om signaturen stämmer för organisationen, annars null. */
export function verifyAwishImage(
  organizationId: string,
  u: string | null,
  s: string | null,
): URL | null {
  if (!organizationId || !u || !s) return null;
  const expected = Buffer.from(sign(organizationId, u));
  const given = Buffer.from(s);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  return allowedUrl(u);
}

/** Bildtyper som skickas vidare. */
export const AWISH_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;
/** Största bild som skickas vidare (panelen tar 5 MB). */
export const AWISH_IMAGE_MAX_BYTES = 5 * 1024 * 1024;

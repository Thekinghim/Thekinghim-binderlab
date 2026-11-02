/**
 * Synk-tokens för Awish Chrome-tillägget: format, hash och Authorization-huvudet.
 *
 * En token är "blsync_" följt av 43 tecken base64url (32 slumpade byte, 256 bitar).
 * Databasen sparar bara sha256 (hex) av hela token och de första 11 tecknen
 * ("blsync_Ab12") för att den ska gå att känna igen i listan. Token visas en gång,
 * när den skapas. Rena funktioner, inget beroende av databasen.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const TOKEN_PREFIX = "blsync_";
/** Antal tecken som visas i listan (prefixet och fyra tecken). */
export const TOKEN_DISPLAY_LENGTH = TOKEN_PREFIX.length + 4;
const TOKEN_PATTERN = /^blsync_[A-Za-z0-9_-]{43}$/;

export interface NewToken {
  token: string;
  hash: string;
  prefix: string;
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function isTokenFormat(value: string): boolean {
  return TOKEN_PATTERN.test(value);
}

export function generateToken(random: (n: number) => Buffer = randomBytes): NewToken {
  const token = `${TOKEN_PREFIX}${random(32).toString("base64url")}`;
  if (!isTokenFormat(token)) {
    throw new Error("Token kunde inte skapas.");
  }
  return { token, hash: hashToken(token), prefix: token.slice(0, TOKEN_DISPLAY_LENGTH) };
}

/**
 * Token ur "Authorization: Bearer <token>", eller null om huvudet saknas eller har fel
 * form. Cookies och query-parametrar läses aldrig.
 */
export function bearerToken(header: string | null | undefined): string | null {
  if (!header || header.length > 200) return null;
  const match = /^Bearer[ ]+(\S+)[ ]*$/i.exec(header);
  const token = match?.[1];
  return token && isTokenFormat(token) ? token : null;
}

/** Jämför två hashar utan tidsläckor (hex, lika långa). */
export function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a, "hex");
  const y = Buffer.from(b, "hex");
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

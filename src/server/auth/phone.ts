/**
 * Mobilnummer och PIN-koder för inloggning med mobilnummer (butikspåfyllare).
 * Rena funktioner, utan databas.
 */

import { createHash, randomBytes, randomInt } from "node:crypto";

/**
 * Ett svenskt mobilnummer (07x…) i formatet +467x…, annars null. Tar bort mellanslag,
 * bindestreck, punkter och parenteser. 070-123 45 67, +46 70 123 45 67 och
 * 0046 70 123 45 67 blir alla +46701234567.
 */
export function normalizeSwedishMobile(input: unknown): string | null {
  if (typeof input !== "string" || input.length > 40) return null;
  const compact = input.replace(/[\s\-().]/g, "");
  let rest: string;
  if (/^\+467\d+$/.test(compact)) rest = compact.slice(3);
  else if (/^00467\d+$/.test(compact)) rest = compact.slice(4);
  else if (/^467\d+$/.test(compact)) rest = compact.slice(2);
  else if (/^07\d+$/.test(compact)) rest = compact.slice(1);
  else return null;
  // Svenska mobilnummer: 7 + 8 siffror (070-123 45 67).
  if (!/^7\d{8}$/.test(rest)) return null;
  return `+46${rest}`;
}

/** +46701234567 → "070-123 45 ··" (för listor där hela numret inte behövs). */
export function maskMobile(e164: string): string {
  const local = `0${e164.replace(/^\+46/, "")}`;
  if (local.length !== 10) return "···";
  return `${local.slice(0, 3)}-${local.slice(3, 6)} ${local.slice(6, 8)} ··`;
}

/** +46701234567 → "070-123 45 67". */
export function formatMobile(e164: string): string {
  const local = `0${e164.replace(/^\+46/, "")}`;
  if (local.length !== 10) return e164;
  return `${local.slice(0, 3)}-${local.slice(3, 6)} ${local.slice(6, 8)} ${local.slice(8)}`;
}

export const PIN_LENGTH = 6;

function isWeakPin(pin: string): boolean {
  const d = [...pin].map(Number);
  if (new Set(d).size === 1) return true; // 111111
  const steps = d.slice(1).map((x, i) => x - d[i]!);
  if (steps.every((s) => s === 1) || steps.every((s) => s === -1)) return true; // 123456, 654321
  if (pin.slice(0, 2).repeat(3) === pin) return true; // 121212
  if (pin.slice(0, 3).repeat(2) === pin) return true; // 123123
  return false;
}

/** Svenskt felmeddelande om PIN-koden inte duger, annars null. */
export function validateNewPin(pin: unknown): string | null {
  if (typeof pin !== "string" || !/^\d{6}$/.test(pin)) {
    return "PIN-koden ska vara 6 siffror.";
  }
  if (isWeakPin(pin)) {
    return "Välj en svårare PIN-kod (inte 111111, 123456 eller liknande).";
  }
  return null;
}

/** En slumpad start-PIN med 6 siffror som klarar validateNewPin. */
export function generateStartPin(): string {
  for (;;) {
    const pin = String(randomInt(0, 1_000_000)).padStart(PIN_LENGTH, "0");
    if (validateNewPin(pin) === null) return pin;
  }
}

/** QR-kodens hemliga nyckel: 32 slumpade byte (base64url, 43 tecken). */
export function generateQrToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Ser ut som en QR-nyckel (43 tecken base64url). */
export function isQrToken(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
}

/** sha256 (hex) av nyckeln: det enda som sparas (private.phone_logins.qr_token_hash). */
export function hashQrToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

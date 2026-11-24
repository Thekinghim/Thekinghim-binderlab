/** Kontroller i webbläsaren (servern kontrollerar samma sak igen). */

export const MIN_REASON = 5;
export const MAX_REASON = 300;
export const MIN_INTERVAL_S = 5;
export const MAX_INTERVAL_S = 300;

/** Anledningen till Mata ut: 5–300 tecken. */
export function reasonOk(reason: string): boolean {
  const r = reason.replace(/\s+/g, " ").trim();
  return r.length >= MIN_REASON && r.length <= MAX_REASON;
}

/** Bytesintervall: hela sekunder, 5–300. */
export function intervalOk(v: string): boolean {
  if (!/^\d{1,3}$/.test(v.trim())) return false;
  const n = Number(v);
  return n >= MIN_INTERVAL_S && n <= MAX_INTERVAL_S;
}

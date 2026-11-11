/**
 * Svenska småord som flera texter delar: tal, "3 pack", "2 omgångar", "i Kontoret".
 * Används av ./sv.ts och av rundans egna filer i ./r2/. Engelskan: ./words.en.ts.
 */

import { NBSP } from "@/lib/format";

import { formatters } from "./format";

export const f = formatters("sv");
export const packs = (n: number) => `${f.int(n)}${NBSP}pack`;
export const batches = (n: number) => `${f.int(n)} ${n === 1 ? "omgång" : "omgångar"}`;
/** "hemma" · "i Kontoret" */
export const inPlace = (name: string) => {
  const n = name.trim();
  return n.toLowerCase() === "hemma" ? "hemma" : `i ${n}`;
};
/** "Hemma" med stor bokstav, andra lager som de heter. */
export const placeName = (name: string) => (name.trim().toLowerCase() === "hemma" ? "Hemma" : name);

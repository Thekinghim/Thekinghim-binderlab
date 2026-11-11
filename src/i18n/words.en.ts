/**
 * English small words shared by several texts: numbers, "3 packs", "2 batches",
 * "at Kontoret". Used by ./en.ts and by the round's own files in ./r2/. Swedish:
 * ./words.sv.ts.
 */

import { NBSP } from "@/lib/format";

import { formatters } from "./format";

export const f = formatters("en");
export const packs = (n: number) => `${f.int(n)}${NBSP}${n === 1 ? "pack" : "packs"}`;
export const batches = (n: number) => `${f.int(n)} ${n === 1 ? "batch" : "batches"}`;
/** Stock place names: "Hemma" is "at home", other places "at Kontoret". */
export const placeName = (name: string) => (name.trim().toLowerCase() === "hemma" ? "Home" : name);
export const inPlace = (name: string) => {
  const n = name.trim();
  return n.toLowerCase() === "hemma" ? "at home" : `at ${n}`;
};

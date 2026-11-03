/**
 * Gratis-pack: rena regler för "Ge bort ett pack" (inga anrop, ingen databas).
 *
 * - En kod i Awish (PickupCode) ger varan i ett visst fack (product_id) i en automat.
 *   Vi väljer facket med flest pack av varan, så att koden fungerar.
 * - Antal = antal koder (ett pack per kod). Kostnaden = inköpspriset den dagen × antal,
 *   och räknas i Lönsamhet som raden "Gratis-pack" på skapelsedagen.
 * - Koderna som Awish skapade = de i listan efter som inte fanns före, för samma fack.
 */

import { z } from "zod";

import type { IsoDate } from "@/domain";
import { comparableText } from "@/import/adapter";

import type { AwishPickupCode, AwishProduct } from "../awish/grpc-client";

export const FREE_PACK_MAX = 20;
export const FREE_PACK_DAYS = [7, 14, 30] as const;

export const FREE_PACK_REASONS = ["compensation", "giveaway", "staff", "other"] as const;
export type FreePackReason = (typeof FREE_PACK_REASONS)[number];

export const REASON_LABEL: Record<FreePackReason, string> = {
  compensation: "Kompensation",
  giveaway: "Giveaway",
  staff: "Butikspersonal",
  other: "Annat",
};

const noControl = /^[^\p{Cc}]*$/u;
const optionalText = (max: number, label: string) =>
  z
    .string()
    .trim()
    .max(max, `${label}: högst ${max} tecken.`)
    .regex(noControl, `${label} får inte ha radbrytningar.`)
    .transform((v) => (v === "" ? null : v))
    .nullable();

export const freePackInputSchema = z
  .object({
    machineId: z.string().uuid("Välj automat."),
    productId: z.string().regex(/^[0-9]{1,20}$/, "Välj titel."),
    quantity: z
      .number()
      .int()
      .min(1, "Minst 1.")
      .max(FREE_PACK_MAX, `Högst ${FREE_PACK_MAX} åt gången.`),
    days: z.union([z.literal(7), z.literal(14), z.literal(30)]),
    reason: z.enum(FREE_PACK_REASONS, { message: "Välj varför." }),
    recipient: optionalText(80, "Till"),
    note: optionalText(200, "Anteckning"),
  })
  .strict();
export type FreePackInput = z.infer<typeof freePackInputSchema>;

export class FreePackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FreePackError";
  }
}

/** En titel i automaten som går att ge bort. */
export interface FreePackOption {
  /** Facket koden gäller (Awish Products.id). */
  readonly productId: string;
  readonly goodName: string;
  /** Jämförbar nyckel (samma som aliasen). */
  readonly key: string;
  /** Pack i automaten nu (alla fack med varan). */
  readonly inMachine: number;
  /** Kanalerna, t.ex. "A1, A2". */
  readonly channels: string;
}

/** Varorna i automaten, med facket som har flest pack. Tomma fack och varor utan namn hoppas över. */
export function freePackOptions(products: readonly AwishProduct[]): FreePackOption[] {
  const groups = new Map<
    string,
    { name: string; best: AwishProduct; units: number; channels: string[] }
  >();
  for (const p of products) {
    const name = comparableText(p.goodName);
    if (name === "") continue;
    const key = name.toLowerCase();
    const g = groups.get(key);
    if (!g) {
      groups.set(key, {
        name,
        best: p,
        units: p.currentInventory,
        channels: p.channel ? [p.channel] : [],
      });
      continue;
    }
    g.units += p.currentInventory;
    if (p.channel) g.channels.push(p.channel);
    if (p.currentInventory > g.best.currentInventory) g.best = p;
  }
  return [...groups.entries()]
    .map(([key, g]) => ({
      productId: g.best.id,
      goodName: g.name,
      key,
      inMachine: g.units,
      channels: g.channels.sort((a, b) => a.localeCompare(b, "sv", { numeric: true })).join(", "),
    }))
    .sort((a, b) => b.inMachine - a.inMachine || a.goodName.localeCompare(b.goodName, "sv"));
}

/** Koderna som skapades: nya i listan efter (mot före), för facket. */
export function createdCodes(
  before: readonly AwishPickupCode[],
  after: readonly AwishPickupCode[],
  productId: string,
): AwishPickupCode[] {
  const known = new Set(before.map((c) => `${c.id}:${c.code}`));
  return after.filter(
    (c) => c.productId === productId && c.code !== "" && !known.has(`${c.id}:${c.code}`),
  );
}

/** Kostnaden: inköpspris × antal, eller null utan pris. */
export function freePackCost(
  unitCostOre: number | null,
  quantity: number,
): { unitCostOre: number | null; costOre: number | null } {
  if (unitCostOre === null) return { unitCostOre: null, costOre: null };
  return { unitCostOre, costOre: unitCostOre * quantity };
}

/** Texten att skicka till mottagaren (kopiera eller dela). */
export function shareText(input: {
  codes: readonly string[];
  goodName: string;
  place: string;
  expiresOn: IsoDate;
}): string {
  const many = input.codes.length > 1;
  const date = new Date(`${input.expiresOn}T12:00:00Z`).toLocaleDateString("sv-SE", {
    day: "numeric",
    month: "long",
    timeZone: "UTC",
  });
  return [
    `${many ? "Här är dina koder" : "Här är din kod"} för ${many ? `${input.codes.length} gratis pack` : "ett gratis pack"} ${input.goodName} i automaten ${input.place}:`,
    ...input.codes,
    `Ange koden på automatens skärm. Gäller till och med ${date}.`,
  ].join("\n");
}

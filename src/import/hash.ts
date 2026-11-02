/**
 * Hashar: filens sha256 (varning för samma fil igen) och källradens hash
 * (orders.source_hash) som avslöjar om en källrad avviker från den sparade
 * ordern.
 */

import { createHash } from "node:crypto";

import { comparableText, machineKeyOf, normalizeText, type RawOrder } from "./adapter";

export function sha256Hex(content: string | Uint8Array): string {
  return createHash("sha256")
    .update(typeof content === "string" ? Buffer.from(content, "utf8") : content)
    .digest("hex");
}

/** sh2: textfälten NFKC-normaliseras före hashningen (sh1 gjorde det inte). */
export const SOURCE_HASH_VERSION = "sh2";

/**
 * Hash av de tolkade fälten, inte av råtexten: "170" och "170.00", ett extra
 * mellanslag i produktnamnet eller samma namn i NFC och NFD ger samma hash; ett
 * annat belopp, en annan tid, titel, automat eller betalmetod ger en annan.
 *
 * Hashen sparas i orders.source_hash som spårbarhet. Om en källrad är en
 * dubblett avgörs av fälten (pipeline.ts, sameAsStored), så att äldre
 * hashversioner och exporter utan valfria kolumner jämförs rätt.
 */
export function sourceHash(order: RawOrder): string {
  const fields = [
    SOURCE_HASH_VERSION,
    normalizeText(order.externalId),
    comparableText(order.rawTitle),
    machineKeyOf(order),
    String(order.amountOre),
    order.paidAtUtc.toISOString(),
    comparableText(order.paymentMethod),
  ];
  return `${SOURCE_HASH_VERSION}:${sha256Hex(JSON.stringify(fields))}`;
}

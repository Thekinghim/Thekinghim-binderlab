/**
 * Hashar: filens sha256 (varning för samma fil igen) och källradens hash
 * (orders.source_hash) som avslöjar om en källrad avviker från den sparade
 * ordern.
 */

import { createHash } from "node:crypto";

import { machineKeyOf, type RawOrder } from "./adapter";

export function sha256Hex(content: string | Uint8Array): string {
  return createHash("sha256")
    .update(typeof content === "string" ? Buffer.from(content, "utf8") : content)
    .digest("hex");
}

export const SOURCE_HASH_VERSION = "sh1";

/**
 * Hash av de tolkade fälten, inte av råtexten: "170" och "170.00" eller ett
 * extra mellanslag i produktnamnet ger samma hash, ett annat belopp, en annan
 * tid, titel, automat eller betalmetod ger en annan.
 */
export function sourceHash(order: RawOrder): string {
  const fields = [
    SOURCE_HASH_VERSION,
    order.externalId,
    order.rawTitle.replace(/\s+/g, " ").trim(),
    machineKeyOf(order),
    String(order.amountOre),
    order.paidAtUtc.toISOString(),
    order.paymentMethod ?? "",
  ];
  return `${SOURCE_HASH_VERSION}:${sha256Hex(JSON.stringify(fields))}`;
}

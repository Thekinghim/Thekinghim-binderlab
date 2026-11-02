/**
 * Awish orderlista som CSV för seed-orderna, i samma format som en export
 * från Awish: UTF-8 med BOM, CRLF, nyaste ordern först, Payment Time och
 * Date i källans tidszon (Asia/Shanghai), beloppet som "Amount: 170.00".
 *
 * Filen läses sedan av den vanliga importen (src/import), så att seeden
 * bevisar hela importflödet.
 */

import { SOURCE_TIMEZONE } from "./catalog";
import { sourceTime, type SeedOrder } from "./orders";

export const AWISH_HEADER = [
  "ID",
  "Date",
  "Name",
  "Order No.",
  "Order Machine",
  "Payment Method",
  "Order Amount",
  "Is Paid",
  "Payment Time",
  "Actions",
] as const;

/** Öre → "170.00" med heltalsaritmetik. */
export function formatAwishAmount(ore: number): string {
  if (!Number.isSafeInteger(ore) || ore < 0) {
    throw new RangeError(`Ogiltigt belopp: ${ore}`);
  }
  const kronor = Math.floor(ore / 100);
  const rest = ore % 100;
  return `${kronor}.${String(rest).padStart(2, "0")}`;
}

function quote(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function needsQuote(value: string): boolean {
  return /[",\r\n]/.test(value);
}

function cell(value: string, alwaysQuote = false): string {
  return alwaysQuote || needsQuote(value) ? quote(value) : value;
}

/** CSV-texten (med BOM). Orderna kan komma i vilken ordning som helst. */
export function toAwishCsv(orders: readonly SeedOrder[], timeZone = SOURCE_TIMEZONE): string {
  const newestFirst = [...orders].sort((a, b) => b.paidAtMs - a.paidAtMs);
  const lines = [AWISH_HEADER.join(",")];
  for (const o of newestFirst) {
    lines.push(
      [
        String(o.awishId),
        sourceTime(o.createdAtMs, timeZone),
        cell(o.title, true),
        o.externalId,
        cell(o.awishMachine, true),
        cell(o.paymentMethod),
        quote(`Amount: ${formatAwishAmount(o.amountOre)}`),
        "Paid Success",
        sourceTime(o.paidAtMs, timeZone),
        "Details",
      ].join(","),
    );
  }
  return `﻿${lines.join("\r\n")}\r\n`;
}

/** Filnamnet som Awish ger en export av perioden. */
export const SEED_CSV_FILE_NAME = "awish-orderlista-2026-10-13--2026-11-01.csv";

/** CSV-filen som byte (UTF-8, BOM först). */
export function toAwishCsvBytes(orders: readonly SeedOrder[]): Uint8Array {
  return new TextEncoder().encode(toAwishCsv(orders));
}

/**
 * Testköp i Order (20261105070000_testkop.sql): rena hjälpare för listan och detaljvyn.
 * Ett testköp står kvar i listan med etiketten "Testköp" men räknas inte någonstans.
 */

import type { OrderDetail, OrderRow } from "./types";

export const TEST_PURCHASE_LABEL = "Testköp";
export const MARK_LABEL = "Markera som testköp";
export const UNDO_LABEL = "Ångra testköp";

/**
 * Är raden ett testköp? Listans rader laddas en gång; en markering eller ångring i
 * detaljvyn gäller direkt via `changed` (order-id → testköp), utan att listan laddas om.
 */
export function isTestPurchase(
  row: Pick<OrderRow, "id" | "testPurchase">,
  changed: ReadonlyMap<string, boolean>,
): boolean {
  return changed.get(row.id) ?? row.testPurchase;
}

/** "Markerat 3 nov. 2026 10:15 av Kim." (`at` formaterar tiden), eller null. */
export function testPurchaseNote(
  testPurchase: OrderDetail["testPurchase"],
  at: (iso: string) => string,
): string | null {
  if (!testPurchase) return null;
  const by = testPurchase.by?.trim();
  return `Markerat ${at(testPurchase.at)}${by ? ` av ${by}` : ""}.`;
}

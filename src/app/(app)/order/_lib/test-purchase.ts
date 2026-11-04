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

/** Bekräftelsen innan en order markeras som testköp (ett felklick tar bort en riktig försäljning). */
export const CONFIRM_TEXT = "Säker? Ordern räknas inte i vinsten.";
export const CONFIRM_LABEL = "Ja, markera";
export const CANCEL_LABEL = "Avbryt";

export type TestPurchaseStep = "idle" | "confirm";

/**
 * Vad ett tryck på testköpsknappen gör. Att markera kräver ett andra tryck på "Ja, markera"
 * (steget "confirm"); att ångra ett testköp gör det direkt, eftersom ordern då räknas igen.
 */
export function pressTestPurchase(
  step: TestPurchaseStep,
  isTest: boolean,
): { readonly step: TestPurchaseStep; readonly commit: boolean } {
  if (isTest) return { step: "idle", commit: true };
  return step === "confirm" ? { step: "idle", commit: true } : { step: "confirm", commit: false };
}

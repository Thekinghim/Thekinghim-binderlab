/**
 * Prisfältet vid en leverans ("+ Inköp" på Vårt lager och delägarens leveransformulär):
 * vad som står i fältet och vad det betyder. Ren och klientsäker.
 */

import { parseAmountOre } from "@/import/amount";

/** Samma tak som Inköpspriser (MAX_UNIT_COST_ORE, 100 000 kr per pack). */
const MAX_ORE = 10_000_000;

/** Priset som det skrivs i fältet: "112,50" (svenska) · "112.50" (engelska) · "118". */
export function priceFieldText(ore: number, locale: string): string {
  const whole = Math.floor(ore / 100);
  const cents = ore - whole * 100;
  if (cents === 0) return String(whole);
  return `${whole}${locale === "en" ? "." : ","}${String(cents).padStart(2, "0")}`;
}

export type ReceiptPriceState =
  /** Tomt fält: priset rörs inte. */
  | { readonly kind: "empty" }
  | { readonly kind: "invalid" }
  /** Samma som dagens pris: inget mer händer. */
  | { readonly kind: "same"; readonly ore: number }
  /** Ett annat pris än dagens (eller det första): sparas från i dag. */
  | { readonly kind: "new"; readonly ore: number };

export function receiptPriceState(text: string, currentOre: number | null): ReceiptPriceState {
  if (text.trim() === "") return { kind: "empty" };
  const r = parseAmountOre(text);
  if (!r.ok || r.ore > MAX_ORE) return { kind: "invalid" };
  return r.ore === currentOre ? { kind: "same", ore: r.ore } : { kind: "new", ore: r.ore };
}

/** Priset som skickas med leveransen, eller undefined (tomt fält). */
export function receiptPriceOre(state: ReceiptPriceState): number | undefined {
  return state.kind === "same" || state.kind === "new" ? state.ore : undefined;
}

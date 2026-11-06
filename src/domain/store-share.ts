/**
 * Butikernas andel i vår vinst: EN regel för alla våra vyer.
 *
 * I panelen är vår vinst och marginal FÖRE butikernas andel (intäkt − inköp − avgifter −
 * VMB-moms). Andelen (provision/vinstdelning per butikens eget avtal + hyra =
 * `compensationOre`) dras bara när vyn säger det: knappen "Visa butikernas andel" eller en
 * vald butik (`Settings.deductStoreShare`, satt av loadDomainInputFor). Då är vinsten "vår
 * del" efter andelen.
 *
 * Andelen räknas alltid likadant (ledger.ts, profit-split.ts): det butikerna ska ha
 * påverkas inte av vyn. Avräkningar, rapporter, bokföring och portalen anger inte flaggan
 * och drar därför andelen som förut.
 */

import type { Settings } from "./types";

/** Sant när butikernas andel dras från vår vinst (utelämnad flagga = dras). */
export function storeShareDeducted(settings: Pick<Settings, "deductStoreShare">): boolean {
  return settings.deductStoreShare !== false;
}

/** Det en prissatt order lämnar åt oss, före eller efter butikernas andel. */
export function entryProfitOre(
  e: {
    readonly netRevenueOre: number;
    readonly costOre: number;
    readonly cardFeeOre: number;
    readonly vmbVatOre: number;
    readonly commissionOre: number;
    readonly rentOre: number;
  },
  deductStoreShare: boolean,
): number {
  const before = e.netRevenueOre - e.costOre - e.cardFeeOre - e.vmbVatOre;
  return deductStoreShare ? before - e.commissionOre - e.rentOre : before;
}

/**
 * Om en vy drar butikernas andel: vyknappen "Visa butikernas andel" (`toggle`), eller en
 * vald butik (då just den butikens andel). Ett automatfilter är inget val av butik (skalet
 * lägger till automatens butik i adressen), så `machineId` stänger av butiksregeln.
 */
export function storeShareInView(view: {
  readonly toggle: boolean;
  readonly storeId?: string | null;
  readonly machineId?: string | null;
}): boolean {
  return view.toggle || (Boolean(view.storeId) && !view.machineId);
}

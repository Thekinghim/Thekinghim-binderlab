/**
 * Raden under avtalet på portalens Avräkning: "Uppsagt …", "Signerat 3 nov. 2026 av …",
 * "Signerat" eller "Inte signerat än". Signerat avgörs av `signed` (portal_contracts, samma
 * regel som ägarens Kontrakt), inte av om det finns en signatur med datum: ett avtal som
 * registrerats för hand är signerat utan signaturdatum. Ren, testas i contract-status.test.ts.
 */

import type { PortalContract } from "@/server/portal/settlements";

import { dateText } from "../_components/text";

export function portalContractStatus(
  c: Pick<PortalContract, "terminatedOn" | "signedAt" | "signerName" | "signed">,
): string {
  if (c.terminatedOn) return `Uppsagt, slutar ${dateText(c.terminatedOn)}`;
  if (c.signedAt) {
    const who = c.signerName ? ` av ${c.signerName}` : "";
    return `Signerat ${dateText(c.signedAt.slice(0, 10))}${who}`;
  }
  return c.signed ? "Signerat" : "Inte signerat än";
}

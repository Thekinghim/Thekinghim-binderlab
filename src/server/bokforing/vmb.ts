/**
 * VMB-momsen (samlad, per månad med underskott som förs vidare) bor i beräkningslagret,
 * src/domain/vmb.ts, så att bokföringen, butiksavräkningen och vår vinst räknar likadant.
 */

export {
  VMB_RATE_PERCENT,
  vmbChain,
  vmbVat,
  vmbVatOfMargin,
  type VmbInput,
  type VmbMonthInput,
  type VmbResult,
} from "@/domain/vmb";

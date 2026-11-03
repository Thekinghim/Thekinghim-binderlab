"use client";

import { ProfitBridge } from "@/components/charts/profit-bridge";
import { formatSek } from "@/lib/format";

import type { Bridge } from "../_lib/model";

/** Rad under vattenfallet när VMB-momsen inte är slutlig (en rad, kort). */
export const VMB_PRELIMINARY_TEXT = "VMB-momsen är preliminär: perioden är inte en avslutad månad.";

/** Vattenfallet Intäkt → (VMB-moms) → Inköp → Avgifter → Butiksersättning → Vinst, i kronor. */
export function LonsamhetBridge({ bridge }: { bridge: Bridge }) {
  return (
    <>
      <ProfitBridge
        revenue={bridge.revenueOre / 100}
        vmb={bridge.vmbVatOre === null ? undefined : bridge.vmbVatOre / 100}
        purchases={bridge.costOre / 100}
        fees={bridge.feesOre / 100}
        storeCompensation={bridge.compensationOre / 100}
        unpricedRevenue={
          bridge.unpricedRevenueOre > 0 ? bridge.unpricedRevenueOre / 100 : undefined
        }
        format={formatSek}
        height={300}
      />
      {bridge.vmbVatOre !== null && bridge.vmbPreliminary ? (
        <p className="meta mt-2 text-subtle">{VMB_PRELIMINARY_TEXT}</p>
      ) : null}
    </>
  );
}

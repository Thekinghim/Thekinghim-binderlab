"use client";

import { ProfitBridge } from "@/components/charts/profit-bridge";
import { formatSek } from "@/lib/format";

import type { Bridge } from "../_lib/model";

/** Vattenfallet Intäkt → Inköp → Avgifter → Butiksersättning → Vinst, i kronor. */
export function LonsamhetBridge({ bridge }: { bridge: Bridge }) {
  return (
    <ProfitBridge
      revenue={bridge.revenueOre / 100}
      purchases={bridge.costOre / 100}
      fees={bridge.feesOre / 100}
      storeCompensation={bridge.compensationOre / 100}
      unpricedRevenue={bridge.unpricedRevenueOre > 0 ? bridge.unpricedRevenueOre / 100 : undefined}
      format={formatSek}
      height={300}
    />
  );
}

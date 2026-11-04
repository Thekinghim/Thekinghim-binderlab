"use client";

import { ProfitBridge } from "@/components/charts/profit-bridge";
import { formatSek } from "@/lib/format";

import type { Bridge } from "../_lib/model";

/** Rad under vattenfallet när VMB-momsen inte är slutlig (en rad, kort). */
export const VMB_PRELIMINARY_TEXT = "VMB-momsen är preliminär: perioden är inte en avslutad månad.";

/** Steget för avgifterna när butikernas andel inte visas för sig (den dras ändå). */
export const FEES_AND_STORES_LABEL = "Avgifter och butiker";

/**
 * Vad vattenfallet ritar, i öre. Med butikernas andel (vyknappen eller vald butik):
 * Intäkt → (VMB-moms) → Inköp → Avgifter → Butikernas andel → Vår vinst. Utan: andelen
 * ligger i samma steg som avgifterna ("Avgifter och butiker"), så att stegen fortfarande
 * går ihop till vår vinst men andelen inte står som eget tal. Ren funktion (testas).
 */
export function bridgeSteps(bridge: Bridge): {
  feesOre: number;
  storeShareOre: number | null;
  feesLabel: string;
} {
  if (bridge.showStoreShare || bridge.compensationOre === 0) {
    return {
      feesOre: bridge.feesOre,
      storeShareOre: bridge.compensationOre,
      feesLabel: "Avgifter",
    };
  }
  return {
    feesOre: bridge.feesOre + bridge.compensationOre,
    storeShareOre: null,
    feesLabel: FEES_AND_STORES_LABEL,
  };
}

/** Vattenfallet från intäkt till vår vinst, i kronor. */
export function LonsamhetBridge({ bridge }: { bridge: Bridge }) {
  const steps = bridgeSteps(bridge);
  return (
    <>
      <ProfitBridge
        revenue={bridge.revenueOre / 100}
        vmb={bridge.vmbVatOre === null ? undefined : bridge.vmbVatOre / 100}
        purchases={bridge.costOre / 100}
        fees={steps.feesOre / 100}
        storeCompensation={steps.storeShareOre === null ? undefined : steps.storeShareOre / 100}
        unpricedRevenue={
          bridge.unpricedRevenueOre > 0 ? bridge.unpricedRevenueOre / 100 : undefined
        }
        labels={{
          fees: steps.feesLabel,
          storeCompensation: bridge.storeShareLabel,
          profit: "Vår vinst",
        }}
        format={formatSek}
        height={300}
      />
      {bridge.vmbVatOre !== null && bridge.vmbPreliminary ? (
        <p className="meta mt-2 text-subtle">{VMB_PRELIMINARY_TEXT}</p>
      ) : null}
    </>
  );
}

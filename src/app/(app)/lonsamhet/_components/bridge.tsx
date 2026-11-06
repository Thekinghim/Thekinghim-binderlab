"use client";

import { ProfitBridge } from "@/components/charts/profit-bridge";
import { formatSek } from "@/lib/format";

import type { Bridge } from "../_lib/model";

/** Rad under vattenfallet när VMB-momsen inte är slutlig (en rad, kort). */
export const VMB_PRELIMINARY_TEXT = "VMB-momsen är preliminär: perioden är inte en avslutad månad.";

/** Steget för butikernas andel utan vald butik (bara när andelen dras). */
export const TO_STORES_LABEL = "Till butikerna";

/**
 * Vad vattenfallet ritar, i öre. Av (standard): Intäkt → (VMB-moms) → Inköp → Avgifter →
 * Vår vinst, före butikernas andel (inget steg för andelen). På (vyknappen eller vald
 * butik): … → Avgifter → Till butikerna → Vår del. Avgifterna innehåller aldrig andelen.
 * Ren funktion (testas).
 */
export function bridgeSteps(bridge: Bridge): {
  feesOre: number;
  storeShareOre: number | null;
  storeShareLabel: string;
  /** Kort etikett när platsen inte räcker: "Till butikerna" för alla, "Till butiken" för en. */
  storeShareShort: string;
  profitLabel: string;
  /** Marginalen i bp, samma tal som nyckeltalet (inte en egen avrundning av kronorna). */
  marginBp: number | null;
} {
  const allStores = bridge.storeShareLabel === "Butikernas andel";
  return {
    feesOre: bridge.feesOre,
    storeShareOre: bridge.showStoreShare ? bridge.compensationOre : null,
    storeShareLabel: allStores ? TO_STORES_LABEL : bridge.storeShareLabel,
    storeShareShort: allStores ? TO_STORES_LABEL : "Till butiken",
    profitLabel: bridge.profitLabel,
    marginBp: bridge.marginBp,
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
        marginBp={steps.marginBp ?? undefined}
        labels={{
          fees: "Avgifter",
          storeCompensation: steps.storeShareLabel,
          storeCompensationShort: steps.storeShareShort,
          profit: steps.profitLabel,
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

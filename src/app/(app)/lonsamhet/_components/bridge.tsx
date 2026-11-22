"use client";

import type { CSSProperties } from "react";

import { cn } from "@/lib/cn";
import { formatMarginBp, formatSek } from "@/lib/format";

import "../../pengar/_components/money.css";

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

type Row = {
  key: string;
  label: string;
  kind: "revenue" | "cost" | "result";
  ore: number;
  from: number;
  to: number;
};

/**
 * Från intäkt till vår vinst, som vattenfallet på Pengar (V2): en rad per steg med etiketten,
 * ett spår där stapeln står där steget börjar och slutar, beloppet och andelen av intäkten.
 * Bara visning: beloppen och marginalen kommer färdiga från modellen. På telefon står spåret
 * under etiketten och beloppet.
 */
export function LonsamhetBridge({ bridge }: { bridge: Bridge }) {
  const steps = bridgeSteps(bridge);
  const rev = bridge.revenueOre;
  const scale = (ore: number) => (rev > 0 ? Math.max(0, Math.min(1, ore / rev)) : 0);
  const rows: Row[] = [
    { key: "revenue", label: "Intäkt", kind: "revenue", ore: rev, from: 0, to: rev > 0 ? 1 : 0 },
  ];
  let level = rev;
  const cost = (key: string, label: string, ore: number) => {
    const next = level - ore;
    rows.push({
      key,
      label,
      kind: "cost",
      ore: -ore,
      from: scale(Math.min(level, next)),
      to: scale(Math.max(level, next)),
    });
    level = next;
  };
  if (bridge.vmbVatOre !== null) cost("vmb", "VMB-moms", bridge.vmbVatOre);
  cost("cost", "Inköp", bridge.costOre);
  cost("fees", "Avgifter", steps.feesOre);
  if (steps.storeShareOre !== null) cost("share", steps.storeShareLabel, steps.storeShareOre);
  rows.push({
    key: "profit",
    label: steps.profitLabel,
    kind: "result",
    ore: bridge.profitOre,
    from: 0,
    to: scale(bridge.profitOre),
  });
  const share = (ore: number) =>
    rev > 0 ? formatMarginBp(Math.round((Math.abs(ore) * 10_000) / rev)) : "";
  const margin = steps.marginBp === null ? null : formatMarginBp(steps.marginBp);
  const summary = `Intäkt ${formatSek(rev / 100)} minus ${
    bridge.vmbVatOre !== null ? `VMB-moms ${formatSek(bridge.vmbVatOre / 100)}, ` : ""
  }inköp ${formatSek(bridge.costOre / 100)}, avgifter ${formatSek(steps.feesOre / 100)}${
    steps.storeShareOre !== null
      ? ` och ${steps.storeShareLabel.toLowerCase()} ${formatSek(steps.storeShareOre / 100)}`
      : ""
  } ger ${steps.profitLabel.toLowerCase()} ${formatSek(bridge.profitOre / 100)}${
    margin !== null ? `, marginal ${margin}` : ""
  }.`;
  return (
    <div className="g4">
      <p className="sr-only">{summary}</p>
      <div className="g4-wf" aria-hidden="true">
        {rows.map((row, i) => {
          const neg = row.kind === "result" && row.ore < 0;
          return (
            <div
              key={row.key}
              data-waterfall={row.key}
              className={cn(
                "g4-wrow",
                row.kind === "cost" && "c",
                row.kind === "result" && "sum",
                neg && "neg",
              )}
            >
              <div className="wl">
                <b>{row.label}</b>
              </div>
              <div className="g4-wtrack">
                <i
                  className={row.kind === "revenue" ? "rev" : row.kind === "result" ? "win" : ""}
                  style={
                    {
                      "--i": i,
                      left: `${row.from * 100}%`,
                      width: `max(${(row.to - row.from) * 100}%, ${row.to > row.from ? "4px" : "0px"})`,
                    } as CSSProperties
                  }
                />
              </div>
              <div className="wa">
                {row.ore < 0 ? "−" : ""}
                {formatSek(Math.abs(row.ore) / 100)}
                {row.kind === "result" && margin !== null ? (
                  <small>{` · ${margin}`}</small>
                ) : row.kind !== "revenue" ? (
                  <small>{share(row.ore)}</small>
                ) : null}
              </div>
              <div className="wp">
                {row.kind === "result" ? (margin ?? "") : row.kind === "cost" ? share(row.ore) : ""}
              </div>
            </div>
          );
        })}
      </div>
      {bridge.unpricedRevenueOre > 0 ? (
        <p className="g4-foot">
          {formatSek(bridge.unpricedRevenueOre / 100)} i intäkt saknar inköpspris och ingår inte.
        </p>
      ) : null}
      {bridge.vmbVatOre !== null && bridge.vmbPreliminary ? (
        <p className="g4-foot">{VMB_PRELIMINARY_TEXT}</p>
      ) : null}
    </div>
  );
}

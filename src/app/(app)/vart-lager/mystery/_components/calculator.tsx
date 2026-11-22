"use client";

import { KeyValues } from "@/components/v2/key-values";
import { useFormat, useT } from "@/i18n/client";
import { cn } from "@/lib/cn";

import { krAuto } from "../_lib/kr";
import type { MysteryCalc } from "../_lib/model";

/**
 * Kalkylen för ett mystery pack. Det viktigaste först: vinst och marginal per pack (före
 * butikens andel), sedan pris, kostnad per pack och per omgång, och raderna bakom kostnaden.
 * `draft` = ett innehåll som inte är sparat ("vad händer om"): räknas om för varje ändring.
 */
export function Calculator({
  calc,
  draft = false,
  lowestIn,
  className,
}: {
  calc: MysteryCalc;
  draft?: boolean;
  /** Automaterna har olika pris: koden för automaten med det låga priset som visas. */
  lowestIn?: string | null;
  className?: string;
}) {
  const t = useT();
  const f = useFormat();
  const kr = (ore: number) => krAuto(f, ore);
  const uneven = calc.quantity !== calc.batchSize;
  const loss = calc.profitOre !== null && calc.profitOre <= 0;

  return (
    <div
      data-testid={draft ? "kalkyl-utkast" : "kalkyl"}
      aria-live={draft ? "polite" : undefined}
      className={cn("mys-calc", draft && "draft", className)}
    >
      {draft ? <p className="v2-lab">{t.mystery.calcDraftTitle}</p> : null}

      <div className="profit">
        <span>{t.mystery.calcProfit}</span>
        <b data-testid="kalkyl-vinst" className={loss ? "loss" : undefined}>
          {calc.profitOre !== null ? kr(calc.profitOre) : "–"}
        </b>
      </div>

      <KeyValues
        items={[
          {
            key: "marginal",
            label: t.mystery.calcMargin,
            value: (
              <span data-testid="kalkyl-marginal">
                {calc.marginBp !== null ? f.marginBp(calc.marginBp, 0) : "–"}
              </span>
            ),
          },
          {
            key: "pris",
            label: t.mystery.salePrice,
            value: (
              <>
                {calc.salePriceOre !== null ? kr(calc.salePriceOre) : t.mystery.noSaleYet}
                {calc.salePriceOre !== null && lowestIn ? (
                  <span
                    data-testid="kalkyl-pris-automat"
                    className="block text-v2-xs font-normal text-v2-mute"
                  >
                    {t.mystery.salePriceLowestIn(lowestIn)}
                  </span>
                ) : null}
              </>
            ),
          },
          {
            key: "pack",
            label: t.mystery.calcCostPack,
            value: (
              <span data-testid="kalkyl-per-pack">
                {calc.perPackOre !== null ? kr(calc.perPackOre) : "–"}
              </span>
            ),
          },
          {
            key: "omgang",
            label: t.mystery.calcCostBatch(calc.batchSize),
            value: (
              <span data-testid="kalkyl-per-omgang">
                {calc.perBatchOre !== null ? kr(calc.perBatchOre) : "–"}
              </span>
            ),
          },
        ]}
      />

      {uneven ? (
        <p className="warn">{t.mystery.calcUneven(calc.quantity, calc.batchSize)}</p>
      ) : null}
      {calc.missing.length > 0 ? (
        <p className="warn">{t.mystery.missingPrices(calc.missing.join(", "))}</p>
      ) : null}
      {calc.complete && calc.salePriceOre === null ? (
        <p className="mys-mute">{t.mystery.calcNoSale}</p>
      ) : null}

      {calc.lines.length > 0 ? (
        <div className="rows">
          <p className="v2-lab">{t.mystery.calcRows}</p>
          <ul className="flex flex-col gap-1.5">
            {calc.lines.map((l) => (
              <li key={l.titleId}>
                <span className="min-w-0 [overflow-wrap:anywhere]">
                  <span className="block">{t.mystery.calcLine(l.quantity, l.name)}</span>
                  <small>
                    {l.unitCostOre !== null
                      ? t.mystery.calcEach(kr(l.unitCostOre))
                      : t.mystery.calcNoPrice}
                  </small>
                </span>
                <span className={cn("text-right", l.totalOre === null && "no")}>
                  {l.totalOre !== null ? kr(l.totalOre) : "–"}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <p className="mys-mute">{t.mystery.calcBeforeShare}</p>
    </div>
  );
}

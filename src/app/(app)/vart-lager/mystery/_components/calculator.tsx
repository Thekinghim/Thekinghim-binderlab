"use client";

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
      className={cn(
        "flex flex-col gap-4 rounded-md border bg-surface p-4",
        draft ? "border-dashed border-line-control" : "border-line-strong",
        className,
      )}
    >
      {draft ? <p className="label text-subtle">{t.mystery.calcDraftTitle}</p> : null}

      <div className="flex items-baseline justify-between gap-3">
        <span className="text-base text-fg">{t.mystery.calcProfit}</span>
        <span
          data-testid="kalkyl-vinst"
          className={cn("tnum text-2xl font-medium", loss ? "text-signal-fg" : "text-fg")}
        >
          {calc.profitOre !== null ? kr(calc.profitOre) : "–"}
        </span>
      </div>

      <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-2 border-t border-line pt-3 text-base">
        <dt className="text-muted">{t.mystery.calcMargin}</dt>
        <dd data-testid="kalkyl-marginal" className="tnum text-right text-fg">
          {calc.marginBp !== null ? f.marginBp(calc.marginBp, 0) : "–"}
        </dd>
        <dt className="text-muted">{t.mystery.salePrice}</dt>
        <dd className="tnum text-right text-fg">
          {calc.salePriceOre !== null ? kr(calc.salePriceOre) : t.mystery.noSaleYet}
          {calc.salePriceOre !== null && lowestIn ? (
            <span data-testid="kalkyl-pris-automat" className="block text-sm text-muted">
              {t.mystery.salePriceLowestIn(lowestIn)}
            </span>
          ) : null}
        </dd>
        <dt className="text-muted">{t.mystery.calcCostPack}</dt>
        <dd data-testid="kalkyl-per-pack" className="tnum text-right text-fg">
          {calc.perPackOre !== null ? kr(calc.perPackOre) : "–"}
        </dd>
        <dt className="text-muted">{t.mystery.calcCostBatch(calc.batchSize)}</dt>
        <dd data-testid="kalkyl-per-omgang" className="tnum text-right text-fg">
          {calc.perBatchOre !== null ? kr(calc.perBatchOre) : "–"}
        </dd>
      </dl>

      {uneven ? (
        <p className="text-base text-signal-fg">
          {t.mystery.calcUneven(calc.quantity, calc.batchSize)}
        </p>
      ) : null}
      {calc.missing.length > 0 ? (
        <p className="text-base text-signal-fg">
          {t.mystery.missingPrices(calc.missing.join(", "))}
        </p>
      ) : null}
      {calc.complete && calc.salePriceOre === null ? (
        <p className="text-base text-muted">{t.mystery.calcNoSale}</p>
      ) : null}

      {calc.lines.length > 0 ? (
        <div className="flex flex-col gap-2 border-t border-line pt-3">
          <p className="label text-subtle">{t.mystery.calcRows}</p>
          <ul className="flex flex-col gap-1.5">
            {calc.lines.map((l) => (
              <li
                key={l.titleId}
                className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-3 text-base"
              >
                <span className="flex min-w-0 flex-col">
                  <span className="[overflow-wrap:anywhere] text-fg">
                    {t.mystery.calcLine(l.quantity, l.name)}
                  </span>
                  <span className="tnum text-sm text-muted">
                    {l.unitCostOre !== null
                      ? t.mystery.calcEach(kr(l.unitCostOre))
                      : t.mystery.calcNoPrice}
                  </span>
                </span>
                <span
                  className={cn(
                    "tnum text-right",
                    l.totalOre !== null ? "text-fg" : "text-signal-fg",
                  )}
                >
                  {l.totalOre !== null ? kr(l.totalOre) : "–"}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <p className="meta text-subtle">{t.mystery.calcBeforeShare}</p>
    </div>
  );
}

import { cn } from "@/lib/cn";
import { formatInt, formatMarginBp, NBSP } from "@/lib/format";

import { recipeOdds, type Recipe } from "../_lib/model";

/**
 * Innehållet som på etiketten: en rad per set med "4 av 14" och chansen, HIT-märke på de
 * fina, och "21 % chans till hit" längst ner.
 */
export function ContentsCard({ recipe, className }: { recipe: Recipe; className?: string }) {
  const odds = recipeOdds(recipe);
  return (
    <div className={cn("flex flex-col rounded-md border border-line-strong bg-surface", className)}>
      <ul className="flex flex-col divide-y divide-line">
        {odds.items.map((i) => (
          <li
            key={i.titleId}
            className="grid grid-cols-[minmax(0,1fr)_auto_3.5rem] items-center gap-3 px-4 py-2.5"
          >
            <span className="flex min-w-0 items-center gap-2">
              <span className="truncate text-base text-fg">{i.name}</span>
              {i.hit ? (
                <span className="label shrink-0 rounded-xs border border-signal-line px-1.5 py-0.5 text-signal-fg">
                  HIT
                </span>
              ) : null}
            </span>
            <span className="tnum text-base whitespace-nowrap text-muted">
              {formatInt(i.quantity)}
              {NBSP}av{NBSP}
              {formatInt(recipe.batchSize)}
            </span>
            <span className="tnum text-right text-base text-fg">{formatMarginBp(i.bp, 0)}</span>
          </li>
        ))}
      </ul>
      <p className="flex items-baseline justify-between gap-3 border-t border-line-strong px-4 py-3">
        <span className="text-base text-fg">
          {odds.hits > 0 ? "Chans till hit" : "Ingen HIT markerad"}
        </span>
        {odds.hits > 0 ? (
          <span className="tnum text-lg font-medium text-fg">
            {formatMarginBp(odds.hitBp, 0)}
            <span className="text-base font-normal text-muted">
              {NBSP}({formatInt(odds.hits)}
              {NBSP}av{NBSP}
              {formatInt(recipe.batchSize)})
            </span>
          </span>
        ) : null}
      </p>
    </div>
  );
}

"use client";

import { useFormat, useT } from "@/i18n/client";
import { cn } from "@/lib/cn";
import { NBSP } from "@/lib/format";

import { recipeOdds, type Recipe } from "../_lib/model";

/**
 * Innehållet som på etiketten: en rad per set med "4 av 14" och chansen, HIT-märke på de
 * fina, och "21 % chans till hit" längst ner.
 */
export function ContentsCard({ recipe, className }: { recipe: Recipe; className?: string }) {
  const t = useT();
  const f = useFormat();
  const odds = recipeOdds(recipe);
  return (
    <div className={cn("mys-contents", className)}>
      <ul>
        {odds.items.map((i) => (
          <li key={i.titleId}>
            <span className="nm">
              <span>{i.name}</span>
              {i.hit ? <span className="v2-badge warning">{t.mystery.hit}</span> : null}
            </span>
            <span className="of">{t.mystery.of(i.quantity, recipe.batchSize)}</span>
            <span className="pc">{f.marginBp(i.bp, 0)}</span>
          </li>
        ))}
      </ul>
      <p className="sum">
        <span>{odds.hits > 0 ? t.mystery.hitChance : t.mystery.noHit}</span>
        {odds.hits > 0 ? (
          <span>
            <b>{f.marginBp(odds.hitBp, 0)}</b>
            <small>
              {NBSP}({t.mystery.of(odds.hits, recipe.batchSize)})
            </small>
          </span>
        ) : null}
      </p>
    </div>
  );
}

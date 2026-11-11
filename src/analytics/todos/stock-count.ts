/**
 * Inventering: en mild påminnelse när ett eget lager (Hemma, Kontoret …) inte har
 * inventerats på 30 dagar.
 *
 *   dagar       = dagens affärsdatum − dagen för senaste sparade inventeringen
 *                 (aldrig inventerat: dagen lagret skapades)
 *   flaggas när   dagar ≥ 30
 *   nivå        = alltid 'later' (när tid finns), inga kronor i risk
 *   fingerprint = senaste inventeringen: en avbockad punkt är borta tills lagret har
 *                 inventerats och det gått 30 dagar igen
 *
 * Bara ägare och admin får punkten (laddaren skickar `stockCounts` bara för dem).
 */

import { daysBetween, type IsoDate } from "@/domain";
import { evidence } from "./common";
import { urgencyOf, type TodoContext } from "./context";
import { day, plural } from "./text";
import { businessDateAt, tryParseInstant } from "./time";
import type { StockCountRef, TodoItem } from "./types";

/** Dagar utan inventering innan lagret tas upp. */
export const STOCK_COUNT_REMINDER_DAYS = 30;

/** Sidan där lagret inventeras, med lagret förvalt. */
export function stockCountLink(placeId?: string): string {
  return placeId
    ? `/vart-lager/inventering?lager=${encodeURIComponent(placeId)}`
    : "/vart-lager/inventering";
}

export interface StockCountAge {
  /** Dagen för senaste inventeringen, eller null om lagret aldrig inventerats. */
  readonly lastDate: IsoDate | null;
  /** Hela dagar sedan senaste inventeringen (affärsdatum), eller null. */
  readonly daysSince: number | null;
  /** Dags att inventera: 30 dagar sedan senaste (eller sedan lagret skapades). */
  readonly overdue: boolean;
}

/** Hur länge sedan ett lager inventerades. Samma regel på sidan och i Att göra. */
export function stockCountAge(
  ref: Pick<StockCountRef, "lastCountedAt" | "createdAt">,
  today: IsoDate,
  timeZone: string,
): StockCountAge {
  const dateOf = (iso: string | null): IsoDate | null => {
    const ms = iso ? tryParseInstant(iso) : null;
    return ms === null ? null : businessDateAt(ms, timeZone);
  };
  const lastDate = dateOf(ref.lastCountedAt);
  const daysSince = lastDate === null ? null : Math.max(0, daysBetween(lastDate, today));
  const created = dateOf(ref.createdAt);
  const idle = daysSince ?? (created === null ? 0 : Math.max(0, daysBetween(created, today)));
  return { lastDate, daysSince, overdue: idle >= STOCK_COUNT_REMINDER_DAYS };
}

export function stockCountTodos(ctx: TodoContext): TodoItem[] {
  const out: TodoItem[] = [];
  for (const place of ctx.input.stockCounts ?? []) {
    const age = stockCountAge(place, ctx.today, ctx.options.timeZone);
    if (!age.overdue) continue;
    out.push({
      key: `stock-count:${place.placeId}`,
      fingerprint: place.lastCountedAt ?? "none",
      kind: "stock-count",
      level: "later",
      urgency: urgencyOf("later", 0),
      atStakeOre: null,
      daysLeft: null,
      title: `Inventera ${place.name}`,
      detail:
        age.lastDate !== null && age.daysSince !== null
          ? `Senast inventerat ${day(age.lastDate)} (${plural(age.daysSince, "dag", "dagar")} sedan). Räkna packen så stämmer lagret.`
          : "Inte inventerat än. Räkna packen så stämmer lagret.",
      evidence: evidence({
        rule: `Lagret har inte inventerats på ${STOCK_COUNT_REMINDER_DAYS} dagar.`,
        dates: age.lastDate ? [age.lastDate] : [],
        figures:
          age.daysSince !== null
            ? [
                {
                  key: "daysSinceCount",
                  label: "Dagar sedan inventering",
                  value: age.daysSince,
                  unit: "days",
                },
              ]
            : [],
      }),
      link: stockCountLink(place.placeId),
      action: { kind: "count-stock", label: "Inventera", params: { placeId: place.placeId } },
    });
  }
  return out;
}

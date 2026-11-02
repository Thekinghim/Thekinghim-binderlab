import { cn } from "@/lib/cn";
import {
  EN_DASH,
  NBSP,
  formatDelta,
  formatInt,
  formatKronor,
  formatSignedKronor,
} from "@/lib/format";

import { formatDayShort, kr, timelineShares, type TimelineEntry } from "../_lib/model";

function range(e: TimelineEntry, today: string): string {
  const from = formatDayShort(e.validFrom, today);
  return e.validTo === null
    ? `${from}${NBSP}${EN_DASH} tills vidare`
    : `${from}${NBSP}${EN_DASH}${NBSP}${formatDayShort(e.validTo, today)}`;
}

/**
 * Prishistoriken för en titel: en tidslinje (äldst till vänster, bredd efter antal dagar)
 * och listan över priser, senaste först, med förändring och antal order per pris.
 */
export function PriceHistory({
  entries,
  today,
}: {
  entries: readonly TimelineEntry[];
  today: string;
}) {
  if (entries.length === 0) return null;
  const shares = timelineShares(entries, today);
  const chronological = entries.map((e, i) => ({ e, share: shares[i] ?? 0 })).reverse();

  return (
    <div className="flex flex-col gap-6">
      <div aria-hidden className="flex h-10 w-full min-w-0 items-end gap-px">
        {chronological.map(({ e, share }) => (
          <div
            key={e.validFrom}
            className="flex h-full min-w-0 flex-col justify-end gap-1.5"
            style={{ flexGrow: share, flexBasis: 0 }}
          >
            <span className="meta tnum truncate text-subtle">
              {formatKronor(kr(e.unitCostOre), { decimals: 0 })}
            </span>
            <span
              className={cn(
                "block h-2 w-full",
                e.current
                  ? "bg-data-1"
                  : e.future
                    ? "border border-dashed border-line-control"
                    : "bg-data-3",
              )}
            />
          </div>
        ))}
      </div>

      <ol className="flex flex-col">
        {entries.map((e) => (
          <li
            key={e.validFrom}
            className="grid grid-cols-[1fr_auto] items-baseline gap-x-4 gap-y-1 border-t border-line py-3 last:border-b sm:grid-cols-[minmax(0,1fr)_7rem_9rem_5rem]"
          >
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="meta tnum text-muted">
                {range(e, today)}
                {e.current ? <span className="label ml-2 text-fg">Gäller nu</span> : null}
                {e.future ? <span className="label ml-2 text-subtle">Kommande</span> : null}
              </span>
              {e.note ? <span className="text-sm text-subtle">{e.note}</span> : null}
            </span>
            <span className="tnum text-right text-base text-fg">
              {formatKronor(kr(e.unitCostOre))}
            </span>
            <span className="tnum col-start-1 text-sm text-subtle sm:col-start-auto sm:text-right">
              {e.deltaOre === null
                ? "Första priset"
                : `${formatSignedKronor(kr(e.deltaOre))}${e.deltaShare === null ? "" : ` · ${formatDelta(e.deltaShare, Math.abs(e.deltaShare) < 0.1 ? 1 : 0)}`}`}
            </span>
            <span className="tnum text-right text-sm text-subtle">
              {formatInt(e.orders)}
              {NBSP}order
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

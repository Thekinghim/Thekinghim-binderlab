"use client";

import { sum } from "d3-array";
import { useState } from "react";
import { cn } from "@/lib/cn";
import { formatPercent } from "@/lib/format";
import { ChartFigure } from "./primitives";

export type ShareSegment = { label: string; value: number };

type ShareBarProps = {
  segments: ReadonlyArray<ShareSegment>;
  format: (v: number) => string;
  /** Index som markeras med signalfärg */
  highlightIndex?: number;
  summary: string;
  /** Visa förklarande lista under stapeln */
  showList?: boolean;
};

const FILLS = [
  "var(--bl-data-1)",
  "var(--bl-data-2)",
  "var(--bl-data-3)",
  "var(--bl-data-4)",
  "var(--bl-data-5)",
];

/** 100 %-stapel. Segment sorteras störst först; listan under gör den läsbar utan färg. */
export function ShareBar({
  segments,
  format,
  highlightIndex,
  summary,
  showList = true,
}: ShareBarProps) {
  const [active, setActive] = useState<number | null>(null);
  const total = sum(segments, (s) => s.value) || 1;
  const fill = (i: number) =>
    i === highlightIndex ? "var(--bl-signal)" : (FILLS[Math.min(i, FILLS.length - 1)] ?? "");

  return (
    <ChartFigure summary={summary}>
      <div
        className="flex h-7 w-full gap-0.5"
        onPointerLeave={() => setActive(null)}
        role="img"
        aria-label={summary}
      >
        {segments.map((s, i) => {
          const share = s.value / total;
          return (
            <div
              key={s.label}
              onPointerEnter={() => setActive(i)}
              className={cn(
                "relative h-full min-w-[3px] transition-opacity duration-[120ms]",
                active !== null && active !== i && "opacity-40",
              )}
              style={{ width: `${share * 100}%`, background: fill(i) }}
            >
              {share > 0.12 ? (
                <span
                  className="label tnum absolute top-1/2 left-2 -translate-y-1/2 text-[10px]"
                  style={{
                    color:
                      i === highlightIndex
                        ? "var(--bl-on-signal)"
                        : i <= 1
                          ? "var(--bl-bg)"
                          : "var(--bl-fg)",
                  }}
                >
                  {formatPercent(share)}
                </span>
              ) : null}
            </div>
          );
        })}
      </div>
      {/* Skala 0–100 */}
      <div className="mt-1.5 flex justify-between" aria-hidden>
        {[0, 25, 50, 75, 100].map((t) => (
          <span key={t} className="label tnum text-[10px] text-faint">
            {t}
          </span>
        ))}
      </div>
      {showList ? (
        <ul className="mt-4 flex flex-col">
          {segments.map((s, i) => (
            <li
              key={s.label}
              onPointerEnter={() => setActive(i)}
              onPointerLeave={() => setActive(null)}
              className={cn(
                "grid h-8 grid-cols-[12px_1fr_auto_auto] items-center gap-3 border-b border-line text-base transition-colors duration-[120ms] last:border-b-0",
                active === i ? "text-fg" : "text-muted",
              )}
            >
              <span aria-hidden className="size-2.5" style={{ background: fill(i) }} />
              <span className="truncate">{s.label}</span>
              <span className="tnum font-mono text-sm">{format(s.value)}</span>
              <span className="tnum w-12 text-right font-mono text-sm text-fg">
                {formatPercent(s.value / total)}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </ChartFigure>
  );
}

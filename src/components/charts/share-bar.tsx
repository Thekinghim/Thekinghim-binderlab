"use client";

import { sum } from "d3-array";
import { useId, useState } from "react";
import { cn } from "@/lib/cn";
import { formatPercent } from "@/lib/format";
import { useMeasure } from "@/lib/hooks/use-measure";
import { ChartFigure, HatchPattern } from "./primitives";

export type ShareSegment = {
  label: string;
  value: number;
  /** Kräver åtgärd: signalfärg + `note` som text */
  flag?: boolean;
  note?: string;
};

type ShareBarProps = {
  segments: ReadonlyArray<ShareSegment>;
  format: (v: number) => string;
  /**
   * Post som betonas i fg (standard: största). Betoning, aldrig signal.
   * Signal bara via `flag` på segmentet eller `alertIndex`.
   */
  highlightIndex?: number;
  /** Post som kräver åtgärd */
  alertIndex?: number;
  summary: string;
  /**
   * "list" (standard): listan är diagrammet. En rad per post med egen 4 px
   * stapel, belopp och andel högerställda. "bar": kompakt 100 %-stapel med
   * direktetiketter, för smala ytor.
   */
  variant?: "list" | "bar";
  /** @deprecated showList={false} motsvarar variant="bar". */
  showList?: boolean;
};

const pct = (share: number) => formatPercent(share, 0);

/** Andelar av en helhet. Högst tre gråtoner: fg för betonad post, mellangrå för resten. */
export function ShareBar({
  segments,
  format,
  highlightIndex,
  alertIndex,
  summary,
  variant,
  showList = true,
}: ShareBarProps) {
  const [active, setActive] = useState<number | null>(null);
  const total = sum(segments, (s) => s.value) || 1;
  const largest = segments.reduce(
    (b, s, i) => (s.value > (segments[b]?.value ?? -Infinity) ? i : b),
    0,
  );
  const emph = highlightIndex ?? largest;
  const mode = variant ?? (showList ? "list" : "bar");

  if (mode === "bar") {
    return (
      <CompactShare
        segments={segments}
        total={total}
        emph={emph}
        alertIndex={alertIndex}
        summary={summary}
      />
    );
  }

  return (
    <ChartFigure summary={summary}>
      <ul className="flex flex-col" aria-label={summary} onPointerLeave={() => setActive(null)}>
        {segments.map((s, i) => {
          const share = s.value / total;
          const isEmph = i === emph;
          const isAlert = s.flag || i === alertIndex;
          return (
            <li
              key={s.label}
              onPointerEnter={() => setActive(i)}
              className={cn(
                "grid grid-cols-[minmax(0,1fr)_auto_3.5rem] items-center gap-x-4 gap-y-2 border-b border-line py-2.5 transition-colors duration-[120ms] last:border-b-0",
                "sm:grid-cols-[minmax(0,10rem)_minmax(0,1fr)_auto_3.5rem] sm:py-2",
              )}
            >
              <span
                className={cn(
                  "truncate text-sm",
                  isEmph || isAlert || active === i ? "text-fg" : "text-muted",
                )}
              >
                {s.label}
                {isAlert ? (
                  <span className="label ml-2 text-signal-fg">! {s.note ?? "Kräver åtgärd"}</span>
                ) : null}
              </span>
              <span
                aria-hidden
                className="relative col-span-3 row-start-2 h-1 bg-line sm:col-span-1 sm:col-start-2 sm:row-start-1"
              >
                <span
                  className={cn(
                    "absolute inset-y-0 left-0 transition-colors duration-[120ms]",
                    isAlert
                      ? "bg-signal"
                      : isEmph
                        ? "bg-data-1"
                        : active === i
                          ? "bg-data-2"
                          : "bg-data-3",
                  )}
                  style={{ width: `${Math.max(0.5, share * 100)}%` }}
                />
              </span>
              <span className="tnum text-right font-mono text-sm text-muted sm:col-start-3">
                {format(s.value)}
              </span>
              <span
                className={cn(
                  "tnum text-right font-mono text-sm sm:col-start-4",
                  isEmph || isAlert ? "font-medium text-fg" : "text-muted",
                )}
              >
                {pct(share)}
              </span>
            </li>
          );
        })}
      </ul>
    </ChartFigure>
  );
}

/**
 * Kompakt 100 %-stapel. Varje segment får en etikett under stapeln med en
 * 1 px ledlinje till segmentets början. Etiketter som inte ryms bredvid
 * varandra läggs på nästa nivå (högst tre), så att ingen etikett hamnar i en
 * separat förklaringsrad. Segment som kräver åtgärd skrafferas i signal med
 * 2 px ram och får alltid "! note" som text, så att larmet syns i svartvitt.
 */
function CompactShare({
  segments,
  total,
  emph,
  alertIndex,
  summary,
}: {
  segments: ReadonlyArray<ShareSegment>;
  total: number;
  emph: number;
  alertIndex?: number;
  summary: string;
}) {
  const [ref, width] = useMeasure<HTMLDivElement>();
  const hatchId = useId().replace(/:/g, "");
  const BAR = 10;
  const GAP = 2;
  const LEVEL = 18;
  // Geist Mono 12 px ≈ 7,2 px per tecken
  const CH12 = 7.2;
  const shares = segments.map((s) => s.value / total);
  const starts = shares.map((_, i) => sum(shares.slice(0, i)));

  const levelEnds: number[] = [];
  const segs = segments.map((s, i) => {
    const share = shares[i] ?? 0;
    const start = starts[i] ?? 0;
    const isAlert = !!s.flag || i === alertIndex;
    const note = isAlert ? `! ${s.note ?? "Kräver åtgärd"}` : "";
    const main = `${s.label} ${pct(share)}`;
    const w = (main.length + (note ? note.length + 1 : 0)) * CH12 + 8;
    const tick = Math.min(width - 1, start * width);
    // Högerkanten: etiketten slutar vid ledlinjen i stället för att klippas
    const flip = tick + w > width;
    const left = flip ? tick - w : tick;
    let level = levelEnds.findIndex((end) => left >= end + 8);
    if (level === -1) level = Math.min(levelEnds.length, 2);
    levelEnds[level] = Math.max(levelEnds[level] ?? -Infinity, left + w);
    return { s, i, share, start, main, note, isAlert, tick, flip, level };
  });
  const levels = Math.max(1, levelEnds.length);

  // Segmentens rektanglar med 2 px mellanrum
  const rects = segs.map(({ start, share }) => {
    const x = start * width + (start > 0 ? GAP / 2 : 0);
    const w = Math.max(2, share * width - GAP);
    return { x, w };
  });

  return (
    <ChartFigure summary={summary}>
      <div ref={ref} className="relative w-full" style={{ height: BAR + 6 + levels * LEVEL }}>
        <svg width={width} height={BAR} className="block" role="img" aria-label={summary}>
          <defs>
            <HatchPattern id={hatchId} tone="signal" />
          </defs>
          {segs.map(({ s, i, isAlert }) => {
            const r = rects[i] ?? { x: 0, w: 0 };
            return isAlert ? (
              <rect
                key={s.label}
                x={r.x + 1}
                y={1}
                width={Math.max(0, r.w - 2)}
                height={BAR - 2}
                strokeWidth={2}
                style={{ fill: `url(#${hatchId})`, stroke: "var(--bl-signal)" }}
              />
            ) : (
              <rect
                key={s.label}
                x={r.x}
                y={0}
                width={r.w}
                height={BAR}
                style={{
                  fill: i === emph ? "var(--bl-data-1)" : i % 2 ? "var(--bl-data-3)" : "var(--bl-data-4)",
                }}
              />
            );
          })}
        </svg>
        {segs.map(({ s, i, main, note, isAlert, tick, flip, level }) => {
          const top = BAR + 6 + level * LEVEL;
          return (
            <div key={s.label} aria-hidden>
              <span
                className={cn("absolute w-px", i === emph || isAlert ? "bg-fg" : "bg-line-strong")}
                style={{ left: tick, top: BAR + 2, height: top - BAR - 2 + 14 }}
              />
              <span
                className={cn(
                  "tnum meta absolute whitespace-nowrap",
                  i === emph || isAlert ? "text-fg" : "text-subtle",
                )}
                style={{
                  top,
                  ...(flip ? { right: width - tick + 6 } : { left: tick + 6 }),
                }}
              >
                {main}
                {note ? <span className="ml-2 text-signal-fg">{note}</span> : null}
              </span>
            </div>
          );
        })}
      </div>
    </ChartFigure>
  );
}

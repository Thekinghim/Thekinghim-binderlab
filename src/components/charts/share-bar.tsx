"use client";

import { sum } from "d3-array";
import { useId, useState, type ReactNode } from "react";
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

  const list = (
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
                "grid grid-cols-[minmax(0,1fr)_auto_3.5rem] items-center gap-x-4 gap-y-2 border-b border-line py-2.5 transition-colors duration-fast last:border-b-0",
                "sm:grid-cols-[minmax(0,10rem)_minmax(0,1fr)_auto_3.5rem] sm:py-2",
              )}
            >
              <span
                className={cn(
                  "flex min-w-0 flex-col text-sm",
                  isEmph || isAlert || active === i ? "text-fg" : "text-muted",
                )}
              >
                <span className="truncate">{s.label}</span>
                {/* Larmet på egen rad: text som kräver åtgärd kapas aldrig. */}
                {isAlert ? (
                  <span className="label text-signal-fg">! {s.note ?? "Kräver åtgärd"}</span>
                ) : null}
              </span>
              <span
                aria-hidden
                className="relative col-span-3 row-start-2 h-1 bg-line sm:col-span-1 sm:col-start-2 sm:row-start-1"
              >
                <span
                  className={cn(
                    "absolute inset-y-0 left-0 transition-colors duration-fast",
                    // Stapeln visar intäkt; larmet gäller ett annat mått och bärs av texten.
                    isEmph ? "bg-data-1" : active === i ? "bg-data-2" : "bg-data-3",
                  )}
                  style={{ width: `${Math.max(0.5, share * 100)}%` }}
                />
              </span>
              <span className="tnum text-right text-sm text-muted sm:col-start-3">
                {format(s.value)}
              </span>
              <span
                className={cn(
                  "tnum text-right text-sm sm:col-start-4",
                  isEmph ? "font-medium text-fg" : "text-muted",
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

  if (mode === "bar") {
    return (
      <CompactShare
        segments={segments}
        total={total}
        emph={emph}
        alertIndex={alertIndex}
        summary={summary}
        fallback={list}
      />
    );
  }

  return list;
}

type Placed = {
  s: ShareSegment;
  i: number;
  main: string;
  note: string;
  isAlert: boolean;
  tick: number;
  left: boolean;
  span: [number, number];
  level: number;
};

/**
 * Trappa av etiketter: varje etikett har en ledlinje från segmentets mitt.
 * Täcker etikett A ledlinjen till B (eller krockar de) måste A ligga på en
 * djupare nivå än B, annars korsar ledlinjen texten. Nivån blir längsta vägen
 * i det beroendet. Cykel = ingen giltig trappa i den riktningen.
 */
function stairs(
  items: ReadonlyArray<Omit<Placed, "left" | "span" | "level">>,
  widths: ReadonlyArray<number>,
  width: number,
  dir: "right" | "left",
): Placed[] | null {
  const GAP = 8;
  const placed = items.map((it, k) => {
    const w = widths[k] ?? 0;
    // Riktning: önskad, men aldrig utanför stapelns bredd
    const left = dir === "left" ? it.tick - w >= 0 : it.tick + w > width && it.tick - w >= 0;
    const span: [number, number] = left ? [it.tick - w, it.tick] : [it.tick, it.tick + w];
    return { ...it, left, span, level: 0 };
  });
  const n = placed.length;
  const deeper: number[][] = placed.map(() => []);
  for (let a = 0; a < n; a++) {
    for (let b = 0; b < n; b++) {
      if (a === b) continue;
      const A = placed[a];
      const B = placed[b];
      if (!A || !B) continue;
      const covers = B.tick >= A.span[0] - GAP && B.tick <= A.span[1] + GAP;
      const overlap = A.span[0] < B.span[1] + GAP && B.span[0] < A.span[1] + GAP;
      // Krock utan täckning: senare etikett läggs djupare
      if (covers || (overlap && a > b)) deeper[a]?.push(b);
    }
  }
  const state = new Array<number>(n).fill(0); // 0 ny, 1 pågår, 2 klar
  const depth = (k: number): number => {
    if (state[k] === 1) return Infinity;
    const p = placed[k];
    if (!p) return 0;
    if (state[k] === 2) return p.level;
    state[k] = 1;
    let lv = 0;
    for (const j of deeper[k] ?? []) lv = Math.max(lv, depth(j) + 1);
    state[k] = 2;
    p.level = lv;
    return lv;
  };
  for (let k = 0; k < n; k++) if (!Number.isFinite(depth(k))) return null;
  return placed;
}

/**
 * Kompakt 100 %-stapel. Varje segment får en etikett under stapeln med en
 * 1 px ledlinje från segmentets mitt, ordnade som en trappa så att ingen
 * ledlinje korsar en etikett och ingen etikett hamnar i en separat
 * förklaringsrad. Ryms det inte inom fyra nivåer visas listan i stället.
 * Segment som kräver åtgärd skrafferas i signal med 2 px ram och får alltid
 * "! note" som text, så att larmet syns även i svartvitt.
 */
function CompactShare({
  segments,
  total,
  emph,
  alertIndex,
  summary,
  fallback,
}: {
  segments: ReadonlyArray<ShareSegment>;
  total: number;
  emph: number;
  alertIndex?: number;
  summary: string;
  fallback: ReactNode;
}) {
  const [ref, width] = useMeasure<HTMLDivElement>();
  const hatchId = useId().replace(/:/g, "");
  const BAR = 10;
  const GAP = 2;
  const LEVEL = 18;
  const MAX_LEVELS = 4;
  // Geist Mono 12 px ≈ 7,2 px per tecken, plus 6 px avstånd till ledlinjen
  const CH12 = 7.2;
  const shares = segments.map((s) => s.value / total);
  const starts = shares.map((_, i) => sum(shares.slice(0, i)));

  const items = segments.map((s, i) => {
    const share = shares[i] ?? 0;
    const start = starts[i] ?? 0;
    const isAlert = !!s.flag || i === alertIndex;
    const note = isAlert ? `! ${s.note ?? "Kräver åtgärd"}` : "";
    const main = `${s.label} ${pct(share)}`;
    const tick = Math.round((start + share / 2) * width) + 0.5;
    return { s, i, main, note, isAlert, tick };
  });
  const widths = items.map(
    (it) => (it.main.length + (it.note ? it.note.length + 1 : 0)) * CH12 + 6,
  );
  const layout = width
    ? [stairs(items, widths, width, "right"), stairs(items, widths, width, "left")]
        .filter((l): l is Placed[] => l !== null)
        .map((l) => ({ l, levels: 1 + Math.max(0, ...l.map((p) => p.level)) }))
        .sort((a, b) => a.levels - b.levels)[0]
    : undefined;

  // Mätytan finns alltid kvar, så att stapeln kommer tillbaka när ytan blir bredare
  if (width && (!layout || layout.levels > MAX_LEVELS))
    return (
      <div ref={ref} className="w-full">
        {fallback}
      </div>
    );
  const placed = layout?.l ?? [];
  const levels = layout?.levels ?? 1;

  // Segmentens rektanglar med 2 px mellanrum
  const rects = segments.map((_, i) => {
    const start = starts[i] ?? 0;
    const share = shares[i] ?? 0;
    const x = start * width + (start > 0 ? GAP / 2 : 0);
    return { x, w: Math.max(2, share * width - GAP) };
  });

  return (
    <ChartFigure summary={summary}>
      <div ref={ref} className="relative w-full" style={{ height: BAR + 6 + levels * LEVEL }}>
        <svg width={width} height={BAR} className="block" role="img" aria-label={summary}>
          <defs>
            <HatchPattern id={hatchId} tone="signal" />
          </defs>
          {segments.map((s, i) => {
            const r = rects[i] ?? { x: 0, w: 0 };
            const isAlert = !!s.flag || i === alertIndex;
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
                  fill:
                    i === emph
                      ? "var(--bl-data-1)"
                      : i % 2
                        ? "var(--bl-data-3)"
                        : "var(--bl-data-4)",
                }}
              />
            );
          })}
        </svg>
        {placed.map(({ s, i, main, note, isAlert, tick, left, level }) => {
          const top = BAR + 4 + level * LEVEL;
          const strong = i === emph || isAlert;
          return (
            <div key={s.label} aria-hidden>
              <span
                className={cn("absolute w-px", strong ? "bg-fg" : "bg-line-strong")}
                style={{ left: tick - 0.5, top: BAR + 2, height: top - BAR - 2 + 15 }}
              />
              <span
                className={cn(
                  "tnum meta absolute whitespace-nowrap",
                  strong ? "text-fg" : "text-subtle",
                )}
                style={{ top, ...(left ? { right: width - tick + 6 } : { left: tick + 6 }) }}
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

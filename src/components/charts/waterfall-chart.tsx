"use client";

import { scaleBand, scaleLinear } from "d3-scale";
import { useId, useMemo, useState } from "react";
import { useMeasure } from "@/lib/hooks/use-measure";
import { AxisText, ChartFigure, Readout } from "./primitives";

export type WaterfallStep = {
  label: string;
  /** Förändring (positiv/negativ). Ignoreras för total. */
  value: number;
  /** Totalstapel räknas från noll till löpande summa */
  total?: boolean;
  /** Markera steget som kritiskt (signalfärg) */
  flag?: boolean;
  name?: string;
};

type WaterfallProps = {
  steps: ReadonlyArray<WaterfallStep>;
  format: (v: number) => string;
  formatAxis?: (v: number) => string;
  height?: number;
  summary: string;
};

const M = { top: 28, right: 8, bottom: 32, left: 48 };

/**
 * Vattenfall: från brutto till netto. Totaler fyllda, ökningar ljusgrå,
 * minskningar skrafferade (skillnad i mönster, inte bara färg).
 */
export function WaterfallChart({
  steps,
  format,
  formatAxis = format,
  height = 260,
  summary,
}: WaterfallProps) {
  const [ref, width] = useMeasure<HTMLDivElement>();
  const [active, setActive] = useState<number | null>(null);
  const hatchId = useId().replace(/:/g, "");

  const g = useMemo(() => {
    let run = 0;
    const bars: Array<WaterfallStep & { start: number; end: number }> = [];
    for (const s of steps) {
      if (s.total) {
        bars.push({ ...s, start: 0, end: run, value: run });
      } else {
        const start = run;
        run += s.value;
        bars.push({ ...s, start, end: run });
      }
    }
    const innerW = Math.max(10, width - M.left - M.right);
    const innerH = height - M.top - M.bottom;
    const hi = Math.max(...bars.map((b) => Math.max(b.start, b.end)), 1);
    const lo = Math.min(0, ...bars.map((b) => Math.min(b.start, b.end)));
    const x = scaleBand<number>()
      .domain(bars.map((_, i) => i))
      .range([0, innerW])
      .paddingInner(0.32)
      .paddingOuter(0.08);
    const y = scaleLinear().domain([lo, hi]).range([innerH, 0]).nice(4);
    return { bars, innerW, innerH, x, y };
  }, [steps, width, height]);

  const bw = g.x.bandwidth();
  const narrow = g.x.step() < 52;
  const a = active !== null ? g.bars[active] : undefined;

  return (
    <ChartFigure summary={summary}>
      <div ref={ref} className="relative w-full" style={{ height }}>
        <svg
          width={width}
          height={height}
          className="absolute top-0 left-0 block overflow-visible"
          role="img"
          aria-label={summary}
          onPointerLeave={() => setActive(null)}
        >
          <defs>
            <pattern
              id={hatchId}
              width="4"
              height="4"
              patternUnits="userSpaceOnUse"
              patternTransform="rotate(45)"
            >
              <line
                x1="0"
                y1="0"
                x2="0"
                y2="4"
                style={{ stroke: "var(--bl-data-3)" }}
                strokeWidth="1.25"
              />
            </pattern>
          </defs>
          <g transform={`translate(${M.left},${M.top})`}>
            {g.y.ticks(4).map((t) => (
              <g key={t}>
                <line
                  x1={0}
                  x2={g.innerW}
                  y1={g.y(t)}
                  y2={g.y(t)}
                  style={{ stroke: t === 0 ? "var(--bl-line-strong)" : "var(--bl-line)" }}
                  strokeDasharray={t === 0 ? undefined : "1 3"}
                />
                <AxisText x={-8} y={g.y(t)} anchor="end" baseline="middle">
                  {formatAxis(t)}
                </AxisText>
              </g>
            ))}

            {g.bars.map((b, i) => {
              const x = g.x(i) ?? 0;
              const top = g.y(Math.max(b.start, b.end));
              const h = Math.max(1, Math.abs(g.y(b.start) - g.y(b.end)));
              const neg = !b.total && b.value < 0;
              const next = g.bars[i + 1];
              const isActive = active === i;
              return (
                <g key={i} onPointerEnter={() => setActive(i)} onPointerDown={() => setActive(i)}>
                  <rect x={x - 4} y={0} width={bw + 8} height={g.innerH} fill="transparent" />
                  <rect
                    x={x + 0.5}
                    y={top + 0.5}
                    width={bw - 1}
                    height={h - 1}
                    strokeWidth={1}
                    style={{
                      fill: b.flag
                        ? "var(--bl-signal-soft)"
                        : b.total
                          ? isActive
                            ? "var(--bl-data-1)"
                            : "var(--bl-data-2)"
                          : neg
                            ? `url(#${hatchId})`
                            : "var(--bl-data-4)",
                      stroke: b.flag
                        ? "var(--bl-signal)"
                        : isActive
                          ? "var(--bl-fg)"
                          : b.total
                            ? "var(--bl-data-2)"
                            : "var(--bl-data-3)",
                    }}
                    className="transition-[stroke,fill] duration-[120ms]"
                  />
                  {/* Kopplingslinje till nästa steg */}
                  {next ? (
                    <line
                      x1={x + bw}
                      x2={g.x(i + 1) ?? 0}
                      y1={g.y(b.end)}
                      y2={g.y(b.end)}
                      style={{ stroke: "var(--bl-fg-faint)" }}
                      strokeDasharray="2 2"
                    />
                  ) : null}
                  {!narrow || b.total || b.flag ? (
                    <text
                      x={x + bw / 2}
                      y={top - 6}
                      textAnchor="middle"
                      className="tnum"
                      style={{
                        fontFamily: "var(--bl-font-mono)",
                        fontSize: 10,
                        fill: b.flag
                          ? "var(--bl-signal-fg)"
                          : b.total
                            ? "var(--bl-fg)"
                            : "var(--bl-fg-muted)",
                      }}
                    >
                      {b.total || i === 0
                        ? formatAxis(b.value)
                        : `${b.value > 0 ? "+" : "−"}${formatAxis(Math.abs(b.value))}`}
                    </text>
                  ) : null}
                  <AxisText x={x + bw / 2} y={g.innerH + 18} emphasis={b.total || isActive}>
                    {narrow ? b.label.slice(0, 4) : b.label}
                  </AxisText>
                </g>
              );
            })}
          </g>
        </svg>
        {a && active !== null ? (
          <Readout
            x={M.left + (g.x(active) ?? 0) + bw}
            y={M.top}
            containerWidth={width}
            label={a.name ?? a.label}
            rows={[
              {
                name: a.total ? "Summa" : "Förändring",
                value: a.total
                  ? format(a.value)
                  : `${a.value > 0 ? "+" : "−"}${format(Math.abs(a.value))}`,
                strong: true,
              },
              ...(a.total ? [] : [{ name: "Löpande", value: format(a.end) }]),
            ]}
          />
        ) : null}
      </div>
    </ChartFigure>
  );
}

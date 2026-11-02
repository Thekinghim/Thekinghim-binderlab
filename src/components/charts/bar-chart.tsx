"use client";

import { max as d3max, mean } from "d3-array";
import { scaleBand, scaleLinear } from "d3-scale";
import { useMemo, useState, type KeyboardEvent } from "react";
import { useMeasure } from "@/lib/hooks/use-measure";
import { AxisText, ChartFigure, Readout } from "./primitives";

export type BarDatum = {
  label: string;
  value: number;
  /** Längre namn i läsrutan */ name?: string;
};

type BarChartProps = {
  data: ReadonlyArray<BarDatum>;
  format: (v: number) => string;
  formatAxis?: (v: number) => string;
  /** Stapel som markeras med signalfärg och värdeetikett */
  highlightIndex?: number;
  /** Annotering ovanför markerad stapel */
  highlightNote?: string;
  /** Visa snittlinje */
  showMean?: boolean;
  height?: number;
  summary: string;
};

const M = { top: 40, right: 8, bottom: 28, left: 44 };

export function BarChart({
  data,
  format,
  formatAxis = format,
  highlightIndex,
  highlightNote,
  showMean = true,
  height = 240,
  summary,
}: BarChartProps) {
  const [ref, width] = useMeasure<HTMLDivElement>();
  const [active, setActive] = useState<number | null>(null);

  const g = useMemo(() => {
    const innerW = Math.max(10, width - M.left - M.right);
    const innerH = height - M.top - M.bottom;
    const x = scaleBand<number>()
      .domain(data.map((_, i) => i))
      .range([0, innerW])
      .paddingInner(innerW / data.length < 24 ? 0.2 : 0.38)
      .paddingOuter(0.1);
    const y = scaleLinear()
      .domain([0, d3max(data, (d) => d.value) ?? 1])
      .range([innerH, 0])
      .nice(4);
    const labelEvery = Math.max(1, Math.ceil((data.length * 44) / innerW));
    return { innerW, innerH, x, y, avg: mean(data, (d) => d.value) ?? 0, labelEvery };
  }, [data, width, height]);

  const onKey = (e: KeyboardEvent<SVGSVGElement>) => {
    const cur = active ?? highlightIndex ?? 0;
    let next = cur;
    if (e.key === "ArrowRight") next = Math.min(data.length - 1, cur + 1);
    else if (e.key === "ArrowLeft") next = Math.max(0, cur - 1);
    else if (e.key === "Escape") return setActive(null);
    else return;
    e.preventDefault();
    setActive(next);
  };

  const bw = g.x.bandwidth();
  const a = active !== null ? data[active] : undefined;
  const hl = highlightIndex !== undefined ? data[highlightIndex] : undefined;

  return (
    <ChartFigure summary={summary}>
      <div ref={ref} className="relative w-full" style={{ height }}>
        <svg
          width={width}
          height={height}
          className="absolute top-0 left-0 block overflow-visible outline-none focus-visible:outline-2 focus-visible:outline-offset-4"
          tabIndex={0}
          role="img"
          aria-label={`${summary} Använd piltangenterna för att läsa av staplar.`}
          onKeyDown={onKey}
          onFocus={() => setActive((v) => v ?? highlightIndex ?? 0)}
          onBlur={() => setActive(null)}
          onPointerLeave={() => setActive(null)}
        >
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

            {data.map((d, i) => {
              const x = g.x(i) ?? 0;
              const isHl = i === highlightIndex;
              const isActive = i === active;
              const y = g.y(d.value);
              return (
                <g key={i}>
                  {/* Träffyta i full höjd för enkel hover/touch */}
                  <rect
                    x={x - (g.x.step() - bw) / 2}
                    y={0}
                    width={g.x.step()}
                    height={g.innerH}
                    fill="transparent"
                    onPointerEnter={() => setActive(i)}
                    onPointerDown={() => setActive(i)}
                  />
                  <rect
                    x={x}
                    y={y}
                    width={bw}
                    height={Math.max(0, g.innerH - y)}
                    pointerEvents="none"
                    className="transition-[fill] duration-[120ms]"
                    style={{
                      fill: isHl
                        ? "var(--bl-signal)"
                        : isActive
                          ? "var(--bl-data-1)"
                          : "var(--bl-data-4)",
                    }}
                  />
                  {/* Topplinje: ger stapeln en ritad kant */}
                  {!isHl ? (
                    <line
                      x1={x}
                      x2={x + bw}
                      y1={y + 0.5}
                      y2={y + 0.5}
                      pointerEvents="none"
                      style={{ stroke: "var(--bl-data-2)" }}
                    />
                  ) : null}
                  {i % g.labelEvery === 0 || isHl ? (
                    <AxisText x={x + bw / 2} y={g.innerH + 18} emphasis={isHl || isActive}>
                      {d.label}
                    </AxisText>
                  ) : null}
                </g>
              );
            })}

            {showMean ? (
              <g pointerEvents="none">
                <line
                  x1={0}
                  x2={g.innerW}
                  y1={g.y(g.avg)}
                  y2={g.y(g.avg)}
                  style={{ stroke: "var(--bl-fg-muted)" }}
                  strokeDasharray="4 3"
                />
                <rect
                  x={g.innerW - 92}
                  y={g.y(g.avg) - 18}
                  width={92}
                  height={14}
                  style={{ fill: "var(--bl-surface)" }}
                />
                <AxisText x={g.innerW} y={g.y(g.avg) - 8} anchor="end">
                  {`Snitt ${formatAxis(g.avg)}`}
                </AxisText>
              </g>
            ) : null}

            {hl && highlightIndex !== undefined ? (
              <g pointerEvents="none">
                <line
                  x1={(g.x(highlightIndex) ?? 0) + bw / 2}
                  x2={(g.x(highlightIndex) ?? 0) + bw / 2}
                  y1={g.y(hl.value) - 4}
                  y2={-M.top + 26}
                  style={{ stroke: "var(--bl-fg-faint)" }}
                />
                <text
                  x={
                    (g.x(highlightIndex) ?? 0) +
                    bw / 2 +
                    ((g.x(highlightIndex) ?? 0) > g.innerW * 0.6 ? -6 : 6)
                  }
                  y={-M.top + 12}
                  textAnchor={(g.x(highlightIndex) ?? 0) > g.innerW * 0.6 ? "end" : "start"}
                  style={{ fill: "var(--bl-fg)", fontSize: 12, fontWeight: 500 }}
                >
                  {format(hl.value)}
                </text>
                {highlightNote ? (
                  <AxisText
                    x={
                      (g.x(highlightIndex) ?? 0) +
                      bw / 2 +
                      ((g.x(highlightIndex) ?? 0) > g.innerW * 0.6 ? -6 : 6)
                    }
                    y={-M.top + 26}
                    anchor={(g.x(highlightIndex) ?? 0) > g.innerW * 0.6 ? "end" : "start"}
                  >
                    {highlightNote}
                  </AxisText>
                ) : null}
              </g>
            ) : null}

            {a && active !== null ? (
              <line
                pointerEvents="none"
                x1={(g.x(active) ?? 0) + bw / 2}
                x2={(g.x(active) ?? 0) + bw / 2}
                y1={0}
                y2={g.innerH}
                style={{ stroke: "var(--bl-fg-faint)" }}
                strokeDasharray="2 2"
              />
            ) : null}
          </g>
        </svg>
        {a && active !== null ? (
          <Readout
            x={M.left + (g.x(active) ?? 0) + bw}
            y={M.top}
            containerWidth={width}
            label={a.name ?? a.label}
            rows={[
              { value: format(a.value), strong: true },
              {
                name: "Mot snitt",
                value: `${a.value >= g.avg ? "+" : "−"}${format(Math.abs(a.value - g.avg))}`,
              },
            ]}
          />
        ) : null}
      </div>
    </ChartFigure>
  );
}

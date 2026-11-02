"use client";

import { extent, max as d3max } from "d3-array";
import { scaleLinear, scaleTime } from "d3-scale";
import { area, curveMonotoneX, line } from "d3-shape";
import { useMemo, useState, type KeyboardEvent, type PointerEvent } from "react";
import { useMeasure } from "@/lib/hooks/use-measure";
import { formatDay, formatWeekdayDay } from "@/lib/format";
import { AxisText, ChartFigure, Node, Readout, nearestIndex } from "./primitives";

export type LinePoint = { date: Date; value: number };

export type Annotation = {
  index: number;
  /** Huvudtext, t.ex. "+42 % mot veckan innan" */
  text: string;
  /** Andra rad i monospace, t.ex. "LÖR 26 OKT" */
  sub?: string;
};

type LineChartProps = {
  data: ReadonlyArray<LinePoint>;
  /** Jämförelseserie (föregående period), samma längd. Ritas streckad. */
  compare?: ReadonlyArray<number>;
  format: (v: number) => string;
  /** Kort format för y-axel */
  formatAxis?: (v: number) => string;
  annotations?: ReadonlyArray<Annotation>;
  /** Index som markeras med signalfärg (t.ex. bästa dagen) */
  highlightIndex?: number;
  /** Horisontell hjälplinje, t.ex. snitt eller mål */
  reference?: { value: number; label: string };
  area?: boolean;
  height?: number;
  summary: string;
  seriesName?: string;
  compareName?: string;
};

const M = { top: 56, right: 12, bottom: 28, left: 44 };

export function LineChart({
  data,
  compare,
  format,
  formatAxis = format,
  annotations = [],
  highlightIndex,
  reference,
  area: showArea = true,
  height = 280,
  summary,
  seriesName = "Period",
  compareName = "Föregående",
}: LineChartProps) {
  const [ref, width] = useMeasure<HTMLDivElement>();
  const [active, setActive] = useState<number | null>(null);

  const geo = useMemo(() => {
    const innerW = Math.max(10, width - M.left - M.right);
    const innerH = height - M.top - M.bottom;
    const [d0 = new Date(), d1 = new Date()] = extent(data, (d) => d.date);
    const x = scaleTime().domain([d0, d1]).range([0, innerW]);
    const top = Math.max(
      d3max(data, (d) => d.value) ?? 1,
      d3max(compare ?? []) ?? 0,
      reference?.value ?? 0,
    );
    const y = scaleLinear().domain([0, top]).range([innerH, 0]).nice(4);
    const xs = data.map((d) => x(d.date));
    const pts = data.map((d, i) => [xs[i] ?? 0, y(d.value)] as [number, number]);
    const cmp = compare?.map((v, i) => [xs[i] ?? 0, y(v)] as [number, number]);
    const lineGen = line().curve(curveMonotoneX);
    const areaGen = area<[number, number]>()
      .curve(curveMonotoneX)
      .x((p) => p[0])
      .y0(innerH)
      .y1((p) => p[1]);
    const tickCount = Math.max(2, Math.min(data.length, Math.floor(innerW / 72)));
    const step = Math.max(1, Math.ceil(data.length / tickCount));
    return {
      innerW,
      innerH,
      x,
      y,
      xs,
      pts,
      linePath: lineGen(pts) ?? "",
      areaPath: areaGen(pts) ?? "",
      cmpPath: cmp ? (lineGen(cmp) ?? "") : null,
      yTicks: y.ticks(4),
      xTickIdx: data.map((_, i) => i).filter((i) => i % step === 0),
    };
  }, [data, compare, reference, width, height]);

  const showNodes = data.length > 0 && geo.innerW / data.length > 9;

  const onMove = (e: PointerEvent<SVGRectElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    setActive(nearestIndex(geo.xs, e.clientX - rect.left));
  };

  const onKey = (e: KeyboardEvent<SVGSVGElement>) => {
    const cur = active ?? highlightIndex ?? data.length - 1;
    let next = cur;
    if (e.key === "ArrowRight") next = Math.min(data.length - 1, cur + 1);
    else if (e.key === "ArrowLeft") next = Math.max(0, cur - 1);
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = data.length - 1;
    else if (e.key === "Escape") return setActive(null);
    else return;
    e.preventDefault();
    setActive(next);
  };

  const a = active !== null ? data[active] : undefined;
  const ax = active !== null ? (geo.xs[active] ?? 0) : 0;

  return (
    <ChartFigure summary={summary}>
      <div ref={ref} className="relative w-full" style={{ height }}>
        <svg
          width={width}
          height={height}
          className="absolute top-0 left-0 block overflow-visible outline-none focus-visible:outline-2 focus-visible:outline-offset-4"
          tabIndex={0}
          role="img"
          aria-label={`${summary} Använd piltangenterna för att läsa av värden.`}
          onKeyDown={onKey}
          onFocus={() => setActive((v) => v ?? highlightIndex ?? data.length - 1)}
          onBlur={() => setActive(null)}
        >
          <g transform={`translate(${M.left},${M.top})`}>
            {/* Hjälplinjer */}
            {geo.yTicks.map((t) => (
              <g
                key={t}
                opacity={reference && Math.abs(geo.y(t) - geo.y(reference.value)) < 14 ? 0 : 1}
              >
                <line
                  x1={0}
                  x2={geo.innerW}
                  y1={geo.y(t)}
                  y2={geo.y(t)}
                  style={{ stroke: t === 0 ? "var(--bl-line-strong)" : "var(--bl-line)" }}
                  strokeDasharray={t === 0 ? undefined : "1 3"}
                />
                <AxisText x={-8} y={geo.y(t)} anchor="end" baseline="middle">
                  {formatAxis(t)}
                </AxisText>
              </g>
            ))}
            {geo.xTickIdx.map((i) => {
              const d = data[i];
              if (!d) return null;
              return (
                <g key={i}>
                  <line
                    x1={geo.xs[i]}
                    x2={geo.xs[i]}
                    y1={geo.innerH}
                    y2={geo.innerH + 4}
                    style={{ stroke: "var(--bl-line-strong)" }}
                  />
                  <AxisText x={geo.xs[i] ?? 0} y={geo.innerH + 18}>
                    {formatDay(d.date)}
                  </AxisText>
                </g>
              );
            })}

            {reference ? (
              <g>
                <line
                  x1={0}
                  x2={geo.innerW}
                  y1={geo.y(reference.value)}
                  y2={geo.y(reference.value)}
                  style={{ stroke: "var(--bl-fg-subtle)" }}
                  strokeDasharray="4 3"
                />
                {/* Värdet som tagg i axelmarginalen, namnet i änden av linjen */}
                <rect
                  x={-M.left}
                  y={geo.y(reference.value) - 8}
                  width={M.left - 4}
                  height={16}
                  style={{ fill: "var(--bl-surface)", stroke: "var(--bl-fg-subtle)" }}
                />
                <AxisText x={-8} y={geo.y(reference.value)} anchor="end" baseline="middle" emphasis>
                  {formatAxis(reference.value)}
                </AxisText>
              </g>
            ) : null}

            {showArea ? (
              <path d={geo.areaPath} style={{ fill: "var(--bl-fg)", opacity: 0.045 }} />
            ) : null}
            {geo.cmpPath ? (
              <path
                d={geo.cmpPath}
                fill="none"
                style={{ stroke: "var(--bl-data-4)" }}
                strokeWidth={1}
                strokeDasharray="3 3"
              />
            ) : null}
            <path
              d={geo.linePath}
              fill="none"
              style={{ stroke: "var(--bl-data-1)" }}
              strokeWidth={1.25}
            />

            {reference ? (
              <g>
                <rect
                  x={geo.innerW - reference.label.length * 6.6 - 10}
                  y={geo.y(reference.value) - 22}
                  width={reference.label.length * 6.6 + 10}
                  height={14}
                  style={{ fill: "var(--bl-surface)" }}
                />
                <AxisText x={geo.innerW - 4} y={geo.y(reference.value) - 11} anchor="end">
                  {reference.label}
                </AxisText>
              </g>
            ) : null}

            {showNodes
              ? geo.pts.map(([px, py], i) =>
                  i === highlightIndex ? null : (
                    <Node key={i} x={px} y={py} size={5} variant="hollow" />
                  ),
                )
              : null}

            {/* Annoteringar direkt i diagrammet */}
            {annotations.map((an) => {
              const p = geo.pts[an.index];
              if (!p) return null;
              const labelY = -M.top + 8;
              const right = p[0] > geo.innerW * 0.62;
              const tx = right ? p[0] - 8 : p[0] + 8;
              return (
                <g key={an.index}>
                  <line
                    x1={p[0]}
                    x2={p[0]}
                    y1={labelY + 4}
                    y2={p[1] - 8}
                    style={{ stroke: "var(--bl-fg-faint)" }}
                  />
                  <line
                    x1={p[0]}
                    x2={right ? p[0] - 4 : p[0] + 4}
                    y1={labelY + 4}
                    y2={labelY + 4}
                    style={{ stroke: "var(--bl-fg-faint)" }}
                  />
                  <text
                    x={tx}
                    y={labelY + 8}
                    textAnchor={right ? "end" : "start"}
                    style={{
                      fill: "var(--bl-fg)",
                      fontSize: 12,
                      fontWeight: 500,
                      fontFamily: "var(--bl-font-sans)",
                    }}
                  >
                    {an.text}
                  </text>
                  {an.sub ? (
                    <AxisText x={tx} y={labelY + 24} anchor={right ? "end" : "start"}>
                      {an.sub}
                    </AxisText>
                  ) : null}
                </g>
              );
            })}

            {highlightIndex !== undefined && geo.pts[highlightIndex] ? (
              <Node
                x={geo.pts[highlightIndex][0]}
                y={geo.pts[highlightIndex][1]}
                size={6}
                variant="signal-ring"
              />
            ) : null}

            {/* Crosshair */}
            {a ? (
              <g pointerEvents="none">
                <line
                  x1={ax}
                  x2={ax}
                  y1={0}
                  y2={geo.innerH}
                  style={{ stroke: "var(--bl-fg-muted)" }}
                  strokeWidth={1}
                />
                <line
                  x1={0}
                  x2={geo.innerW}
                  y1={geo.y(a.value)}
                  y2={geo.y(a.value)}
                  style={{ stroke: "var(--bl-fg-faint)" }}
                  strokeDasharray="2 2"
                />
                <rect
                  x={-M.left}
                  y={geo.y(a.value) - 8}
                  width={M.left - 4}
                  height={16}
                  style={{ fill: "var(--bl-fg)" }}
                />
                <text
                  x={-8}
                  y={geo.y(a.value)}
                  textAnchor="end"
                  dominantBaseline="middle"
                  style={{ fill: "var(--bl-bg)", fontFamily: "var(--bl-font-mono)", fontSize: 10 }}
                >
                  {formatAxis(a.value)}
                </text>
                {compare?.[active ?? 0] !== undefined ? (
                  <Node x={ax} y={geo.y(compare[active ?? 0] ?? 0)} size={5} variant="hollow" />
                ) : null}
                <Node
                  x={ax}
                  y={geo.y(a.value)}
                  size={7}
                  variant={active === highlightIndex ? "signal" : "solid"}
                />
              </g>
            ) : null}

            <rect
              x={0}
              y={0}
              width={geo.innerW}
              height={geo.innerH}
              fill="transparent"
              onPointerMove={onMove}
              onPointerDown={onMove}
              onPointerLeave={() => setActive(null)}
              style={{ touchAction: "pan-y" }}
            />
          </g>
        </svg>

        {a && active !== null ? (
          <Readout
            x={M.left + ax}
            y={M.top}
            containerWidth={width}
            label={formatWeekdayDay(a.date)}
            rows={[
              {
                name: seriesName,
                value: format(a.value),
                strong: true,
                marker: <span className="inline-block h-px w-3 bg-fg" />,
              },
              ...(compare?.[active] !== undefined
                ? [
                    {
                      name: compareName,
                      value: format(compare[active] ?? 0),
                      marker: (
                        <span className="inline-block w-3 border-t border-dashed border-data-3" />
                      ),
                    },
                  ]
                : []),
            ]}
          />
        ) : null}
      </div>
    </ChartFigure>
  );
}

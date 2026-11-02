"use client";

import { max as d3max } from "d3-array";
import { scaleBand, scaleQuantize } from "d3-scale";
import { useMemo, useState } from "react";
import { useMeasure } from "@/lib/hooks/use-measure";
import { AxisText, ChartFigure, Readout } from "./primitives";

type HeatmapProps = {
  /** values[rad][kolumn] */
  values: ReadonlyArray<ReadonlyArray<number>>;
  rowLabels: ReadonlyArray<string>;
  colLabels: ReadonlyArray<string>;
  format: (v: number) => string;
  /** Text för läsrutan, t.ex. (rad, kol) => "Lör 14–15" */
  cellLabel?: (row: number, col: number) => string;
  /** Markera högsta cellen med signalram */
  markMax?: boolean;
  summary: string;
  cellHeight?: number;
};

// Sex steg i gråskala. Steg ger läsbarhet och fungerar i båda lägena.
const RAMP = [
  "var(--bl-data-0)",
  "var(--bl-data-5)",
  "var(--bl-data-4)",
  "var(--bl-data-3)",
  "var(--bl-data-2)",
  "var(--bl-data-1)",
];

const M = { top: 4, right: 0, bottom: 22, left: 36 };

export function Heatmap({
  values,
  rowLabels,
  colLabels,
  format,
  cellLabel,
  markMax = true,
  summary,
  cellHeight = 24,
}: HeatmapProps) {
  const [ref, width] = useMeasure<HTMLDivElement>();
  const [active, setActive] = useState<[number, number] | null>(null);
  const height = M.top + M.bottom + rowLabels.length * cellHeight;

  const g = useMemo(() => {
    const innerW = Math.max(10, width - M.left - M.right);
    const x = scaleBand<number>()
      .domain(colLabels.map((_, i) => i))
      .range([0, innerW])
      .paddingInner(0.08);
    const y = scaleBand<number>()
      .domain(rowLabels.map((_, i) => i))
      .range([0, rowLabels.length * cellHeight])
      .paddingInner(0.08);
    const top = d3max(values.flat()) ?? 1;
    const q = scaleQuantize<number>().domain([0, top]).range([0, 1, 2, 3, 4, 5]);
    let maxCell: [number, number] = [0, 0];
    values.forEach((row, r) =>
      row.forEach((v, c) => {
        if (v === top) maxCell = [r, c];
      }),
    );
    const labelEvery = Math.max(1, Math.ceil((colLabels.length * 26) / innerW));
    return { innerW, x, y, q, top, maxCell, labelEvery };
  }, [values, rowLabels, colLabels, width, cellHeight]);

  const thresholds = [0, ...g.q.thresholds()];
  const av = active ? values[active[0]]?.[active[1]] : undefined;

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
          <g transform={`translate(${M.left},${M.top})`}>
            {rowLabels.map((rl, r) => (
              <AxisText
                key={rl}
                x={-8}
                y={(g.y(r) ?? 0) + g.y.bandwidth() / 2}
                anchor="end"
                baseline="middle"
                emphasis={active?.[0] === r}
              >
                {rl}
              </AxisText>
            ))}
            {colLabels.map((cl, c) =>
              c % g.labelEvery === 0 ? (
                <AxisText
                  key={cl}
                  x={(g.x(c) ?? 0) + g.x.bandwidth() / 2}
                  y={rowLabels.length * cellHeight + 15}
                  emphasis={active?.[1] === c}
                >
                  {cl}
                </AxisText>
              ) : null,
            )}
            {values.map((row, r) =>
              row.map((v, c) => {
                const isActive = active?.[0] === r && active?.[1] === c;
                return (
                  <rect
                    key={`${r}-${c}`}
                    x={g.x(c)}
                    y={g.y(r)}
                    width={g.x.bandwidth()}
                    height={g.y.bandwidth()}
                    rx={1}
                    style={{
                      fill: RAMP[g.q(v)],
                      stroke: isActive ? "var(--bl-fg)" : "var(--bl-line)",
                    }}
                    strokeWidth={isActive ? 1.5 : 0.5}
                    onPointerEnter={() => setActive([r, c])}
                    onPointerDown={() => setActive([r, c])}
                  />
                );
              }),
            )}
            {markMax ? (
              <rect
                pointerEvents="none"
                x={(g.x(g.maxCell[1]) ?? 0) - 2.5}
                y={(g.y(g.maxCell[0]) ?? 0) - 2.5}
                width={g.x.bandwidth() + 5}
                height={g.y.bandwidth() + 5}
                fill="none"
                style={{ stroke: "var(--bl-signal)" }}
                strokeWidth={1.25}
              />
            ) : null}
          </g>
        </svg>
        {active && av !== undefined ? (
          <Readout
            x={M.left + (g.x(active[1]) ?? 0) + g.x.bandwidth()}
            y={M.top + (g.y(active[0]) ?? 0) + g.y.bandwidth() + 4}
            containerWidth={width}
            label={
              cellLabel
                ? cellLabel(active[0], active[1])
                : `${rowLabels[active[0]]} ${colLabels[active[1]]}`
            }
            rows={[
              { value: format(av), strong: true },
              { name: "Andel av topp", value: `${Math.round((av / g.top) * 100)} %` },
            ]}
          />
        ) : null}
      </div>
      {/* Skala: steg med gränsvärden */}
      <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2" aria-hidden>
        <div className="flex items-center">
          {RAMP.map((c, i) => (
            <span key={i} className="flex flex-col items-start">
              <span
                className="h-2.5 w-8 border-y border-line first:border-l last:border-r"
                style={{ background: c }}
              />
              <span className="label tnum mt-1 text-[10px] text-subtle">
                {i % 2 === 0 ? format(thresholds[i] ?? 0) : " "}
              </span>
            </span>
          ))}
        </div>
        {markMax ? (
          <span className="label flex items-center gap-1.5 text-subtle">
            <span className="size-2.5 border border-signal" /> Topptimme
          </span>
        ) : null}
      </div>
    </ChartFigure>
  );
}

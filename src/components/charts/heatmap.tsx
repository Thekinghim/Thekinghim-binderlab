"use client";

import { max as d3max } from "d3-array";
import { scaleBand, scaleThreshold } from "d3-scale";
import { useMemo, useState, type KeyboardEvent } from "react";
import { formatInt } from "@/lib/format";
import { svgSizeProps, unmeasuredStyle, useMeasure } from "@/lib/hooks/use-measure";
import { niceThresholds } from "./axis";
import { AxisText, ChartFigure, Readout } from "./primitives";

type HeatmapProps = {
  /** values[rad][kolumn] */
  values: ReadonlyArray<ReadonlyArray<number>>;
  rowLabels: ReadonlyArray<string>;
  colLabels: ReadonlyArray<string>;
  /** Exakt värde i läsruta och toppannotering, t.ex. v => "41 köp" */
  format: (v: number) => string;
  /** Text för läsrutan och toppannoteringen, t.ex. (rad, kol) => "Lör 13–14" */
  cellLabel?: (row: number, col: number) => string;
  /**
   * Stegens nedre gränser, stigande, t.ex. [10, 20, 30, 40] ger stegen
   * 1–9, 10–19, 20–29, 30–39 och 40+. 0 ritas alltid som tom ruta.
   * Standard: jämna gränser utifrån största värdet (högst fem fyllda steg).
   */
  thresholds?: ReadonlyArray<number>;
  /** Enhet, skrivs en gång vid skalan, t.ex. "köp/tim" */
  unit?: string;
  /** Markera högsta cellen med fg-ram och annotering. Aldrig signal. */
  markMax?: boolean;
  summary: string;
  cellHeight?: number;
};

/**
 * Högst fem fyllda steg. Ljusaste steget ligger tydligt över ytan i mörkt
 * läge, och tomma rutor (0) är bara en kant, så att 0 och "lite" skiljs åt.
 * I utskrift ger rampen fem steg med ca 20 % ljushet emellan.
 */
const RAMP = [
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
  thresholds: thresholdsProp,
  unit,
  markMax = true,
  summary,
  cellHeight = 24,
}: HeatmapProps) {
  const [ref, width, measured] = useMeasure<HTMLDivElement>();
  const [active, setActive] = useState<[number, number] | null>(null);
  const top = useMemo(() => d3max(values.flat()) ?? 1, [values]);
  const thresholds = useMemo(
    () =>
      (thresholdsProp?.length ? [...thresholdsProp] : niceThresholds(top)).slice(
        0,
        RAMP.length - 1,
      ),
    [thresholdsProp, top],
  );
  const mTop = M.top;
  const height = mTop + M.bottom + rowLabels.length * cellHeight;

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
    const step = scaleThreshold<number, number>()
      .domain(thresholds)
      .range(RAMP.map((_, i) => i).slice(0, thresholds.length + 1));
    let maxCell: [number, number] = [0, 0];
    values.forEach((row, r) =>
      row.forEach((v, c) => {
        if (v === top) maxCell = [r, c];
      }),
    );
    const labelEvery = Math.max(1, Math.ceil((colLabels.length * 26) / innerW));
    return { innerW, x, y, step, maxCell, labelEvery };
  }, [values, rowLabels, colLabels, width, cellHeight, thresholds, top]);

  // Rampen sprids över hela skalan även med färre steg.
  const fillFor = (v: number) => {
    const n = thresholds.length + 1;
    const i = g.step(v);
    const r = n === 1 ? RAMP.length - 1 : Math.round((i * (RAMP.length - 1)) / (n - 1));
    return RAMP[r] ?? RAMP[0];
  };
  const ints = useMemo(() => values.every((row) => row.every(Number.isInteger)), [values]);
  const rangeLabel = (i: number) => {
    const hi = thresholds[i];
    if (!ints) {
      if (i === 0) return `< ${formatInt(hi ?? 0)}`;
      const lo = thresholds[i - 1] ?? 0;
      return hi === undefined ? `${formatInt(lo)}+` : `${formatInt(lo)}–${formatInt(hi)}`;
    }
    const lo = i === 0 ? 1 : (thresholds[i - 1] ?? 0);
    if (hi === undefined) return `${formatInt(lo)}+`;
    return hi - 1 <= lo ? formatInt(lo) : `${formatInt(lo)}–${formatInt(hi - 1)}`;
  };

  const onKey = (e: KeyboardEvent<SVGSVGElement>) => {
    const [r, c] = active ?? g.maxCell;
    let next: [number, number] = [r, c];
    if (e.key === "ArrowRight") next = [r, Math.min(colLabels.length - 1, c + 1)];
    else if (e.key === "ArrowLeft") next = [r, Math.max(0, c - 1)];
    else if (e.key === "ArrowDown") next = [Math.min(rowLabels.length - 1, r + 1), c];
    else if (e.key === "ArrowUp") next = [Math.max(0, r - 1), c];
    else if (e.key === "Escape") return setActive(null);
    else return;
    e.preventDefault();
    setActive(next);
  };

  const av = active ? values[active[0]]?.[active[1]] : undefined;
  const label = (r: number, c: number) =>
    cellLabel ? cellLabel(r, c) : `${rowLabels[r]} ${colLabels[c]}`;

  const [mr, mc] = g.maxCell;

  return (
    <ChartFigure summary={summary}>
      <div ref={ref} className="relative w-full" style={{ height, ...unmeasuredStyle(measured) }}>
        <svg
          {...svgSizeProps(width, height, measured)}
          className="absolute top-0 left-0 block overflow-visible focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-solid"
          role="img"
          tabIndex={0}
          aria-label={`${summary} Använd piltangenterna för att läsa av celler.`}
          onKeyDown={onKey}
          onBlur={() => setActive(null)}
          onPointerLeave={() => setActive(null)}
        >
          <g transform={`translate(${M.left},${mTop})`}>
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
                  upper={false}
                >
                  {cl}
                </AxisText>
              ) : null,
            )}
            {values.map((row, r) =>
              row.map((v, c) => {
                const isActive = active?.[0] === r && active?.[1] === c;
                const empty = v <= 0;
                return (
                  <rect
                    key={`${r}-${c}`}
                    x={(g.x(c) ?? 0) + 0.5}
                    y={(g.y(r) ?? 0) + 0.5}
                    width={g.x.bandwidth() - 1}
                    height={g.y.bandwidth() - 1}
                    style={{
                      fill: empty ? "transparent" : fillFor(v),
                      stroke: isActive
                        ? "var(--bl-fg)"
                        : empty
                          ? "var(--bl-line-strong)"
                          : "transparent",
                    }}
                    strokeWidth={1}
                    onPointerEnter={() => setActive([r, c])}
                    onPointerDown={() => setActive([r, c])}
                  />
                );
              }),
            )}
            {markMax ? (
              <g pointerEvents="none">
                <rect
                  x={(g.x(mc) ?? 0) - 2.5}
                  y={(g.y(mr) ?? 0) - 2.5}
                  width={g.x.bandwidth() + 5}
                  height={g.y.bandwidth() + 5}
                  fill="none"
                  style={{ stroke: "var(--bl-fg)" }}
                  strokeWidth={1}
                />
              </g>
            ) : null}
          </g>
        </svg>
        {active && av !== undefined ? (
          <Readout
            x={M.left + (g.x(active[1]) ?? 0) + g.x.bandwidth()}
            y={mTop + (g.y(active[0]) ?? 0) + g.y.bandwidth() + 4}
            containerWidth={width}
            label={label(active[0], active[1])}
            rows={[
              { value: format(av), strong: true },
              { name: "Mot toppen", value: `${Math.round((av / top) * 100)} %` },
            ]}
          />
        ) : null}
      </div>
      {/* Skala: ett steg per ruta, gränsvärden i mono, enheten en gång */}
      <div className="mt-4 flex flex-wrap items-end gap-x-1 gap-y-2" aria-hidden>
        <span className="mr-2 flex flex-col items-start">
          <span className="h-3 w-10 border border-line-strong" />
          <span className="tnum meta mt-1 text-subtle">0</span>
        </span>
        {Array.from({ length: thresholds.length + 1 }, (_, i) => (
          <span key={i} className="flex flex-col items-start">
            <span
              className="h-3 w-12"
              style={{ background: fillFor(i === 0 ? 1 : (thresholds[i - 1] ?? 1)) }}
            />
            <span className="tnum meta mt-1 text-subtle">{rangeLabel(i)}</span>
          </span>
        ))}
        {unit ? <span className="meta ml-2 text-subtle">{unit}</span> : null}
        {markMax ? (
          // Toppen annoteras med samma form som i rutnätet: 1 px fg-ram
          <span className="ml-auto flex items-center gap-2">
            <span className="size-3 border border-fg p-px">
              <span className="block size-full" style={{ background: fillFor(top) }} />
            </span>
            <span className="tnum meta text-muted">
              <span className="label text-subtle">Topp </span>
              {label(mr, mc)} · {format(top)}
            </span>
          </span>
        ) : null}
      </div>
    </ChartFigure>
  );
}

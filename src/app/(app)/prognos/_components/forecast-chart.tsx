"use client";

import { scaleLinear } from "d3-scale";
import { area, curveLinear, line } from "d3-shape";
import { useMemo, useState, type KeyboardEvent, type PointerEvent } from "react";

import { axisScale } from "@/components/charts/axis";
import {
  measureLines,
  place,
  type Box,
  type LabelLine,
  type Obstacles,
} from "@/components/charts/layout";
import {
  AxisText,
  AxisUnitLabel,
  ChartFigure,
  LabelBlock,
  Node,
  Readout,
  nearestIndex,
} from "@/components/charts/primitives";
import { useMeasure } from "@/lib/hooks/use-measure";

import { dayText, periodShort } from "../_lib/dates";
import type { HistoryPoint, WeekValue } from "../_lib/model";
import { kr, packsMilli } from "../_lib/units";

export type ForecastMetric = "revenue" | "units";

const M = { top: 56, right: 16, bottom: 28, left: 40 };

type Pt = [number, number];

interface Point {
  readonly start: string;
  readonly end: string;
  readonly kind: "history" | "forecast";
  /** Utfall (historik), i enhetens bas (öre eller tusendelar). */
  readonly actual: number | null;
  /** Backtestens prognos för en historikvecka (bara pack). */
  readonly backtest: number | null;
  readonly mid: number | null;
  readonly low: number | null;
  readonly high: number | null;
}

function pointsOf(
  history: readonly HistoryPoint[],
  weeks: readonly WeekValue[],
  metric: ForecastMetric,
): Point[] {
  const out: Point[] = history.map((h) => ({
    start: h.start,
    end: h.end,
    kind: "history",
    actual: metric === "revenue" ? h.revenueOre : h.units * 1_000,
    backtest: metric === "units" ? h.backtestMilli : null,
    mid: null,
    low: null,
    high: null,
  }));
  for (const w of weeks) {
    out.push({
      start: w.start,
      end: w.end,
      kind: "forecast",
      actual: null,
      backtest: null,
      mid: metric === "revenue" ? w.revenueOre : w.unitsMilli,
      low: metric === "revenue" ? w.revenueLowOre : w.unitsLowMilli,
      high: metric === "revenue" ? w.revenueHighOre : w.unitsHighMilli,
    });
  }
  return out;
}

/**
 * Utfall per vecka (heldragen linje) följt av prognosen för de kommande veckorna:
 * osäkerhetsintervallet som band med kantlinjer och mittlinjen i bandet. I läget pack
 * ritas även backtestens prognos för de gångna veckorna (streckad, ihåliga cirklar), så
 * att träffsäkerheten syns i samma bild. En lodlinje markerar i dag.
 *
 * Tangentbord: ← → flyttar läsrutan mellan veckorna, Home/End till ändarna.
 */
export function ForecastChart({
  history,
  weeks,
  metric,
  coverage,
  summary,
  height = 300,
}: {
  history: readonly HistoryPoint[];
  weeks: readonly WeekValue[];
  metric: ForecastMetric;
  coverage: string;
  summary: string;
  height?: number;
}) {
  const [ref, width] = useMeasure<HTMLDivElement>();
  const [active, setActive] = useState<number | null>(null);
  const data = useMemo(() => pointsOf(history, weeks, metric), [history, weeks, metric]);
  const firstForecast = data.findIndex((d) => d.kind === "forecast");
  const lastIndex = data.length - 1;
  const fmt = (v: number) => (metric === "revenue" ? kr(v) : `${packsMilli(v)} pack`);

  const geo = useMemo(() => {
    const innerW = Math.max(10, width - M.left - M.right);
    const innerH = height - M.top - M.bottom;
    const n = data.length;
    const step = n > 1 ? innerW / (n - 1) : 0;
    const xs = data.map((_, i) => (n > 1 ? i * step : innerW / 2));
    let top = 0;
    for (const d of data) {
      top = Math.max(top, d.actual ?? 0, d.backtest ?? 0, d.high ?? 0, d.mid ?? 0);
    }
    const y = scaleLinear()
      .domain([0, top > 0 ? top : 1])
      .range([innerH, 0])
      .nice(4);
    const yTicks = y.ticks(4);
    // Axeln i kronor (kr/tkr) eller pack; värdena i öre respektive tusendelar.
    const base = metric === "revenue" ? 100 : 1_000;
    const axis = axisScale(
      yTicks.map((t) => t / base),
      metric === "revenue" ? "kr" : { label: "pack" },
    );
    const lineGen = line<Pt>().curve(curveLinear);
    const actualPts: Pt[] = [];
    const btPts: Pt[] = [];
    const midPts: Pt[] = [];
    const bandPts: Array<{ x: number; lo: number; hi: number }> = [];
    data.forEach((d, i) => {
      const x = xs[i] ?? 0;
      if (d.actual !== null) actualPts.push([x, y(d.actual)]);
      if (d.backtest !== null) btPts.push([x, y(d.backtest)]);
      if (d.mid !== null) midPts.push([x, y(d.mid)]);
      if (d.low !== null && d.high !== null) bandPts.push({ x, lo: y(d.low), hi: y(d.high) });
    });
    const bandGen = area<{ x: number; lo: number; hi: number }>()
      .curve(curveLinear)
      .x((p) => p.x)
      .y0((p) => p.lo)
      .y1((p) => p.hi);
    const lastActual = actualPts[actualPts.length - 1];
    const firstMid = midPts[0];
    // Etikettfrekvens: varannan vecka när det är trångt.
    const every = innerW / Math.max(1, n) < 56 ? 2 : 1;
    return {
      innerW,
      innerH,
      xs,
      y,
      yTicks,
      axis,
      base,
      actualPts,
      btPts,
      midPts,
      bandPts,
      actualPath: lineGen(actualPts) ?? "",
      btPath: btPts.length > 1 ? (lineGen(btPts) ?? "") : null,
      midPath: lineGen(midPts) ?? "",
      lowPath: lineGen(bandPts.map((p) => [p.x, p.lo] as Pt)) ?? "",
      highPath: lineGen(bandPts.map((p) => [p.x, p.hi] as Pt)) ?? "",
      bandPath: bandPts.length > 1 ? (bandGen(bandPts) ?? "") : null,
      bridge: lastActual && firstMid ? ([lastActual, firstMid] as const) : null,
      every,
    };
  }, [data, width, height, metric]);

  // Annoteringar: prognosens summa vid bandet och "I DAG" vid lodlinjen.
  const labels = useMemo(() => {
    const out: Array<{ key: string; box: Box; lines: LabelLine[]; align: "start" | "end" }> = [];
    const obs: Obstacles = {
      boxes: [],
      lines: [geo.actualPts, geo.midPts, ...(geo.btPts.length ? [geo.btPts] : [])],
      bounds: { x: 0, y: -M.top + 4, w: geo.innerW, h: geo.innerH + M.top - 6 },
    };
    const total = weeks.reduce(
      (s, w) => ({
        mid: s.mid + (metric === "revenue" ? w.revenueOre : w.unitsMilli),
      }),
      { mid: 0 },
    );
    const last = weeks[weeks.length - 1];
    const hi = geo.bandPts[geo.bandPts.length - 1];
    if (last && hi) {
      const lines: LabelLine[] = [
        [{ text: `${weeks.length} veckor · ${fmt(total.mid)}`, kind: "title" }],
        [
          { text: `${coverage} `, kind: "caps" },
          {
            text: `${fmt(metric === "revenue" ? last.revenueLowOre : last.unitsLowMilli).replace(/\s(kr|pack)$/, "")}–${fmt(metric === "revenue" ? last.revenueHighOre : last.unitsHighMilli)} sista veckan`,
            kind: "value",
          },
        ],
      ];
      const s = measureLines(lines);
      const x = Math.max(0, geo.innerW - s.w);
      const box = place(
        [
          { x, y: hi.hi - 10 - s.h, ...s },
          { x, y: -M.top + 8, ...s },
          { x, y: hi.lo + 10, ...s },
        ],
        obs,
        true,
        { hard: [geo.midPts] },
      );
      if (box) {
        out.push({ key: "total", box, lines, align: "end" });
        obs.boxes.push(box);
      }
    }
    const la = geo.actualPts[geo.actualPts.length - 1];
    if (la) {
      const lines: LabelLine[] = [[{ text: "Utfall", kind: "value" }]];
      const s = measureLines(lines);
      const box = place(
        [
          { x: la[0] - s.w - 8, y: la[1] - 8 - s.h, ...s },
          { x: la[0] - s.w - 8, y: la[1] + 8, ...s },
          { x: la[0] - s.w / 2, y: la[1] - 14 - s.h, ...s },
        ],
        obs,
        false,
        { hard: [geo.actualPts] },
      );
      if (box) {
        out.push({ key: "actual", box, lines, align: "start" });
        obs.boxes.push(box);
      }
    }
    const bt = geo.btPts[geo.btPts.length - 1];
    if (bt) {
      const lines: LabelLine[] = [[{ text: "Prognos i efterhand", kind: "value" }]];
      const s = measureLines(lines);
      const box = place(
        [
          { x: bt[0] - s.w - 8, y: bt[1] + 8, ...s },
          { x: bt[0] - s.w - 8, y: bt[1] - 8 - s.h, ...s },
          { x: bt[0] - s.w / 2, y: bt[1] + 12, ...s },
        ],
        obs,
        false,
        { hard: [geo.actualPts] },
      );
      if (box) {
        out.push({ key: "bt", box, lines, align: "start" });
        obs.boxes.push(box);
      }
    }
    return out;
    // fmt beror bara på metric.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [geo, weeks, metric, coverage]);

  const onMove = (e: PointerEvent<SVGRectElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    setActive(nearestIndex(geo.xs, e.clientX - rect.left));
  };
  const onKey = (e: KeyboardEvent<SVGSVGElement>) => {
    const cur = active ?? Math.max(0, firstForecast);
    let next = cur;
    if (e.key === "ArrowRight") next = Math.min(lastIndex, cur + 1);
    else if (e.key === "ArrowLeft") next = Math.max(0, cur - 1);
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = lastIndex;
    else if (e.key === "Escape") return setActive(null);
    else return;
    e.preventDefault();
    setActive(next);
  };

  const a = active !== null ? data[active] : undefined;
  const ax = active !== null ? (geo.xs[active] ?? 0) : 0;
  const todayX =
    firstForecast > 0
      ? ((geo.xs[firstForecast - 1] ?? 0) + (geo.xs[firstForecast] ?? 0)) / 2
      : null;
  const lastActual = geo.actualPts[geo.actualPts.length - 1];

  return (
    <ChartFigure summary={summary}>
      <div ref={ref} className="relative w-full" style={{ height }}>
        <svg
          width={width}
          height={height}
          className="absolute top-0 left-0 block overflow-visible focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-solid"
          tabIndex={0}
          role="img"
          aria-label={`${summary} Använd piltangenterna för att läsa av veckorna.`}
          onKeyDown={onKey}
          onFocus={() => setActive((v) => v ?? Math.max(0, firstForecast))}
          onBlur={() => setActive(null)}
        >
          <g transform={`translate(${M.left},${M.top})`}>
            <AxisUnitLabel x={-8} y={geo.y(geo.yTicks[geo.yTicks.length - 1] ?? 0) - 14}>
              {geo.axis.label}
            </AxisUnitLabel>
            {geo.yTicks.map((t) => (
              <g key={t}>
                <line
                  x1={0}
                  x2={geo.innerW}
                  y1={geo.y(t)}
                  y2={geo.y(t)}
                  style={{ stroke: t === 0 ? "var(--bl-line-strong)" : "var(--bl-line)" }}
                  strokeDasharray={t === 0 ? undefined : "1 3"}
                />
                <AxisText x={-8} y={geo.y(t)} anchor="end" baseline="middle" upper={false}>
                  {geo.axis.tick(t / geo.base)}
                </AxisText>
              </g>
            ))}
            {data.map((d, i) => {
              if (i % geo.every !== lastIndex % geo.every) return null;
              const x = geo.xs[i] ?? 0;
              const t = dayText(d.start);
              const atEdge = i === lastIndex;
              return (
                <g key={d.start}>
                  <line
                    x1={x}
                    x2={x}
                    y1={geo.innerH}
                    y2={geo.innerH + 4}
                    style={{ stroke: "var(--bl-line-strong)" }}
                  />
                  <AxisText
                    x={atEdge ? geo.innerW + M.right - 1 : i === 0 ? 0 : x}
                    y={geo.innerH + 18}
                    anchor={atEdge ? "end" : i === 0 ? "start" : "middle"}
                  >
                    {t}
                  </AxisText>
                </g>
              );
            })}

            {/* I dag: gränsen mellan utfall och prognos */}
            {todayX !== null ? (
              <g>
                <line
                  x1={todayX}
                  x2={todayX}
                  y1={-M.top + 20}
                  y2={geo.innerH}
                  style={{ stroke: "var(--bl-fg-subtle)" }}
                  strokeDasharray="4 3"
                />
                <AxisText x={todayX + 6} y={-M.top + 28} anchor="start">
                  I dag
                </AxisText>
              </g>
            ) : null}

            {/* Intervallet: band med kantlinjer */}
            {geo.bandPath ? (
              <path d={geo.bandPath} style={{ fill: "var(--bl-fg)", opacity: 0.08 }} />
            ) : null}
            <path
              d={geo.lowPath}
              fill="none"
              style={{ stroke: "var(--bl-data-3)" }}
              strokeWidth={1}
            />
            <path
              d={geo.highPath}
              fill="none"
              style={{ stroke: "var(--bl-data-3)" }}
              strokeWidth={1}
            />

            {geo.btPath ? (
              <path
                d={geo.btPath}
                fill="none"
                style={{ stroke: "var(--bl-data-3)" }}
                strokeWidth={1}
                strokeDasharray="3 3"
              />
            ) : null}
            <path
              d={geo.actualPath}
              fill="none"
              style={{ stroke: "var(--bl-data-1)" }}
              strokeWidth={1.5}
              strokeLinejoin="round"
            />
            {geo.bridge ? (
              <line
                x1={geo.bridge[0][0]}
                y1={geo.bridge[0][1]}
                x2={geo.bridge[1][0]}
                y2={geo.bridge[1][1]}
                style={{ stroke: "var(--bl-data-2)" }}
                strokeWidth={1}
                strokeDasharray="1 3"
              />
            ) : null}
            <path
              d={geo.midPath}
              fill="none"
              style={{ stroke: "var(--bl-data-2)" }}
              strokeWidth={1.5}
              strokeDasharray="6 3"
              strokeLinejoin="round"
            />

            {geo.btPts.map((p, i) => (
              <Node key={`bt${i}`} x={p[0]} y={p[1]} size={5} variant="circle" />
            ))}
            {lastActual ? (
              <Node x={lastActual[0]} y={lastActual[1]} size={6} variant="solid" />
            ) : null}
            {geo.midPts.map((p, i) => (
              <Node key={`m${i}`} x={p[0]} y={p[1]} size={5} variant="hollow" />
            ))}

            {labels.map((l) => (
              <LabelBlock key={l.key} box={l.box} lines={l.lines} align={l.align} />
            ))}

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
                {a.actual !== null ? (
                  <Node x={ax} y={geo.y(a.actual)} size={7} variant="solid" />
                ) : null}
                {a.mid !== null ? <Node x={ax} y={geo.y(a.mid)} size={7} variant="solid" /> : null}
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
            label={periodShort({ start: a.start, end: a.end })}
            rows={
              a.kind === "history"
                ? [
                    {
                      name: "Utfall",
                      value: a.actual !== null ? fmt(a.actual) : "–",
                      strong: true,
                      marker: <span className="inline-block h-px w-3 bg-fg" />,
                    },
                    ...(a.backtest !== null
                      ? [
                          {
                            name: "Prognos i efterhand",
                            value: fmt(a.backtest),
                            marker: (
                              <span className="inline-block w-3 border-t border-dashed border-data-3" />
                            ),
                          },
                        ]
                      : []),
                  ]
                : [
                    {
                      name: "Prognos",
                      value: a.mid !== null ? fmt(a.mid) : "–",
                      strong: true,
                      marker: (
                        <span className="inline-block w-3 border-t-2 border-dashed border-data-2" />
                      ),
                    },
                    {
                      name: coverage,
                      value:
                        a.low !== null && a.high !== null
                          ? metric === "revenue"
                            ? `${kr(a.low).replace(/\s?kr$/, "")}–${kr(a.high)}`
                            : `${packsMilli(a.low)}–${packsMilli(a.high)}`
                          : "–",
                    },
                  ]
            }
          />
        ) : null}
      </div>
    </ChartFigure>
  );
}

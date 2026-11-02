"use client";

import { extent, max as d3max } from "d3-array";
import { scaleLinear } from "d3-scale";
import { area, curveLinear, line } from "d3-shape";
import { useMemo, useState, type KeyboardEvent, type PointerEvent } from "react";
import { svgSizeProps, unmeasuredStyle, useMeasure } from "@/lib/hooks/use-measure";
import { formatDate, formatWeekdayDay } from "@/lib/format";
import { axisScale, type AxisUnit } from "./axis";
import {
  aroundPoint,
  leader,
  measureLines,
  place,
  type Box,
  type LabelLine,
  type Obstacles,
  type Pt,
} from "./layout";
import {
  AxisText,
  AxisUnitLabel,
  ChartFigure,
  LabelBlock,
  Node,
  Readout,
  nearestIndex,
} from "./primitives";

export type LinePoint = { date: Date; value: number };

export type Annotation = {
  index: number;
  /** Huvudtext, t.ex. "Släpp: Pokémon SV8" */
  text: string;
  /** Andra rad i monospace, t.ex. "+42 % mot veckan innan" */
  sub?: string;
};

type LineChartProps = {
  data: ReadonlyArray<LinePoint>;
  /** Jämförelseserie (föregående period), samma längd. Ritas streckad med ringnoder. */
  compare?: ReadonlyArray<number>;
  /** Exakt värde i läsruta och etiketter, t.ex. formatSek */
  format: (v: number) => string;
  /**
   * @deprecated Ignoreras. Axeln väljer en enhet för alla ticks via `unit`
   * (t.ex. "tkr" ovanför axeln och "0 2 4 6" som ticks).
   */
  formatAxis?: (v: number) => string;
  /** Axelns enhet. Standard "kr" (kr/tkr/mkr väljs efter största tick). */
  unit?: AxisUnit;
  /** Direktannoteringar. En annotering på toppunkten läggs under toppens datum och värde. */
  annotations?: ReadonlyArray<Annotation>;
  /**
   * Topp/rekord. Ritas i fg (fylld kvadrat) med annotering "24 okt. · 7 042 kr".
   * Standard: högsta värdet. Aldrig signalfärg.
   */
  peakIndex?: number;
  /** @deprecated Alias för peakIndex (betydde tidigare signalmarkering). */
  highlightIndex?: number;
  /** Punkt som kräver åtgärd. Enda platsen där signalfärg används. Kräver alertNote. */
  alertIndex?: number;
  /** Text vid larmpunkten, t.ex. "Fyllnad under 20 %" */
  alertNote?: string;
  /** Rita noder och etiketter för topp, botten och senaste värdet. Standard true. */
  markExtremes?: boolean;
  /** Horisontell hjälplinje, t.ex. snitt eller mål */
  reference?: { value: number; label: string };
  area?: boolean;
  height?: number;
  summary: string;
  seriesName?: string;
  /** Direktetikett vid jämförelseseriens sista punkt, t.ex. "Föreg. 30 d" */
  compareName?: string;
};

const M = { top: 48, right: 12, bottom: 28, left: 36 };

/** "24 okt." som i löptexten, samma form på axeln och i etiketterna. */
const day = (d: Date) => formatDate(d, { year: "never" });

/** Datumets väggklocka (lokala fält) som millisekunder, oberoende av tidszon och sommartid. */
function wallMs(d: Date): number {
  return Date.UTC(
    d.getFullYear(),
    d.getMonth(),
    d.getDate(),
    d.getHours(),
    d.getMinutes(),
    d.getSeconds(),
  );
}

function argmax(data: ReadonlyArray<LinePoint>) {
  let b = 0;
  data.forEach((d, i) => {
    if (d.value > (data[b]?.value ?? -Infinity)) b = i;
  });
  return b;
}

function argmin(data: ReadonlyArray<LinePoint>) {
  let b = 0;
  data.forEach((d, i) => {
    if (d.value < (data[b]?.value ?? Infinity)) b = i;
  });
  return b;
}

type Placed = {
  key: string;
  box: Box;
  lines: LabelLine[];
  align: "start" | "end";
  anchor?: Pt;
  tone?: "signal";
};

export function LineChart({
  data,
  compare,
  format,
  unit = "kr",
  annotations = [],
  peakIndex: peakProp,
  highlightIndex,
  alertIndex,
  alertNote,
  markExtremes = true,
  reference,
  area: showArea = true,
  height = 280,
  summary,
  seriesName = "Period",
  compareName = "Föregående",
}: LineChartProps) {
  const [ref, width, measured] = useMeasure<HTMLDivElement>();
  const [active, setActive] = useState<number | null>(null);

  const peakIndex = peakProp ?? highlightIndex ?? (data.length ? argmax(data) : undefined);
  const minIndex = data.length ? argmin(data) : undefined;
  const lastIndex = data.length - 1;

  const geo = useMemo(() => {
    const innerW = Math.max(10, width - M.left - M.right);
    const innerH = height - M.top - M.bottom;
    // Väggklockans tid (som om den vore UTC): samma läge på servern (UTC) och i webbläsaren
    // (svensk tid), och lika långa dagar även vid sommartidens slut. Annars blir x olika i
    // serverrenderingen och hydreringen.
    const [d0 = new Date(), d1 = new Date()] = extent(data, (d) => d.date);
    const x = scaleLinear()
      .domain([wallMs(d0), wallMs(d1)])
      .range([0, innerW]);
    const top = Math.max(
      d3max(data, (d) => d.value) ?? 1,
      d3max(compare ?? []) ?? 0,
      reference?.value ?? 0,
    );
    const y = scaleLinear().domain([0, top]).range([innerH, 0]).nice(4);
    const xs = data.map((d) => x(wallMs(d.date)));
    const pts = data.map((d, i) => [xs[i] ?? 0, y(d.value)] as [number, number]);
    const cmp = compare?.map((v, i) => [xs[i] ?? 0, y(v)] as [number, number]);
    // Raka segment: inga påhittade mellanvärden eller överslängar.
    const lineGen = line().curve(curveLinear);
    const areaGen = area<[number, number]>()
      .curve(curveLinear)
      .x((p) => p[0])
      .y0(innerH)
      .y1((p) => p[1]);
    const tickCount = Math.max(2, Math.min(data.length, Math.floor(innerW / 80)));
    const step = Math.max(1, Math.ceil(data.length / tickCount));
    const yTicks = y.ticks(4);
    return {
      innerW,
      innerH,
      x,
      y,
      xs,
      pts,
      cmp,
      linePath: lineGen(pts) ?? "",
      areaPath: areaGen(pts) ?? "",
      cmpPath: cmp ? (lineGen(cmp) ?? "") : null,
      yTicks,
      axis: axisScale(yTicks, unit),
      xTickIdx: data.map((_, i) => i).filter((i) => i % step === 0),
    };
  }, [data, compare, reference, width, height, unit]);

  // Direktetiketter: placeras i prioritetsordning och krocktestas mot linjerna.
  const labels = useMemo(() => {
    const out: Placed[] = [];
    const obs: Obstacles = {
      boxes: [],
      lines: geo.cmp ? [geo.pts, geo.cmp] : [geo.pts],
      bounds: { x: 0, y: -M.top + 4, w: geo.innerW, h: geo.innerH + M.top - 6 },
    };
    const add = (p: Placed | null) => {
      if (!p) return;
      out.push(p);
      obs.boxes.push(p.box);
    };
    const annAt = new Map(annotations.map((a) => [a.index, a]));
    const linesFor = (head: LabelLine | null, idx: number): LabelLine[] => {
      const a = annAt.get(idx);
      const ls: LabelLine[] = [];
      if (head) ls.push(head);
      if (a) {
        ls.push([{ text: a.text, kind: head ? "body" : "title" }]);
        if (a.sub) ls.push([{ text: a.sub, kind: "value" }]);
      }
      return ls;
    };
    const atPoint = (
      key: string,
      idx: number,
      lines: LabelLine[],
      prefer: "above" | "below",
      required: boolean,
      tone?: "signal",
    ) => {
      const p = geo.pts[idx];
      if (!p || lines.length === 0) return;
      const size = measureLines(lines);
      // Nära punkten först. Är allt där upptaget av linjer eller andra
      // etiketter läggs etiketten i bandet ovanför ritytan, med ledlinje.
      const clampX = (x: number) => Math.min(Math.max(0, x), geo.innerW - size.w);
      const band = [-M.top + 4, -M.top + 6 + size.h].flatMap((y) =>
        [p[0] + 8, p[0] - 8 - size.w, p[0] - size.w / 2].map((x) => ({
          x: clampX(x),
          y,
          ...size,
        })),
      );
      const box = place([...aroundPoint(p, size, prefer), ...band], obs, required);
      if (!box) return;
      add({ key, box, lines, align: box.x + box.w / 2 < p[0] ? "end" : "start", anchor: p, tone });
    };

    // 1. Larm (signal) och topp (fg) är obligatoriska.
    if (alertIndex !== undefined && data[alertIndex]) {
      const d = data[alertIndex];
      atPoint(
        "alert",
        alertIndex,
        [
          [{ text: `! ${alertNote ?? "Kräver åtgärd"}`, kind: "title" }],
          [{ text: `${day(d.date)} · ${format(d.value)}`, kind: "value" }],
        ],
        "below",
        true,
        "signal",
      );
    }
    if (markExtremes && peakIndex !== undefined && data[peakIndex] && peakIndex !== alertIndex) {
      const d = data[peakIndex];
      atPoint(
        "peak",
        peakIndex,
        linesFor([{ text: `${day(d.date)} · ${format(d.value)}`, kind: "title" }], peakIndex),
        "above",
        true,
      );
    }
    // 2. Övriga annoteringar.
    for (const a of annotations) {
      if ((markExtremes && a.index === peakIndex) || a.index === alertIndex) continue;
      atPoint(`a${a.index}`, a.index, linesFor(null, a.index), "above", true);
    }
    // 3. Referenslinjens etikett: vänster ände ovanför linjen, annars under.
    if (reference) {
      const ry = geo.y(reference.value);
      const lines: LabelLine[] = [
        [
          { text: `${reference.label} `, kind: "caps" },
          { text: format(reference.value), kind: "value" },
        ],
      ];
      const s = measureLines(lines);
      // Vänster ände först, sedan steg åt höger, sedan längre från linjen.
      // Etiketten får aldrig korsa huvudserien (då döljer gloria data).
      const xs = Array.from({ length: 25 }, (_, i) =>
        Math.min(4 + (i * geo.innerW) / 24, geo.innerW - s.w - 4),
      );
      const box = place(
        [3, 12, 24, 40].flatMap((d) =>
          xs.flatMap((x) => [
            { x, y: ry - d - s.h, ...s },
            { x, y: ry + d, ...s },
          ]),
        ),
        obs,
        true,
        { hard: [geo.pts] },
      );
      if (box) add({ key: "ref", box, lines, align: "start" });
    }
    // 4. Jämförelseseriens namn vid sista punkten.
    const cLast = geo.cmp?.[geo.cmp.length - 1];
    if (cLast && compareName) {
      const lines: LabelLine[] = [[{ text: compareName, kind: "value" }]];
      const s = measureLines(lines);
      // Nära sista punkten först, sedan längs serien åt vänster. Korsar
      // etiketten huvudserien i alla lägen utelämnas den: läsrutan bär namnet.
      const nearLast = [8, 16, 28, 40].flatMap((d) => [
        { x: geo.innerW - s.w, y: cLast[1] + d, ...s },
        { x: geo.innerW - s.w, y: cLast[1] - d - s.h, ...s },
      ]);
      // Längs serien från vänster: där är det oftast glest, och högra änden
      // har redan senaste värdet och dagens annotering.
      const along = (geo.cmp ?? [])
        .flatMap(([px, py]) =>
          [6, 14].flatMap((d) => [
            { x: px - s.w / 2, y: py + d, ...s },
            { x: px - s.w / 2, y: py - d - s.h, ...s },
          ]),
        )
        .filter((b) => b.x >= 0 && b.x + b.w <= geo.innerW);
      const box = place([...along, ...nearLast], obs, true, { hard: [geo.pts] });
      // Ledlinje bara till sista punkten; längs serien står etiketten direkt vid linjen.
      if (box)
        add({
          key: "cmp",
          box,
          lines,
          align: "end",
          anchor: nearLast.includes(box) ? cLast : undefined,
        });
    }
    // 5. Valfria: senaste och lägsta värdet. Utelämnas hellre än att krocka.
    if (
      markExtremes &&
      lastIndex >= 0 &&
      lastIndex !== peakIndex &&
      lastIndex !== alertIndex &&
      // En annotering på sista punkten bär redan värdet (t.ex. "I dag · 915 kr").
      !annAt.has(lastIndex)
    ) {
      const d = data[lastIndex];
      const p = geo.pts[lastIndex];
      if (d && p) {
        const lines: LabelLine[] = [[{ text: format(d.value), kind: "value" }]];
        const s = measureLines(lines);
        const box = place(
          [
            { x: geo.innerW - s.w, y: p[1] - 10 - s.h, ...s },
            { x: geo.innerW - s.w, y: p[1] + 10, ...s },
          ],
          obs,
        );
        if (box) add({ key: "last", box, lines, align: "end" });
      }
    }
    if (
      markExtremes &&
      minIndex !== undefined &&
      minIndex !== peakIndex &&
      minIndex !== lastIndex &&
      minIndex !== alertIndex
    ) {
      const d = data[minIndex];
      const p = geo.pts[minIndex];
      if (d && p) {
        const lines: LabelLine[] = [[{ text: format(d.value), kind: "value" }]];
        const s = measureLines(lines);
        const box = place(
          [
            { x: p[0] - s.w / 2, y: p[1] + 8, ...s },
            { x: p[0] + 8, y: p[1] + 6, ...s },
            { x: p[0] - 8 - s.w, y: p[1] + 6, ...s },
          ],
          obs,
        );
        if (box) add({ key: "min", box, lines, align: "start" });
      }
    }
    return out;
  }, [
    geo,
    data,
    annotations,
    alertIndex,
    alertNote,
    peakIndex,
    minIndex,
    lastIndex,
    markExtremes,
    reference,
    compareName,
    format,
  ]);

  const onMove = (e: PointerEvent<SVGRectElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    setActive(nearestIndex(geo.xs, e.clientX - rect.left));
  };

  const onKey = (e: KeyboardEvent<SVGSVGElement>) => {
    const cur = active ?? peakIndex ?? lastIndex;
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
  const nodeAt = (i: number | undefined) => (i !== undefined ? geo.pts[i] : undefined);
  const peakPt = markExtremes ? nodeAt(peakIndex) : undefined;
  const minPt = markExtremes && minIndex !== peakIndex ? nodeAt(minIndex) : undefined;
  const lastPt = markExtremes && lastIndex !== peakIndex ? nodeAt(lastIndex) : undefined;
  const alertPt = nodeAt(alertIndex);
  const cmpLast = geo.cmp?.[geo.cmp.length - 1];

  return (
    <ChartFigure summary={summary}>
      <div ref={ref} className="relative w-full" style={{ height, ...unmeasuredStyle(measured) }}>
        <svg
          {...svgSizeProps(width, height, measured)}
          className="absolute top-0 left-0 block overflow-visible focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-solid"
          tabIndex={0}
          role="img"
          aria-label={`${summary} Använd piltangenterna för att läsa av värden.`}
          onKeyDown={onKey}
          onFocus={() => setActive((v) => v ?? peakIndex ?? lastIndex)}
          onBlur={() => setActive(null)}
        >
          <g transform={`translate(${M.left},${M.top})`}>
            {/* Enhet en gång, ovanför y-axeln */}
            <AxisUnitLabel x={-8} y={geo.y(geo.yTicks[geo.yTicks.length - 1] ?? 0) - 14}>
              {geo.axis.label}
            </AxisUnitLabel>
            {/* Hjälplinjer. Ingen tick döljs; etiketter flyttas i stället. */}
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
                  {geo.axis.tick(t)}
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
                  {(() => {
                    // Sista datumet högerställs vid kanten i stället för att klippas
                    const t = day(d.date);
                    const tx = geo.xs[i] ?? 0;
                    const atEdge = tx + (t.length * 7.5) / 2 > geo.innerW + M.right;
                    return (
                      <AxisText
                        x={atEdge ? geo.innerW + M.right - 1 : tx}
                        y={geo.innerH + 18}
                        anchor={atEdge ? "end" : "middle"}
                        upper={false}
                      >
                        {t}
                      </AxisText>
                    );
                  })()}
                </g>
              );
            })}

            {reference ? (
              <line
                x1={0}
                x2={geo.innerW}
                y1={geo.y(reference.value)}
                y2={geo.y(reference.value)}
                style={{ stroke: "var(--bl-fg-subtle)" }}
                strokeDasharray="4 3"
              />
            ) : null}

            {showArea ? (
              <path d={geo.areaPath} style={{ fill: "var(--bl-fg)", opacity: 0.045 }} />
            ) : null}
            {geo.cmpPath ? (
              <path
                d={geo.cmpPath}
                fill="none"
                style={{ stroke: "var(--bl-data-3)" }}
                strokeWidth={1}
                strokeDasharray="3 3"
              />
            ) : null}
            <path
              d={geo.linePath}
              fill="none"
              style={{ stroke: "var(--bl-data-1)" }}
              strokeWidth={1.5}
              strokeLinejoin="round"
            />

            {/* Noder bara där de betyder något: jämförelsens slut, botten, senaste, topp, larm */}
            {cmpLast ? <Node x={cmpLast[0]} y={cmpLast[1]} size={5} variant="circle" /> : null}
            {minPt ? <Node x={minPt[0]} y={minPt[1]} size={5} variant="hollow" /> : null}
            {lastPt ? <Node x={lastPt[0]} y={lastPt[1]} size={5} variant="hollow" /> : null}
            {annotations.map((an) => {
              const p = geo.pts[an.index];
              if (!p || an.index === peakIndex || an.index === alertIndex) return null;
              return <Node key={an.index} x={p[0]} y={p[1]} size={5} variant="hollow" />;
            })}
            {peakPt ? <Node x={peakPt[0]} y={peakPt[1]} size={7} variant="solid" /> : null}
            {alertPt ? <Node x={alertPt[0]} y={alertPt[1]} size={6} variant="alert" /> : null}

            {labels.map((l) => {
              const ld = l.anchor ? leader(l.anchor, l.box, 6) : null;
              return (
                <g key={l.key}>
                  {ld ? (
                    <line
                      {...ld}
                      style={{
                        stroke: l.tone === "signal" ? "var(--bl-signal)" : "var(--bl-fg-subtle)",
                      }}
                      strokeWidth={1}
                    />
                  ) : null}
                  <LabelBlock box={l.box} lines={l.lines} align={l.align} tone={l.tone} />
                </g>
              );
            })}

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
                {compare?.[active ?? 0] !== undefined ? (
                  <Node x={ax} y={geo.y(compare[active ?? 0] ?? 0)} size={6} variant="circle" />
                ) : null}
                <Node
                  x={ax}
                  y={geo.y(a.value)}
                  size={7}
                  variant={active === alertIndex ? "signal" : "solid"}
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

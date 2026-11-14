import { max as d3max, mean, sum } from "d3-array";
import { scaleBand, scaleLinear } from "d3-scale";
import { line } from "d3-shape";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { formatPercent } from "@/lib/format";

/**
 * Diagram för rapporter och utskrift. Statiska SVG utan hover, ritade i
 * en fast viewBox som skalar med bredden (standard 174 mm = A4 minus
 * marginaler). Allt läses utan färg:
 *
 * - serier skiljs åt med linjestil och markör: aktuell = heldragen 1,5 px
 *   med ihålig kvadrat, jämförelse = streckad 1 px utan markör
 * - serier namnges direkt vid linjens slut, ingen separat legend
 * - markerad punkt = fylld kvadrat + ring, markerad stapel = fylld svart
 * - koordinatnät av; bara värdeaxelns hjälplinjer, prickade
 */

/** Innehållsbredd på ett A4-ark i px: 174 mm × 96 / 25,4. */
export const REPORT_CONTENT_WIDTH = 658;

const MONO = "var(--bl-font-mono)";

function Text({
  x,
  y,
  children,
  anchor = "start",
  baseline = "auto",
  size = 9,
  strong,
  sans,
  halo,
}: {
  x: number;
  y: number;
  children: ReactNode;
  anchor?: "start" | "middle" | "end";
  baseline?: "auto" | "middle" | "hanging";
  size?: number;
  strong?: boolean;
  sans?: boolean;
  /** Vit kontur bakom texten, så att den går att läsa ovanpå linjer. */
  halo?: boolean;
}) {
  return (
    <text
      x={x}
      y={y}
      textAnchor={anchor}
      dominantBaseline={baseline}
      className="tnum"
      paintOrder={halo ? "stroke" : undefined}
      strokeWidth={halo ? 3 : undefined}
      strokeLinejoin="round"
      style={{
        stroke: halo ? "var(--bl-bg)" : undefined,
        fontFamily: sans ? "var(--bl-font-sans)" : MONO,
        fontSize: size,
        fontWeight: sans && strong ? 500 : 400,
        letterSpacing: sans ? "-0.005em" : "0.04em",
        fill: strong ? "var(--bl-fg)" : "var(--bl-fg-subtle)",
      }}
    >
      {children}
    </text>
  );
}

function Figure({
  summary,
  width,
  height,
  children,
  className,
}: {
  summary: string;
  width: number;
  height: number;
  children: ReactNode;
  className?: string;
}) {
  return (
    <figure className={cn("m-0 w-full", className)}>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        width="100%"
        className="block h-auto overflow-visible"
        role="img"
        aria-label={summary}
      >
        {children}
      </svg>
    </figure>
  );
}

/** Topp: fylld kvadrat + ring i fg. Ett rekord är aldrig signal, inte ens när rapporten behåller färg. */
function PeakNode({ x, y, size = 6 }: { x: number; y: number; size?: number }) {
  const h = size / 2;
  return (
    <g>
      <rect
        x={x - h - 3}
        y={y - h - 3}
        width={size + 6}
        height={size + 6}
        fill="none"
        strokeWidth={1}
        style={{ stroke: "var(--bl-fg)" }}
      />
      <rect x={x - h} y={y - h} width={size} height={size} style={{ fill: "var(--bl-fg)" }} />
    </g>
  );
}

function ValueGrid({
  ticks,
  y,
  width,
  format,
}: {
  ticks: number[];
  y: (v: number) => number;
  width: number;
  format: (v: number) => string;
}) {
  return (
    <>
      {ticks.map((t) => (
        <g key={t}>
          <line
            x1={0}
            x2={width}
            y1={y(t)}
            y2={y(t)}
            strokeWidth={t === 0 ? 1 : 0.75}
            strokeDasharray={t === 0 ? undefined : "1 3"}
            style={{ stroke: t === 0 ? "var(--bl-line-strong)" : "var(--bl-line)" }}
          />
          <Text x={-6} y={y(t)} anchor="end" baseline="middle">
            {format(t)}
          </Text>
        </g>
      ))}
    </>
  );
}

// ---------------------------------------------------------------------------
// Linje
// ---------------------------------------------------------------------------

export type ReportSeries = {
  /** Kort namn vid linjens slut: "Okt.", "Sep." */
  name: string;
  /** Ett värde per x-position; null = saknas (t.ex. 31 sep.) */
  values: ReadonlyArray<number | null>;
  /** solid (standard för första serien) eller dashed */
  line?: "solid" | "dashed";
  /** square (standard för heldragen) eller none */
  marker?: "square" | "none";
};

type ReportLineChartProps = {
  /** Etikett per x-position, t.ex. "1 okt" */
  labels: ReadonlyArray<string>;
  /** Första serien är huvudserien; markering och annotering gäller den. */
  series: ReadonlyArray<ReportSeries>;
  formatAxis: (v: number) => string;
  /** x-positioner som får etikett. Standard: var femte. */
  ticks?: ReadonlyArray<number>;
  highlight?: { index: number; label: string; sub?: string };
  reference?: { value: number; label: string };
  width?: number;
  height?: number;
  summary: string;
};

export function ReportLineChart({
  labels,
  series,
  formatAxis,
  ticks,
  highlight,
  reference,
  width = REPORT_CONTENT_WIDTH,
  height = 230,
  summary,
}: ReportLineChartProps) {
  const M = { top: highlight ? 40 : 12, right: 40, bottom: 22, left: 44 };
  const innerW = width - M.left - M.right;
  const innerH = height - M.top - M.bottom;
  const n = labels.length;
  const x = scaleLinear()
    .domain([0, Math.max(1, n - 1)])
    .range([0, innerW]);
  const top = Math.max(
    d3max(series.flatMap((s) => s.values.filter((v): v is number => v !== null))) ?? 1,
    reference?.value ?? 0,
  );
  const y = scaleLinear().domain([0, top]).range([innerH, 0]).nice(4);
  const tickIdx = ticks ?? labels.map((_, i) => i).filter((i) => i % 5 === 0 || i === n - 1);

  const paths = series.map((s, si) => {
    const pts: Array<[number, number] | null> = s.values.map((v, i) =>
      v === null ? null : [x(i), y(v)],
    );
    const gen = line<[number, number] | null>()
      .defined((p) => p !== null)
      .x((p) => p?.[0] ?? 0)
      .y((p) => p?.[1] ?? 0);
    const dashed = (s.line ?? (si === 0 ? "solid" : "dashed")) === "dashed";
    const marker = s.marker ?? (dashed ? "none" : "square");
    let lastIdx = -1;
    pts.forEach((p, i) => {
      if (p) lastIdx = i;
    });
    return { s, pts, d: gen(pts) ?? "", dashed, marker, last: pts[lastIdx] ?? null };
  });

  // Direktetiketter vid linjernas slut, isärflyttade om de krockar.
  const ends = paths
    .map((p, i) => ({ i, y: p.last?.[1] ?? 0, name: p.s.name }))
    .sort((a, b) => a.y - b.y);
  for (let k = 1; k < ends.length; k++) {
    const prev = ends[k - 1];
    const cur = ends[k];
    if (prev && cur && cur.y - prev.y < 11) cur.y = prev.y + 11;
  }

  const hp = highlight ? paths[0]?.pts[highlight.index] : null;
  const hlRight = hp ? hp[0] > innerW * 0.62 : false;

  return (
    <Figure summary={summary} width={width} height={height}>
      <g transform={`translate(${M.left},${M.top})`}>
        <ValueGrid ticks={y.ticks(4)} y={y} width={innerW} format={formatAxis} />
        {tickIdx.map((i) => (
          <g key={i}>
            <line
              x1={x(i)}
              x2={x(i)}
              y1={innerH}
              y2={innerH + 3}
              strokeWidth={1}
              style={{ stroke: "var(--bl-line-strong)" }}
            />
            <Text x={x(i)} y={innerH + 14} anchor="middle">
              {labels[i]}
            </Text>
          </g>
        ))}

        {reference ? (
          <g>
            <line
              x1={0}
              x2={innerW}
              y1={y(reference.value)}
              y2={y(reference.value)}
              strokeWidth={1}
              strokeDasharray="6 2 1 2"
              style={{ stroke: "var(--bl-fg-muted)" }}
            />
            <Text x={4} y={y(reference.value) - 5} halo>
              {reference.label}
            </Text>
          </g>
        ) : null}

        {/* Jämförelseserier först, huvudserien överst */}
        {[...paths].reverse().map((p) => (
          <path
            key={p.s.name}
            d={p.d}
            fill="none"
            strokeWidth={p.dashed ? 1 : 1.5}
            strokeDasharray={p.dashed ? "4 3" : undefined}
            strokeLinejoin="round"
            style={{ stroke: p.dashed ? "var(--bl-data-3)" : "var(--bl-data-1)" }}
          />
        ))}
        {paths.map((p) =>
          p.marker === "square"
            ? p.pts.map((pt, i) =>
                pt && !(p === paths[0] && i === highlight?.index) ? (
                  <rect
                    key={`${p.s.name}-${i}`}
                    x={pt[0] - 2}
                    y={pt[1] - 2}
                    width={4}
                    height={4}
                    strokeWidth={1}
                    style={{ fill: "var(--bl-bg)", stroke: "var(--bl-data-1)" }}
                  />
                ) : null,
              )
            : null,
        )}

        {ends.map((e) => {
          const p = paths[e.i];
          if (!p?.last) return null;
          return (
            <Text key={e.name} x={p.last[0] + 8} y={e.y} baseline="middle" strong={e.i === 0} halo>
              {e.name}
            </Text>
          );
        })}

        {hp && highlight ? (
          <g>
            <line
              x1={hp[0]}
              x2={hp[0]}
              y1={-M.top + 26}
              y2={hp[1] - 8}
              strokeWidth={1}
              style={{ stroke: "var(--bl-fg-faint)" }}
            />
            <Text
              x={hp[0] + (hlRight ? -6 : 6)}
              y={-M.top + 10}
              anchor={hlRight ? "end" : "start"}
              size={11.5}
              strong
              sans
            >
              {highlight.label}
            </Text>
            {highlight.sub ? (
              <Text
                x={hp[0] + (hlRight ? -6 : 6)}
                y={-M.top + 24}
                anchor={hlRight ? "end" : "start"}
              >
                {highlight.sub}
              </Text>
            ) : null}
            <PeakNode x={hp[0]} y={hp[1]} />
          </g>
        ) : null}
      </g>
    </Figure>
  );
}

// ---------------------------------------------------------------------------
// Staplar
// ---------------------------------------------------------------------------

type ReportBarChartProps = {
  data: ReadonlyArray<{ label: string; value: number }>;
  format: (v: number) => string;
  formatAxis?: (v: number) => string;
  highlightIndex?: number;
  /** Visa snittlinje med etikett. Av som standard: värdena står redan på staplarna. */
  showMean?: boolean;
  width?: number;
  height?: number;
  /** Ungefärligt antal linjer på värdeaxeln (standard 4). Färre i ett lågt diagram. */
  tickCount?: number;
  summary: string;
};

/** Staplar med värdet skrivet ovanför. Markerad stapel är fylld svart, övriga ljusgrå med kant. */
export function ReportBarChart({
  data,
  format,
  formatAxis = format,
  highlightIndex,
  showMean = false,
  width = REPORT_CONTENT_WIDTH,
  height = 180,
  tickCount = 4,
  summary,
}: ReportBarChartProps) {
  const M = { top: 18, right: 4, bottom: 22, left: 44 };
  const innerW = width - M.left - M.right;
  const innerH = height - M.top - M.bottom;
  const x = scaleBand<number>()
    .domain(data.map((_, i) => i))
    .range([0, innerW])
    .paddingInner(0.42)
    .paddingOuter(0.2);
  const y = scaleLinear()
    .domain([0, d3max(data, (d) => d.value) ?? 1])
    .range([innerH, 0])
    .nice(4);
  const bw = x.bandwidth();
  const avg = mean(data, (d) => d.value) ?? 0;

  return (
    <Figure summary={summary} width={width} height={height}>
      <g transform={`translate(${M.left},${M.top})`}>
        <ValueGrid ticks={y.ticks(tickCount)} y={y} width={innerW} format={formatAxis} />
        {data.map((d, i) => {
          const bx = x(i) ?? 0;
          const by = y(d.value);
          const hl = i === highlightIndex;
          return (
            <g key={d.label}>
              <rect
                x={bx + 0.5}
                y={by + 0.5}
                width={Math.max(0, bw - 1)}
                height={Math.max(0, innerH - by - 0.5)}
                strokeWidth={1}
                style={{
                  fill: hl ? "var(--bl-fg)" : "var(--bl-data-5)",
                  stroke: hl ? "var(--bl-fg)" : "var(--bl-data-3)",
                }}
              />
              <Text x={bx + bw / 2} y={by - 5} anchor="middle" strong={hl} size={hl ? 9.5 : 9} halo>
                {format(d.value)}
              </Text>
              <Text x={bx + bw / 2} y={innerH + 14} anchor="middle" strong={hl}>
                {d.label}
              </Text>
            </g>
          );
        })}
        {showMean ? (
          <g>
            <line
              x1={0}
              x2={innerW}
              y1={y(avg)}
              y2={y(avg)}
              strokeWidth={1}
              strokeDasharray="6 2 1 2"
              style={{ stroke: "var(--bl-fg-muted)" }}
            />
            <Text x={innerW} y={y(avg) - 5} anchor="end" halo>
              {`Snitt ${formatAxis(avg)}`}
            </Text>
          </g>
        ) : null}
      </g>
    </Figure>
  );
}

// ---------------------------------------------------------------------------
// Andelsstapel
// ---------------------------------------------------------------------------

const SHARE_FILLS = [
  "var(--bl-data-1)",
  "var(--bl-data-2)",
  "var(--bl-data-3)",
  "var(--bl-data-4)",
  "var(--bl-data-5)",
] as const;

/**
 * 100 %-stapel med numrerade segment och en numrerad förklaring under.
 * Numren bär identiteten, så stapeln läses även om gråtonerna flyter ihop.
 * Segmenten bör vara sorterade störst först och högst fem.
 */
export function ReportShareBar({
  segments,
  format,
  summary,
}: {
  segments: ReadonlyArray<{ label: string; value: number; note?: string }>;
  format: (v: number) => string;
  summary: string;
}) {
  const total = sum(segments, (s) => s.value) || 1;
  const fill = (i: number) => SHARE_FILLS[Math.min(i, SHARE_FILLS.length - 1)] ?? "";
  const ink = (i: number) => (i <= 2 ? "var(--bl-bg)" : "var(--bl-fg)");
  return (
    <figure className="m-0 flex flex-col gap-[3mm]" aria-label={summary}>
      <div>
        <div className="flex h-[7mm] w-full gap-[2px]" aria-hidden>
          {segments.map((s, i) => {
            const share = s.value / total;
            return (
              <div
                key={s.label}
                className="relative h-full min-w-[3px]"
                style={{
                  width: `${share * 100}%`,
                  background: fill(i),
                  outline: i >= 3 ? "1px solid var(--bl-data-3)" : undefined,
                  outlineOffset: -1,
                }}
              >
                {share >= 0.03 ? (
                  <span
                    className="tnum absolute top-1/2 left-[1.5mm] -translate-y-1/2 font-mono text-[9px] leading-none"
                    style={{ color: ink(i) }}
                  >
                    {i + 1}
                  </span>
                ) : null}
              </div>
            );
          })}
        </div>
        <div className="relative mt-[1mm] h-[3mm]" aria-hidden>
          {[0, 25, 50, 75, 100].map((t) => (
            <span
              key={t}
              className="tnum absolute top-0 font-mono text-[8px] leading-none text-faint"
              style={{
                left: `${t}%`,
                transform:
                  t === 0 ? undefined : t === 100 ? "translateX(-100%)" : "translateX(-50%)",
              }}
            >
              {t}
            </span>
          ))}
        </div>
      </div>
      <ol
        className="grid gap-x-[4mm]"
        style={{ gridTemplateColumns: `repeat(${segments.length}, minmax(0, 1fr))` }}
      >
        {segments.map((s, i) => (
          <li
            key={s.label}
            className="flex min-w-0 flex-col gap-[0.8mm] border-t border-line pt-[1.8mm]"
          >
            <span className="flex items-center gap-[1.5mm] text-[10.5px] leading-[14px] text-fg">
              <span
                aria-hidden
                className="tnum grid size-[3.4mm] shrink-0 place-items-center font-mono text-[8px] leading-none"
                style={{
                  background: fill(i),
                  color: ink(i),
                  outline: i >= 3 ? "1px solid var(--bl-data-3)" : undefined,
                  outlineOffset: -1,
                }}
              >
                {i + 1}
              </span>
              <span className="truncate">{s.label}</span>
            </span>
            <span className="tnum text-[15px] leading-[18px] font-medium tracking-[-0.01em] text-fg">
              {formatPercent(s.value / total)}
            </span>
            <span className="tnum font-mono text-[9px] leading-[12px] text-subtle">
              {format(s.value)}
              {s.note ? ` · ${s.note}` : ""}
            </span>
          </li>
        ))}
      </ol>
    </figure>
  );
}

// ---------------------------------------------------------------------------
// Tidslinje
// ---------------------------------------------------------------------------

export type ReportTimelineEvent = { id: string; start: Date; end: Date };

/**
 * Månadens dygn som ett spår, med avvikelser som fyllda block och
 * numrerade rutor som matchar tabellen under. Helgdygn tonas svagt.
 */
export function ReportTimeline({
  start,
  days,
  events,
  dayLabel,
  width = REPORT_CONTENT_WIDTH,
  summary,
}: {
  /** Första dygnet, midnatt */
  start: Date;
  days: number;
  events: ReadonlyArray<ReportTimelineEvent>;
  /** Etikett för dygn d (0-baserat), visas var femte dag */
  dayLabel: (d: number) => string;
  width?: number;
  summary: string;
}) {
  const H = 64;
  const M = { left: 0, right: 0 };
  const innerW = width - M.left - M.right;
  const t0 = start.getTime();
  const span = days * 86_400_000;
  const x = (d: Date) => ((d.getTime() - t0) / span) * innerW;
  const cell = innerW / days;
  const trackY = 22;
  const trackH = 16;
  // Etikett på första och sista dygnet och var femte dag däremellan.
  const tickDays = Array.from({ length: days }, (_, d) => d).filter(
    (d) => d === 0 || d === days - 1 || ((d + 1) % 5 === 0 && d < days - 3),
  );

  // Numrerade rutor ovanför, isärflyttade om de krockar.
  const boxes = events.map((e, i) => ({ i, cx: (x(e.start) + x(e.end)) / 2 }));
  for (let k = 1; k < boxes.length; k++) {
    const prev = boxes[k - 1];
    const cur = boxes[k];
    if (prev && cur && cur.cx - prev.cx < 16) cur.cx = prev.cx + 16;
  }

  return (
    <Figure summary={summary} width={width} height={H}>
      <g transform={`translate(${M.left},0)`}>
        {Array.from({ length: days }, (_, d) => {
          const date = new Date(start.getFullYear(), start.getMonth(), start.getDate() + d);
          const weekend = date.getDay() === 0 || date.getDay() === 6;
          return (
            <rect
              key={d}
              x={d * cell}
              y={trackY}
              width={cell}
              height={trackH}
              style={{ fill: weekend ? "var(--bl-data-0)" : "var(--bl-bg)" }}
            />
          );
        })}
        {Array.from({ length: days - 1 }, (_, d) => (
          <line
            key={d}
            x1={(d + 1) * cell}
            x2={(d + 1) * cell}
            y1={trackY}
            y2={trackY + trackH}
            strokeWidth={0.5}
            style={{ stroke: "var(--bl-line)" }}
          />
        ))}
        {tickDays.map((d) => (
          <line
            key={d}
            x1={(d + 0.5) * cell}
            x2={(d + 0.5) * cell}
            y1={trackY + trackH}
            y2={trackY + trackH + 3}
            strokeWidth={1}
            style={{ stroke: "var(--bl-line-strong)" }}
          />
        ))}
        <rect
          x={0.5}
          y={trackY + 0.5}
          width={innerW - 1}
          height={trackH - 1}
          fill="none"
          strokeWidth={1}
          style={{ stroke: "var(--bl-line-strong)" }}
        />
        {events.map((e) => {
          const ex = x(e.start);
          const w = Math.max(2.5, x(e.end) - ex);
          return (
            <rect
              key={e.id}
              x={ex}
              y={trackY}
              width={w}
              height={trackH}
              style={{ fill: "var(--bl-signal)" }}
            />
          );
        })}
        {boxes.map((b) => {
          const e = events[b.i];
          if (!e) return null;
          const ex = (x(e.start) + x(e.end)) / 2;
          return (
            <g key={e.id}>
              <path
                d={`M${b.cx} 13V${trackY - 1}`}
                strokeWidth={1}
                fill="none"
                style={{ stroke: "var(--bl-fg-muted)" }}
              />
              {Math.abs(b.cx - ex) > 0.5 ? (
                <path
                  d={`M${b.cx} ${trackY - 1}L${ex} ${trackY}`}
                  strokeWidth={1}
                  style={{ stroke: "var(--bl-fg-muted)" }}
                />
              ) : null}
              <rect
                x={b.cx - 6}
                y={1}
                width={12}
                height={12}
                strokeWidth={1}
                style={{ fill: "var(--bl-bg)", stroke: "var(--bl-fg)" }}
              />
              <Text x={b.cx} y={7.5} anchor="middle" baseline="middle" strong size={8.5}>
                {e.id}
              </Text>
            </g>
          );
        })}
        {tickDays.map((d) => (
          <Text
            key={d}
            x={d === days - 1 ? innerW : d === 0 ? 0 : (d + 0.5) * cell}
            y={trackY + trackH + 14}
            anchor={d === 0 ? "start" : d === days - 1 ? "end" : "middle"}
          >
            {dayLabel(d)}
          </Text>
        ))}
      </g>
    </Figure>
  );
}

"use client";

import { max as d3max, mean } from "d3-array";
import { scaleBand, scaleLinear } from "d3-scale";
import { useId, useMemo, useState, type KeyboardEvent } from "react";
import { cn } from "@/lib/cn";
import { formatDelta } from "@/lib/format";
import { useMeasure } from "@/lib/hooks/use-measure";
import { axisScale, type AxisUnit } from "./axis";
import { AxisText, AxisUnitLabel, ChartFigure, HatchPattern, Readout } from "./primitives";

export type BarDatum = {
  /**
   * Etikett. I stående läge visas id (`code` eller id ur början av `name`,
   * t.ex. "BL-006") på x-axeln; `label` används bara om inget id finns och
   * bör då vara fullt id, aldrig en förkortning som "006".
   */
  label: string;
  value: number;
  /** Fullt namn, t.ex. "BL-006 Väla Centrum". I liggande läge visas id i mono och plats i klartext. */
  name?: string;
  /** Explicit id i mono ("BL-006"). Annars tas det ur början av name. */
  code?: string;
  /** Kräver åtgärd: signalfärg + skraffering + `note` som text. */
  flag?: boolean;
  /** Text under stapeln, t.ex. "Fyllnad 6 % · under gräns" */
  note?: string;
};

type BarChartProps = {
  data: ReadonlyArray<BarDatum>;
  format: (v: number) => string;
  /** @deprecated Ignoreras. Axeln använder en enhet för alla ticks via `unit`. */
  formatAxis?: (v: number) => string;
  /** Axelns enhet, standard "kr" (kr/tkr/mkr väljs efter största tick). */
  unit?: AxisUnit;
  /**
   * "horizontal" (standard): en rad per post med id, namn och högerställt värde.
   * Alla poster får etikett. "vertical": klassiska staplar för få, korta etiketter.
   */
  orientation?: "horizontal" | "vertical";
  /** Topp/rekord: fylls i fg och annoteras. Standard: högsta värdet. Aldrig signal. */
  peakIndex?: number;
  /** @deprecated Alias för peakIndex. */
  highlightIndex?: number;
  /** Annotering vid toppen (vertikalt läge). Liggande läge skriver "Högst · +44 % mot snitt". */
  highlightNote?: string;
  /** Post som kräver åtgärd (samma som flag på posten). */
  alertIndex?: number;
  /** Visa snittlinje */
  showMean?: boolean;
  /** Kolumnrubriker i liggande läge */
  labelHeading?: string;
  valueHeading?: string;
  /** Höjd i vertikalt läge. Liggande läge växer med antalet rader. */
  height?: number;
  summary: string;
};

const ID_RE = /^([A-ZÅÄÖ]{1,4}-\d+)\s+(.*)$/;

function split(d: BarDatum): { code?: string; text: string } {
  if (d.code) return { code: d.code, text: d.name ?? d.label };
  const m = d.name ? ID_RE.exec(d.name) : null;
  if (m) return { code: m[1], text: m[2] ?? "" };
  return { text: d.name ?? d.label };
}

export function BarChart(props: BarChartProps) {
  return props.orientation === "vertical" ? (
    <VerticalBars {...props} />
  ) : (
    <HorizontalBars {...props} />
  );
}

function usePeak(data: ReadonlyArray<BarDatum>, peakIndex?: number, highlightIndex?: number) {
  return useMemo(() => {
    if (peakIndex !== undefined) return peakIndex;
    if (highlightIndex !== undefined) return highlightIndex;
    let b = 0;
    data.forEach((d, i) => {
      if (d.value > (data[b]?.value ?? -Infinity)) b = i;
    });
    return data.length ? b : undefined;
  }, [data, peakIndex, highlightIndex]);
}

/* ---------------------------------------------------------------------- */
/* Liggande: listan är diagrammet                                          */
/* ---------------------------------------------------------------------- */

function HorizontalBars({
  data,
  format,
  unit = "kr",
  peakIndex: peakProp,
  highlightIndex,
  alertIndex,
  showMean = true,
  labelHeading = "Automat",
  valueHeading = "Intäkt",
  summary,
}: BarChartProps) {
  const [active, setActive] = useState<number | null>(null);
  const peak = usePeak(data, peakProp, highlightIndex);
  const hatchId = useId().replace(/:/g, "");

  const g = useMemo(() => {
    const x = scaleLinear()
      .domain([0, d3max(data, (d) => d.value) ?? 1])
      .range([0, 100])
      .nice(4);
    const ticks = x.ticks(4);
    return { x, ticks, axis: axisScale(ticks, unit), avg: mean(data, (d) => d.value) ?? 0 };
  }, [data, unit]);

  const pct = (v: number) => Math.max(0, Math.min(100, g.x(v)));
  const avgPct = pct(g.avg);

  return (
    <ChartFigure summary={summary}>
      <div
        className="grid grid-cols-[minmax(0,8.5rem)_minmax(0,1fr)_4.5rem] gap-x-3 sm:grid-cols-[minmax(0,13rem)_minmax(0,1fr)_5.5rem] sm:gap-x-4"
        onPointerLeave={() => setActive(null)}
      >
        {/* Kolumnhuvud: snittets annotering ovanför sin linje */}
        <span className="label self-end pb-2 text-subtle">{labelHeading}</span>
        <div className="relative h-8" aria-hidden>
          {showMean ? (
            <span
              className="tnum meta absolute bottom-2 whitespace-nowrap text-muted"
              style={
                avgPct > 60
                  ? { right: `${100 - avgPct}%`, paddingRight: 6 }
                  : { left: `${avgPct}%`, paddingLeft: 6 }
              }
            >
              <span className="label text-subtle">Snitt </span>
              {format(g.avg)}
            </span>
          ) : null}
        </div>
        <span className="label self-end pb-2 text-right text-subtle">{valueHeading}</span>

        <ol className="col-span-3 grid grid-cols-subgrid" aria-label={summary}>
          {data.map((d, i) => {
            const { code, text } = split(d);
            const isPeak = i === peak;
            const isAlert = d.flag || i === alertIndex;
            const note = isAlert
              ? d.note
              : isPeak && data.length > 1
                ? `Högst · ${formatDelta(d.value / g.avg - 1)} mot snitt`
                : d.note;
            return (
              <li
                key={`${code ?? ""}${d.label}${i}`}
                onPointerEnter={() => setActive(i)}
                className={cn(
                  "col-span-3 grid grid-cols-subgrid border-t border-line transition-colors duration-[120ms]",
                  active === i && "bg-hover",
                )}
              >
                <span className="flex h-8 min-w-0 items-center gap-2">
                  {code ? (
                    <span
                      className={cn(
                        "tnum shrink-0 font-mono text-xs",
                        isPeak || isAlert ? "text-fg" : "text-subtle",
                      )}
                    >
                      {code}
                    </span>
                  ) : null}
                  <span className={cn("truncate text-sm", isPeak ? "text-fg" : "text-muted")}>
                    {text}
                  </span>
                </span>
                <span className="relative flex h-8 items-center">
                  {/* Hjälplinjer och snitt per rad; de bryts vid noteringsraden */}
                  <span aria-hidden className="pointer-events-none absolute inset-0">
                    {g.ticks.slice(1).map((t) => (
                      <span
                        key={t}
                        className="absolute inset-y-0 border-l border-dotted border-line"
                        style={{ left: `${pct(t)}%` }}
                      />
                    ))}
                    {showMean ? (
                      <span
                        className="absolute inset-y-0 border-l border-dashed border-subtle"
                        style={{ left: `${avgPct}%` }}
                      />
                    ) : null}
                  </span>
                  <span className="relative block h-2 w-full">
                    <span
                      className={cn(
                        "absolute inset-y-0 left-0 transition-colors duration-[120ms]",
                        isAlert
                          ? "border border-signal"
                          : isPeak
                            ? "bg-data-1"
                            : active === i
                              ? "bg-data-2"
                              : "bg-data-3",
                      )}
                      style={{ width: `${pct(d.value)}%` }}
                    >
                      {isAlert ? (
                        // Skraffering bär larmet även i svartvitt
                        <svg aria-hidden className="absolute inset-0 size-full">
                          <defs>
                            <HatchPattern id={`${hatchId}-${i}`} tone="signal" />
                          </defs>
                          <rect width="100%" height="100%" fill={`url(#${hatchId}-${i})`} />
                        </svg>
                      ) : null}
                    </span>
                  </span>
                </span>
                <span
                  className={cn(
                    "tnum flex h-8 items-center justify-end font-mono text-sm",
                    isPeak || isAlert ? "font-medium text-fg" : "text-muted",
                  )}
                >
                  {format(d.value)}
                </span>
                {note ? (
                  <span
                    className={cn(
                      "label col-span-2 col-start-2 -mt-1 pb-2",
                      isAlert ? "text-signal-fg" : "text-subtle",
                    )}
                  >
                    {isAlert ? "! " : ""}
                    {note}
                  </span>
                ) : null}
              </li>
            );
          })}
        </ol>

        {/* x-axel: ticks utan enhet, enheten en gång i änden */}
        <span />
        <div className="relative h-6 border-t border-line-strong" aria-hidden>
          {g.ticks.map((t, i) => (
            <span
              key={t}
              className={cn(
                "tnum meta absolute top-1.5 text-subtle",
                i === 0 ? "" : "-translate-x-1/2",
              )}
              style={{ left: `${pct(t)}%` }}
            >
              {g.axis.tick(t)}
            </span>
          ))}
        </div>
        <span className="meta pt-1.5 text-right text-subtle" aria-hidden>
          {g.axis.label}
        </span>
      </div>
    </ChartFigure>
  );
}

/* ---------------------------------------------------------------------- */
/* Stående                                                                 */
/* ---------------------------------------------------------------------- */

const MV = { top: 40, right: 8, bottom: 28, left: 36 };
// Geist Mono 10 px versaler med 0,06 em spärrning
const CH_MONO = 6.8;

function VerticalBars({
  data,
  format,
  unit = "kr",
  peakIndex: peakProp,
  highlightIndex,
  highlightNote,
  alertIndex,
  showMean = true,
  height = 240,
  summary,
}: BarChartProps) {
  const [ref, width] = useMeasure<HTMLDivElement>();
  const [active, setActive] = useState<number | null>(null);
  const peak = usePeak(data, peakProp, highlightIndex);
  const hatchId = useId().replace(/:/g, "");

  const g = useMemo(() => {
    const innerW = Math.max(10, width - MV.left - MV.right);
    // Larmnoteringen står på en egen rad under x-etiketten
    const hasNote = data.some((d, i) => d.flag || i === alertIndex);
    const bottom = MV.bottom + (hasNote ? 14 : 0);
    const innerH = height - MV.top - bottom;
    const x = scaleBand<number>()
      .domain(data.map((_, i) => i))
      .range([0, innerW])
      .paddingInner(innerW / data.length < 24 ? 0.2 : 0.38)
      .paddingOuter(0.1);
    const y = scaleLinear()
      .domain([0, d3max(data, (d) => d.value) ?? 1])
      .range([innerH, 0])
      .nice(4);
    const ticks = y.ticks(4);
    const xLabels = data.map((d) => split(d).code ?? d.label);
    const widest = Math.max(0, ...xLabels.map((t) => t.length * CH_MONO)) + 8;
    const labelEvery = Math.max(1, Math.ceil((data.length * widest) / innerW));
    return {
      innerW,
      innerH,
      x,
      y,
      ticks,
      axis: axisScale(ticks, unit),
      avg: mean(data, (d) => d.value) ?? 0,
      labelEvery,
      xLabels,
    };
  }, [data, width, height, unit, alertIndex]);

  const onKey = (e: KeyboardEvent<SVGSVGElement>) => {
    const cur = active ?? peak ?? 0;
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
  const hl = peak !== undefined ? data[peak] : undefined;
  const hlx = peak !== undefined ? (g.x(peak) ?? 0) + bw / 2 : 0;
  const right = hlx > g.innerW * 0.6;

  return (
    <ChartFigure summary={summary}>
      <div ref={ref} className="relative w-full" style={{ height }}>
        <svg
          width={width}
          height={height}
          className="absolute top-0 left-0 block overflow-visible focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-solid"
          tabIndex={0}
          role="img"
          aria-label={`${summary} Använd piltangenterna för att läsa av staplar.`}
          onKeyDown={onKey}
          onFocus={() => setActive((v) => v ?? peak ?? 0)}
          onBlur={() => setActive(null)}
          onPointerLeave={() => setActive(null)}
        >
          <defs>
            <HatchPattern id={hatchId} tone="signal" />
          </defs>
          <g transform={`translate(${MV.left},${MV.top})`}>
            <AxisUnitLabel x={-8} y={g.y(g.ticks[g.ticks.length - 1] ?? 0) - 14}>
              {g.axis.label}
            </AxisUnitLabel>
            {g.ticks.map((t) => (
              <g key={t}>
                <line
                  x1={0}
                  x2={g.innerW}
                  y1={g.y(t)}
                  y2={g.y(t)}
                  style={{ stroke: t === 0 ? "var(--bl-line-strong)" : "var(--bl-line)" }}
                  strokeDasharray={t === 0 ? undefined : "1 3"}
                />
                <AxisText x={-8} y={g.y(t)} anchor="end" baseline="middle" upper={false}>
                  {g.axis.tick(t)}
                </AxisText>
              </g>
            ))}

            {data.map((d, i) => {
              const x = g.x(i) ?? 0;
              const isPeak = i === peak;
              const isAlert = d.flag || i === alertIndex;
              const isActive = i === active;
              const y = g.y(d.value);
              const h = Math.max(0, g.innerH - y);
              return (
                <g key={i}>
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
                    height={h}
                    pointerEvents="none"
                    className="transition-[fill] duration-[120ms]"
                    style={{
                      fill: isAlert
                        ? `url(#${hatchId})`
                        : isPeak
                          ? "var(--bl-data-1)"
                          : isActive
                            ? "var(--bl-data-2)"
                            : "var(--bl-data-3)",
                      stroke: isAlert ? "var(--bl-signal)" : "none",
                    }}
                    strokeWidth={isAlert ? 2 : 0}
                  />
                  {i % g.labelEvery === 0 || isPeak || isAlert ? (
                    <AxisText x={x + bw / 2} y={g.innerH + 18} emphasis={isPeak || isActive}>
                      {g.xLabels[i]}
                    </AxisText>
                  ) : null}
                  {isAlert
                    ? (() => {
                        // Textbärare för larmet: "! note", hålls inom diagrammets bredd
                        const t = `! ${d.note ?? "Kräver åtgärd"}`;
                        const w = t.length * CH_MONO;
                        const nx = Math.max(
                          -MV.left,
                          Math.min(x + bw / 2 - w / 2, g.innerW + MV.right - w),
                        );
                        return (
                          <AxisText x={nx} y={g.innerH + 32} anchor="start">
                            <tspan style={{ fill: "var(--bl-signal-fg)" }}>{t}</tspan>
                          </AxisText>
                        );
                      })()
                    : null}
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
                <text
                  x={right ? 4 : g.innerW}
                  y={g.y(g.avg) - 6}
                  textAnchor={right ? "start" : "end"}
                  className="tnum"
                  style={{ fontFamily: "var(--bl-font-mono)", fontSize: 10 }}
                >
                  <tspan
                    style={{
                      textTransform: "uppercase",
                      letterSpacing: "0.06em",
                      fill: "var(--bl-fg-subtle)",
                    }}
                  >
                    Snitt{" "}
                  </tspan>
                  <tspan style={{ fill: "var(--bl-fg-muted)" }}>{format(g.avg)}</tspan>
                </text>
              </g>
            ) : null}

            {hl && peak !== undefined ? (
              <g pointerEvents="none">
                <line
                  x1={hlx}
                  x2={hlx}
                  y1={g.y(hl.value) - 4}
                  y2={-MV.top + 26}
                  style={{ stroke: "var(--bl-fg-subtle)" }}
                />
                <text
                  x={hlx + (right ? -6 : 6)}
                  y={-MV.top + 12}
                  textAnchor={right ? "end" : "start"}
                  className="tnum"
                  style={{ fill: "var(--bl-fg)", fontSize: 12, fontWeight: 500 }}
                >
                  {format(hl.value)}
                </text>
                <AxisText
                  x={hlx + (right ? -6 : 6)}
                  y={-MV.top + 26}
                  anchor={right ? "end" : "start"}
                >
                  {highlightNote ?? `Högst · ${formatDelta(hl.value / g.avg - 1)} mot snitt`}
                </AxisText>
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
            x={MV.left + (g.x(active) ?? 0) + bw}
            y={MV.top}
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

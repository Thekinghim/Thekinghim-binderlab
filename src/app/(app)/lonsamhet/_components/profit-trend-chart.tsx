"use client";

import { scaleBand, scaleLinear } from "d3-scale";
import { curveLinear, line } from "d3-shape";
import { useId, useMemo, useState, type KeyboardEvent } from "react";

import { axisScale } from "@/components/charts/axis";
import {
  AxisText,
  AxisUnitLabel,
  ChartFigure,
  HatchPattern,
  Node,
  Readout,
} from "@/components/charts/primitives";
import { formatInt, formatPercent, MISSING } from "@/lib/format";
import { svgSizeProps, unmeasuredStyle, useMeasure } from "@/lib/hooks/use-measure";

export type TrendDatum = {
  /** Kort etikett på axeln, t.ex. "V42" eller "okt.". */
  axis: string;
  /** Rubrik i läsrutan, t.ex. "Vecka 42 · 13–18 okt.". */
  name: string;
  /** Vinst i kronor (kan vara negativ). */
  profit: number;
  /** Marginal som andel (0,314), eller null utan intäkt med inköpspris. */
  margin: number | null;
  /** Intäkt i kronor (alla order). */
  revenue: number;
  orders: number;
  /** Bara en del av veckan/månaden ligger i perioden: stapeln ritas med streckad kant. */
  partial?: boolean;
};

type Props = {
  data: ReadonlyArray<TrendDatum>;
  /** Exakt belopp, t.ex. formatSek. */
  format: (v: number) => string;
  summary: string;
  height?: number;
};

// Marginaler runt ritytan. Vänster rymmer axeltalen ("−12", "100").
const M = { top: 40, right: 8, left: 36, bottom: 26 };
/** Luft mellan vinstdelen och marginalremsan (rymmer remsans enhet och namn). */
const GAP = 34;
/** Marginalremsans höjd. */
const STRIP = 64;
// Geist Mono 10 px versaler med spärrning
const CH_MONO = 6.8;

/**
 * Vinst per vecka eller månad som staplar från noll (förlust nedåt), med marginalen
 * som en linje i en egen remsa under. Två axlar ovanpå varandra i stället för två
 * y-axlar i samma yta, så att ingen skala kan läsas mot fel serie.
 *
 * Formen bär betydelsen: vinst fylld (bästa i fg med belopp), förlust skrafferad, delvis
 * vecka/månad halvt fylld med streckad kant och "*" på axeln, och
 * den största förlusten i signal med 2 px ram och "! Förlust …" (högst en per diagram).
 * Tangentbord: ett tabbstopp, ← → flyttar läsrutan, Home/End till ändarna.
 */
export function ProfitTrendChart({ data, format, summary, height = 320 }: Props) {
  const [ref, width, measured] = useMeasure<HTMLDivElement>();
  const [active, setActive] = useState<number | null>(null);
  const uid = useId().replace(/:/g, "");
  const hatchId = `${uid}-h`;
  const alertId = `${uid}-a`;

  const g = useMemo(() => {
    const innerW = Math.max(10, width - M.left - M.right);
    const barsH = Math.max(60, height - M.top - GAP - STRIP - M.bottom);
    const stripTop = barsH + GAP;

    const x = scaleBand<number>()
      .domain(data.map((_, i) => i))
      .range([0, innerW])
      .paddingInner(innerW / Math.max(1, data.length) < 24 ? 0.2 : 0.38)
      .paddingOuter(0.1);

    const profits = data.map((d) => d.profit);
    const lo = Math.min(0, ...profits);
    const hi = Math.max(0, ...profits);
    const y = scaleLinear()
      .domain([lo, hi === lo ? lo + 1 : hi])
      .range([barsH, 0])
      .nice(4);
    const ticks = y.ticks(4);

    const margins = data.map((d) => d.margin).filter((m): m is number => m !== null);
    const mLo = Math.min(0, ...margins);
    const mHi = Math.max(0.0001, ...margins);
    const ym = scaleLinear()
      .domain([mLo, mHi])
      .range([stripTop + STRIP, stripTop])
      .nice(2);
    const mTicks = ym.ticks(2);

    let peak: number | undefined;
    let worst: number | undefined;
    let losses = 0;
    data.forEach((d, i) => {
      if (d.orders > 0 && (peak === undefined || d.profit > (data[peak]?.profit ?? 0))) peak = i;
      if (d.profit < 0) {
        losses++;
        if (worst === undefined || d.profit < (data[worst]?.profit ?? 0)) worst = i;
      }
    });
    if (peak !== undefined && (data[peak]?.profit ?? 0) <= 0) peak = undefined;

    const xLabelW = Math.max(0, ...data.map((d) => d.axis.length * CH_MONO)) + 8;
    const labelEvery = Math.max(1, Math.ceil((data.length * xLabelW) / innerW));

    const marginPath =
      line<TrendDatum>()
        .defined((d) => d.margin !== null)
        .x((_, i) => (x(i) ?? 0) + x.bandwidth() / 2)
        .y((d) => ym(d.margin ?? 0))
        .curve(curveLinear)(data as TrendDatum[]) ?? "";

    let lastMargin: number | undefined;
    data.forEach((d, i) => {
      if (d.margin !== null) lastMargin = i;
    });

    return {
      innerW,
      barsH,
      stripTop,
      x,
      y,
      ticks,
      axis: axisScale(ticks, "kr"),
      ym,
      mTicks,
      mAxis: axisScale(mTicks, { label: "%", divisor: 0.01 }),
      peak,
      worst,
      losses,
      labelEvery,
      marginPath,
      lastMargin,
    };
  }, [data, width, height]);

  const total = height;
  const bw = g.x.bandwidth();
  const cx = (i: number) => (g.x(i) ?? 0) + bw / 2;
  const zero = g.y(0);
  const last = data.length - 1;

  const onKey = (e: KeyboardEvent<SVGSVGElement>) => {
    if (data.length === 0) return;
    const cur = active ?? last;
    let next = cur;
    if (e.key === "ArrowRight") next = Math.min(last, cur + 1);
    else if (e.key === "ArrowLeft") next = Math.max(0, cur - 1);
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = last;
    else if (e.key === "Escape") return setActive(null);
    else return;
    e.preventDefault();
    setActive(next);
  };

  const a = active !== null ? data[active] : undefined;
  const peakD = g.peak !== undefined ? data[g.peak] : undefined;
  const worstD = g.worst !== undefined ? data[g.worst] : undefined;
  const lastM = g.lastMargin !== undefined ? data[g.lastMargin] : undefined;

  /** Text under/över en stapel, hållen inom diagrammets bredd. */
  const clampX = (center: number, text: string) => {
    const w = text.length * CH_MONO;
    if (center + w / 2 > g.innerW + M.right)
      return { x: g.innerW + M.right, anchor: "end" as const };
    if (center - w / 2 < -M.left) return { x: -M.left, anchor: "start" as const };
    return { x: center, anchor: "middle" as const };
  };

  const worstNote =
    worstD && g.worst !== undefined
      ? `! Förlust ${format(-worstD.profit)}${g.losses > 1 ? ` · och ${g.losses - 1} till` : ""}`
      : null;

  return (
    <ChartFigure summary={summary}>
      <div
        ref={ref}
        className="relative w-full"
        style={{ height: total, ...unmeasuredStyle(measured) }}
      >
        <svg
          {...svgSizeProps(width, total, measured)}
          className="absolute top-0 left-0 block overflow-visible focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-solid"
          tabIndex={0}
          role="img"
          aria-label={`${summary} Använd piltangenterna för att läsa av perioderna.`}
          onKeyDown={onKey}
          onFocus={() => setActive((v) => v ?? (data.length ? last : null))}
          onBlur={() => setActive(null)}
          onPointerLeave={() => setActive(null)}
        >
          <defs>
            <HatchPattern id={hatchId} />
            <HatchPattern id={alertId} tone="signal" />
          </defs>
          <g transform={`translate(${M.left},${M.top})`}>
            {/* Vinst: enhet, namn och rutnät */}
            <AxisUnitLabel x={-8} y={g.y(g.ticks[g.ticks.length - 1] ?? 0) - 14}>
              {g.axis.label}
            </AxisUnitLabel>
            <AxisText x={0} y={g.y(g.ticks[g.ticks.length - 1] ?? 0) - 14} anchor="start">
              Vinst
            </AxisText>
            {g.ticks.map((t) => (
              <g key={`t${t}`}>
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

            {/* Marginal: enhet, namn och rutnät */}
            <AxisUnitLabel x={-8} y={g.stripTop - 14}>
              {g.mAxis.label}
            </AxisUnitLabel>
            <AxisText x={0} y={g.stripTop - 14} anchor="start">
              Marginal
            </AxisText>
            {g.mTicks.map((t) => (
              <g key={`m${t}`}>
                <line
                  x1={0}
                  x2={g.innerW}
                  y1={g.ym(t)}
                  y2={g.ym(t)}
                  style={{ stroke: t === 0 ? "var(--bl-line-strong)" : "var(--bl-line)" }}
                  strokeDasharray={t === 0 ? undefined : "1 3"}
                />
                <AxisText x={-8} y={g.ym(t)} anchor="end" baseline="middle" upper={false}>
                  {g.mAxis.tick(t)}
                </AxisText>
              </g>
            ))}

            {data.map((d, i) => {
              const x0 = g.x(i) ?? 0;
              const isPeak = i === g.peak;
              const isWorst = i === g.worst;
              const isActive = i === active;
              const yv = g.y(d.profit);
              const top = Math.min(yv, zero);
              const h = Math.abs(yv - zero);
              const loss = d.profit < 0;
              // Bästa och aktiva perioden har alltid etikett; vanliga etiketter för nära
              // dem utelämnas så att texterna inte krockar.
              const crowded = (s: number | null | undefined) =>
                s !== null && s !== undefined && s !== i && Math.abs(i - s) < g.labelEvery;
              const showLabel =
                isPeak ||
                isActive ||
                ((i % g.labelEvery === 0 || (i === last && g.labelEvery === 1)) &&
                  !crowded(g.peak) &&
                  !crowded(active));
              return (
                <g key={i}>
                  <rect
                    x={x0 - (g.x.step() - bw) / 2}
                    y={-M.top}
                    width={g.x.step()}
                    height={total}
                    fill="transparent"
                    onPointerEnter={() => setActive(i)}
                    onPointerDown={() => setActive(i)}
                  />
                  <rect
                    x={x0}
                    y={top}
                    width={bw}
                    height={Math.max(h, d.orders > 0 ? 1 : 0)}
                    pointerEvents="none"
                    className="transition-[fill] duration-fast"
                    style={{
                      fill: isWorst
                        ? `url(#${alertId})`
                        : loss
                          ? `url(#${hatchId})`
                          : isPeak
                            ? "var(--bl-data-1)"
                            : isActive
                              ? "var(--bl-data-2)"
                              : "var(--bl-data-3)",
                      fillOpacity: d.partial && !isWorst && !loss ? 0.45 : 1,
                      stroke: isWorst
                        ? "var(--bl-signal)"
                        : loss || d.partial
                          ? "var(--bl-fg-muted)"
                          : "none",
                    }}
                    strokeWidth={isWorst ? 2 : loss || d.partial ? 1 : 0}
                    strokeDasharray={d.partial && !isWorst ? "2 2" : undefined}
                  />
                  {showLabel ? (
                    <AxisText x={cx(i)} y={g.stripTop + STRIP + 18} emphasis={isPeak || isActive}>
                      {d.axis}
                    </AxisText>
                  ) : null}
                </g>
              );
            })}

            {/* Bästa perioden: belopp ovanför stapeln, i fg */}
            {peakD && g.peak !== undefined
              ? (() => {
                  const text = format(peakD.profit);
                  const p = clampX(cx(g.peak), text);
                  return (
                    <text
                      x={p.x}
                      y={g.y(peakD.profit) - 8}
                      textAnchor={p.anchor}
                      className="tnum"
                      pointerEvents="none"
                      style={{ fill: "var(--bl-fg)", fontSize: 12, fontWeight: 500 }}
                    >
                      {text}
                    </text>
                  );
                })()
              : null}

            {/* Största förlusten: textbäraren för signalen */}
            {worstD && worstNote && g.worst !== undefined
              ? (() => {
                  const p = clampX(cx(g.worst), worstNote);
                  return (
                    <AxisText
                      x={p.x}
                      y={Math.min(g.barsH + 14, g.y(worstD.profit) + 14)}
                      anchor={p.anchor}
                    >
                      <tspan style={{ fill: "var(--bl-signal-fg)" }}>{worstNote}</tspan>
                    </AxisText>
                  );
                })()
              : null}

            {/* Marginal som linje */}
            <path
              d={g.marginPath}
              fill="none"
              pointerEvents="none"
              strokeWidth={1.25}
              style={{ stroke: "var(--bl-data-1)" }}
            />
            {data.length === 1 && data[0]?.margin != null ? (
              <Node x={cx(0)} y={g.ym(data[0].margin)} variant="solid" />
            ) : null}
            {lastM && g.lastMargin !== undefined && g.lastMargin !== active ? (
              <g pointerEvents="none">
                <Node x={cx(g.lastMargin)} y={g.ym(lastM.margin ?? 0)} />
                <AxisText
                  x={cx(g.lastMargin) - 6}
                  y={g.ym(lastM.margin ?? 0) - 8}
                  anchor="end"
                  upper={false}
                >
                  {lastM.margin === null ? MISSING : formatPercent(lastM.margin)}
                </AxisText>
              </g>
            ) : null}

            {a && active !== null ? (
              <g pointerEvents="none">
                <line
                  x1={cx(active)}
                  x2={cx(active)}
                  y1={0}
                  y2={g.stripTop + STRIP}
                  style={{ stroke: "var(--bl-fg-faint)" }}
                  strokeDasharray="2 2"
                />
                {a.margin !== null ? (
                  <Node x={cx(active)} y={g.ym(a.margin)} variant="solid" />
                ) : null}
              </g>
            ) : null}
          </g>
        </svg>
        {a && active !== null ? (
          <Readout
            x={M.left + cx(active) + bw / 2}
            y={M.top}
            containerWidth={width}
            label={a.name}
            rows={[
              {
                name: a.profit < 0 ? "Förlust" : "Vinst",
                value: format(Math.abs(a.profit)),
                strong: true,
              },
              { name: "Marginal", value: a.margin === null ? MISSING : formatPercent(a.margin) },
              { name: "Intäkt", value: format(a.revenue) },
              { name: "Order", value: formatInt(a.orders) },
            ]}
          />
        ) : null}
      </div>
    </ChartFigure>
  );
}

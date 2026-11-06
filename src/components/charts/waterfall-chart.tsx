"use client";

import { scaleBand, scaleLinear } from "d3-scale";
import { useId, useMemo, useState, type KeyboardEvent } from "react";
import { formatPercent } from "@/lib/format";
import { svgSizeProps, unmeasuredStyle, useMeasure } from "@/lib/hooks/use-measure";
import { axisScale, type AxisUnit } from "./axis";
import { AxisText, AxisUnitLabel, ChartFigure, HatchPattern, Readout } from "./primitives";

export type WaterfallStep = {
  label: string;
  /** Kortare etikett när platsen inte räcker, t.ex. "Till butiken". Hela ord, inga förkortningar. */
  short?: string;
  /** Förändring (positiv/negativ). Ignoreras för total. */
  value: number;
  /** Totalstapel räknas från noll till löpande summa */
  total?: boolean;
  /** Kräver åtgärd: signal + skraffering + 2 px ram + `note` som text */
  flag?: boolean;
  /** Text vid flaggat steg, t.ex. "Över mål" */
  note?: string;
  /** Fullt namn i läsrutan */
  name?: string;
};

export type WaterfallExcluded = {
  label: string;
  value: number;
  /** Standard "Ingår inte" */
  note?: string;
  name?: string;
};

type WaterfallProps = {
  steps: ReadonlyArray<WaterfallStep>;
  /** Exakt värde i läsrutan, t.ex. formatSek */
  format: (v: number) => string;
  /** @deprecated Ignoreras. Axeln och etiketterna använder en enhet via `unit`. */
  formatAxis?: (v: number) => string;
  /** Axelns enhet, standard "kr" (kr/tkr/mkr väljs efter största tick). */
  unit?: AxisUnit;
  /** Sista totalen får andel av första steget, t.ex. "31,1 tkr · 23,7 %". Standard true. */
  showShare?: boolean;
  /** Post bredvid bryggan som inte ingår, t.ex. intäkt utan inköpspris. Ritas streckad. */
  excluded?: WaterfallExcluded;
  height?: number;
  summary: string;
  /**
   * Resultatets andel som färdig text (t.ex. nyckeltalets marginal, formatMarginBp), så att
   * vattenfallet visar exakt samma procent som nyckeltalet. Utelämnad = resultat / första.
   */
  totalShareText?: string;
};

const M = { top: 40, right: 8, left: 36 };

// Tecknets bredd i axeltext (Geist Mono 11 px + spärrning)
const CH = 7.3;
// Försiktig bredd för högerkanten: versaler + 0,06 em spärrning + reservtypsnitt
const CH_UPPER = 7.7;

/**
 * Axeletiketter: hela, kort form eller två rader på mellanslag. Räcker inte
 * bredden växlar etiketterna mellan två nivåer i stället för att krocka.
 */
function layoutXLabels(items: ReadonlyArray<{ label: string; short?: string }>, step: number) {
  const fitLabel = (s: { label: string; short?: string }, room: number) => {
    const fits = (t: string) => t.length * CH <= room;
    if (fits(s.label)) return [s.label];
    if (s.short && fits(s.short)) return [s.short];
    const parts = s.label.split(" ");
    if (parts.length > 1) {
      const mid = Math.ceil(parts.length / 2);
      const two = [parts.slice(0, mid).join(" "), parts.slice(mid).join(" ")];
      if (two.every(fits)) return two;
    }
    return null;
  };
  const single = items.map((s) => fitLabel(s, step - 4));
  const stagger = single.some((l) => l === null);
  const xLines = items.map((s, i) =>
    stagger
      ? (fitLabel(s, step * 2 - 8) ?? [s.short ?? s.label])
      : (single[i] ?? [s.short ?? s.label]),
  );
  const depthOf = (odd: boolean) =>
    Math.max(0, ...xLines.filter((_, i) => i % 2 === (odd ? 1 : 0)).map((l) => l.length));
  const evenDepth = Math.max(1, depthOf(false));
  const depth = stagger ? evenDepth + depthOf(true) : Math.max(evenDepth, depthOf(true));
  return { xLines, stagger, evenDepth, depth };
}

/** Text under axeln som är bredare än sin kolumn hålls inom svg:n (g-koordinater). */
function clampText(cx: number, t: string, innerW: number) {
  const w = t.length * CH_UPPER;
  const right = innerW + M.right - 1;
  if (cx + w / 2 > right) return { x: right, anchor: "end" as const };
  if (cx - w / 2 < -M.left + 1) return { x: -M.left + 1, anchor: "start" as const };
  return { x: cx, anchor: "middle" as const };
}

type Bar = WaterfallStep & { start: number; end: number; kind: "start" | "up" | "down" | "total" };

/**
 * Vattenfall/brygga: från första beloppet till resultatet. Formen bär
 * betydelsen, så att den fungerar i svartvitt:
 * - start och totaler: fyllda (resultatet i fg)
 * - ökningar: ihåliga
 * - minskningar: skrafferade
 * - kräver åtgärd: signalskraffering, 2 px ram och textnotering
 * - ingår inte: streckad kontur, avskild med en lodlinje
 */
export function WaterfallChart({
  steps,
  format,
  unit = "kr",
  showShare = true,
  excluded,
  height = 280,
  summary,
  totalShareText,
}: WaterfallProps) {
  const [ref, width, measured] = useMeasure<HTMLDivElement>();
  const [active, setActive] = useState<number | null>(null);
  const uid = useId().replace(/:/g, "");
  const hatchId = `${uid}-h`;
  const alertId = `${uid}-a`;

  const g = useMemo(() => {
    let run = 0;
    const bars: Bar[] = [];
    steps.forEach((s, i) => {
      if (s.total) {
        bars.push({ ...s, start: 0, end: run, value: run, kind: "total" });
      } else {
        const start = run;
        run += s.value;
        bars.push({
          ...s,
          start: i === 0 ? 0 : start,
          end: run,
          kind: i === 0 ? "start" : s.value < 0 ? "down" : "up",
        });
      }
    });
    const n = bars.length + (excluded ? 1 : 0);
    const innerW = Math.max(10, width - M.left - M.right);
    const x = scaleBand<number>()
      .domain(Array.from({ length: n }, (_, i) => i))
      .range([0, innerW])
      .paddingInner(0.32)
      .paddingOuter(0.08);
    const items = [...bars, ...(excluded ? [excluded] : [])];
    const labels = layoutXLabels(items, x.step());
    // Marginalen under axeln växer med etikettnivåer och larmnoteringar
    // Noteringar ("! Över mål", "Ingår inte") står på egna rader under alla
    // axeletiketter. Krockar två på samma rad flyttas den senare en rad ned.
    const noteTexts = [
      ...bars.map((b, i) => (b.flag ? { i, t: `! ${b.note ?? "Kräver åtgärd"}` } : null)),
      excluded ? { i: bars.length, t: excluded.note ?? "Ingår inte" } : null,
    ].filter((v): v is { i: number; t: string } => v !== null);
    const rowEnds: number[] = [];
    const notes = new Map<
      number,
      { t: string; x: number; anchor: "start" | "middle" | "end"; row: number }
    >();
    for (const { i, t } of noteTexts) {
      const cx = (x(i) ?? 0) + x.bandwidth() / 2;
      const pos = clampText(cx, t, innerW);
      const w = t.length * CH_UPPER;
      const x0 = pos.anchor === "end" ? pos.x - w : pos.anchor === "start" ? pos.x : pos.x - w / 2;
      let row = rowEnds.findIndex((end) => x0 >= end + 8);
      if (row === -1) row = rowEnds.length;
      rowEnds[row] = x0 + w;
      notes.set(i, { t, ...pos, row });
    }
    const bottom = 18 + labels.depth * 12 + (labels.stagger ? 2 : 0) + rowEnds.length * 12 + 4;
    const innerH = Math.max(40, height - M.top - bottom);
    const vals = bars.flatMap((b) => [b.start, b.end]).concat(excluded ? [excluded.value] : []);
    const hi = Math.max(...vals, 1);
    const lo = Math.min(0, ...vals);
    const y = scaleLinear().domain([lo, hi]).range([innerH, 0]).nice(4);
    const ticks = y.ticks(4);
    return {
      bars,
      innerW,
      innerH,
      x,
      y,
      ticks,
      axis: axisScale(ticks, unit),
      n,
      labels,
      bottom,
      notes,
    };
  }, [steps, excluded, width, height, unit]);

  const bw = g.x.bandwidth();
  const step = g.x.step();
  const base = g.bars[0]?.value ?? 0;
  const lastIdx = g.bars.length - 1;
  const exIdx = excluded ? g.bars.length : -1;

  // Värdeetikett, en eller två rader. Resultatet får enhet och andel: "31,1 tkr · 23,7 %".
  const valueText = (b: Bar, i: number): string[] => {
    if (b.kind === "down" || b.kind === "up") return [g.axis.signed(b.value)];
    if (i === lastIdx && b.kind === "total") {
      const v = g.axis.withUnit(b.value);
      if (!(showShare && base)) return [v];
      const share = totalShareText ?? formatPercent(b.value / base);
      const one = `${v} · ${share}`;
      return one.length * 7.2 <= step + 8 ? [one] : [v, share];
    }
    return [g.axis.value(b.value)];
  };

  // Noteringsrader under alla axeletiketter
  const noteY = (row: number) =>
    g.innerH + 18 + g.labels.depth * 12 + (g.labels.stagger ? 2 : 0) + row * 12;
  const noteAt = (i: number) => {
    const n = g.notes.get(i);
    return n ? { ...n, y: noteY(n.row) } : undefined;
  };

  // Etikett som får plats: hela, kort form eller två rader på mellanslag.
  const { xLines, stagger, evenDepth } = g.labels;
  const xLabelY = (i: number) => g.innerH + 18 + (stagger && i % 2 === 1 ? evenDepth * 12 + 2 : 0);
  const xLabel = (i: number) => xLines[i] ?? [];

  // Värdeetiketter: centrerade över stapeln. Krockar en etikett med en
  // tidigare lyfts den ovanför och får en ledlinje ned till stapeln.
  const LH = 13;
  const placedValues: Array<{ x: number; y: number; w: number; h: number }> = [];
  // Avskiljaren före "ingår inte": bryggans etiketter stannar till vänster om den.
  const divX = excluded ? (g.x(exIdx) ?? 0) - (step - bw) / 2 : g.innerW + M.right;
  const valuePos = (cx: number, top: number, lines: string[], maxX = divX - 6) => {
    const w = Math.max(...lines.map((t) => t.length * 7.2));
    const h = lines.length * LH;
    const x = Math.max(0, Math.min(cx - w / 2, maxX - w));
    let y = top - 6 - h + 3;
    for (let guard = 0; guard < 6; guard++) {
      const hit = placedValues.find(
        (b) => x < b.x + b.w + 4 && x + w + 4 > b.x && y < b.y + b.h && y + h > b.y,
      );
      if (!hit) break;
      y = hit.y - h - 2;
    }
    placedValues.push({ x, y, w, h });
    return { lx: x + w / 2, baseline: y + h - 3, lifted: top - 6 - (y + h - 3) > 4 };
  };

  const onKey = (e: KeyboardEvent<SVGSVGElement>) => {
    const cur = active ?? lastIdx;
    let next = cur;
    if (e.key === "ArrowRight") next = Math.min(g.n - 1, cur + 1);
    else if (e.key === "ArrowLeft") next = Math.max(0, cur - 1);
    else if (e.key === "Escape") return setActive(null);
    else return;
    e.preventDefault();
    setActive(next);
  };

  const a = active !== null && active < g.bars.length ? g.bars[active] : undefined;
  const ex = active === exIdx ? excluded : undefined;

  return (
    <ChartFigure summary={summary}>
      <div ref={ref} className="relative w-full" style={{ height, ...unmeasuredStyle(measured) }}>
        <svg
          {...svgSizeProps(width, height, measured)}
          className="absolute top-0 left-0 block overflow-visible focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-solid"
          role="img"
          tabIndex={0}
          aria-label={`${summary} Använd piltangenterna för att läsa av stegen.`}
          onKeyDown={onKey}
          onFocus={() => setActive((v) => v ?? lastIdx)}
          onBlur={() => setActive(null)}
          onPointerLeave={() => setActive(null)}
        >
          <defs>
            <HatchPattern id={hatchId} />
            <HatchPattern id={alertId} tone="signal" />
          </defs>
          <g transform={`translate(${M.left},${M.top})`}>
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

            {g.bars.map((b, i) => {
              const x = g.x(i) ?? 0;
              const top = g.y(Math.max(b.start, b.end));
              const h = Math.max(1, Math.abs(g.y(b.start) - g.y(b.end)));
              const next = g.bars[i + 1];
              const isActive = active === i;
              const isResult = i === lastIdx && b.kind === "total";
              const fill = b.flag
                ? `url(#${alertId})`
                : b.kind === "down"
                  ? `url(#${hatchId})`
                  : b.kind === "up"
                    ? "var(--bl-surface)"
                    : isResult
                      ? "var(--bl-data-1)"
                      : "var(--bl-data-3)";
              const stroke = b.flag
                ? "var(--bl-signal)"
                : isActive
                  ? "var(--bl-fg)"
                  : b.kind === "down" || b.kind === "up"
                    ? "var(--bl-fg-muted)"
                    : isResult
                      ? "var(--bl-data-1)"
                      : "var(--bl-data-3)";
              const sw = b.flag ? 2 : 1;
              const labelLines = valueText(b, i);
              const cx = x + bw / 2;
              const vp = valuePos(cx, top, labelLines);
              const lines = xLabel(i);
              return (
                <g key={i} onPointerEnter={() => setActive(i)} onPointerDown={() => setActive(i)}>
                  <rect x={x - 4} y={0} width={bw + 8} height={g.innerH} fill="transparent" />
                  <rect
                    x={x + sw / 2}
                    y={top + sw / 2}
                    width={Math.max(0, bw - sw)}
                    height={Math.max(0, h - sw)}
                    strokeWidth={sw}
                    style={{ fill, stroke, ["--i" as string]: i * 4 }}
                    className="grow-y transition-[stroke] duration-fast [transform-box:fill-box]"
                  />
                  {next && i !== lastIdx ? (
                    <line
                      x1={x + bw}
                      x2={g.x(i + 1) ?? 0}
                      y1={g.y(b.end)}
                      y2={g.y(b.end)}
                      style={{ stroke: "var(--bl-fg-subtle)" }}
                      strokeDasharray="2 2"
                    />
                  ) : null}
                  {vp.lifted ? (
                    <line
                      x1={cx}
                      x2={cx}
                      y1={top - 3}
                      y2={vp.baseline + 4}
                      style={{ stroke: "var(--bl-fg-subtle)" }}
                    />
                  ) : null}
                  {labelLines.map((t, li) => (
                    <text
                      key={li}
                      x={vp.lx}
                      y={vp.baseline - (labelLines.length - 1 - li) * LH}
                      textAnchor="middle"
                      className="tnum"
                      style={{
                        fontFamily: "var(--bl-font-mono)",
                        fontSize: 11,
                        fontWeight: isResult && li === 0 ? 500 : 400,
                        fill: b.flag
                          ? "var(--bl-signal-fg)"
                          : (isResult && li === 0) || b.kind === "start"
                            ? "var(--bl-fg)"
                            : "var(--bl-fg-muted)",
                      }}
                    >
                      {t}
                    </text>
                  ))}
                  {b.flag
                    ? // Textbärare för larmet under axeletiketterna: läsbar även i svartvitt
                      (() => {
                        const n = noteAt(i);
                        return n ? (
                          <AxisText x={n.x} y={n.y} anchor={n.anchor}>
                            <tspan style={{ fill: "var(--bl-signal-fg)" }}>{n.t}</tspan>
                          </AxisText>
                        ) : null;
                      })()
                    : null}
                  {stagger && i % 2 === 1 ? (
                    <line
                      x1={cx}
                      x2={cx}
                      y1={g.innerH + 4}
                      y2={xLabelY(i) - 10}
                      style={{ stroke: "var(--bl-line-strong)" }}
                    />
                  ) : null}
                  {lines.map((t, li) => (
                    <AxisText
                      key={li}
                      x={cx}
                      y={xLabelY(i) + li * 12}
                      emphasis={isResult || b.kind === "start" || isActive}
                    >
                      {t}
                    </AxisText>
                  ))}
                </g>
              );
            })}

            {excluded ? (
              <g onPointerEnter={() => setActive(exIdx)} onPointerDown={() => setActive(exIdx)}>
                {(() => {
                  const x = g.x(exIdx) ?? 0;
                  const top = g.y(Math.max(0, excluded.value));
                  const h = Math.max(1, Math.abs(g.y(0) - g.y(excluded.value)));
                  const div = divX;
                  const cx = x + bw / 2;
                  // Höger kant i g-koordinater. Etiketter som inte ryms centrerat
                  // högerställs mot kanten (under axeln korsar de inte avskiljaren).
                  const edge = g.innerW + M.right - 1;
                  const fit = (t: string) =>
                    cx + (t.length * CH_UPPER) / 2 <= edge
                      ? { x: cx, anchor: "middle" as const }
                      : { x: edge, anchor: "end" as const };
                  const exVp = valuePos(cx, top, [g.axis.value(excluded.value)], edge);
                  const exLines = xLabel(exIdx);
                  const exNote = noteAt(exIdx);
                  return (
                    <>
                      <rect x={x - 4} y={0} width={bw + 8} height={g.innerH} fill="transparent" />
                      <line
                        x1={div}
                        x2={div}
                        y1={-M.top + 8}
                        y2={g.innerH}
                        style={{ stroke: "var(--bl-line-strong)" }}
                      />
                      <rect
                        x={x + 0.5}
                        y={top + 0.5}
                        width={bw - 1}
                        height={h - 1}
                        fill="none"
                        strokeDasharray="3 2"
                        style={{
                          stroke: active === exIdx ? "var(--bl-fg)" : "var(--bl-fg-subtle)",
                        }}
                      />
                      <text
                        x={exVp.lx}
                        y={exVp.baseline}
                        textAnchor="middle"
                        className="tnum"
                        style={{
                          fontFamily: "var(--bl-font-mono)",
                          fontSize: 11,
                          fill: "var(--bl-fg-subtle)",
                        }}
                      >
                        {g.axis.value(excluded.value)}
                      </text>
                      {stagger && exIdx % 2 === 1 ? (
                        <line
                          x1={cx}
                          x2={cx}
                          y1={g.innerH + 4}
                          y2={xLabelY(exIdx) - 10}
                          style={{ stroke: "var(--bl-line-strong)" }}
                        />
                      ) : null}
                      {exLines.map((t, li) => (
                        <AxisText key={li} {...fit(t)} y={xLabelY(exIdx) + li * 12}>
                          {t}
                        </AxisText>
                      ))}
                      {exNote ? (
                        <AxisText x={exNote.x} y={exNote.y} anchor={exNote.anchor}>
                          {exNote.t}
                        </AxisText>
                      ) : null}
                    </>
                  );
                })()}
              </g>
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
              {
                name: a.kind === "total" ? "Summa" : a.kind === "start" ? "Belopp" : "Förändring",
                value:
                  a.kind === "total" || a.kind === "start"
                    ? format(a.value)
                    : `${a.value > 0 ? "+" : "−"}${format(Math.abs(a.value))}`,
                strong: true,
              },
              ...(a.kind === "up" || a.kind === "down"
                ? [{ name: "Löpande", value: format(a.end) }]
                : []),
              ...(base && active > 0
                ? [
                    {
                      name: `Andel av ${g.bars[0]?.label.toLowerCase() ?? ""}`,
                      value:
                        a.kind === "total" && active === lastIdx && totalShareText !== undefined
                          ? totalShareText
                          : formatPercent(Math.abs(a.value) / base),
                    },
                  ]
                : []),
            ]}
          />
        ) : null}
        {ex ? (
          <Readout
            x={M.left + (g.x(exIdx) ?? 0) + bw}
            y={M.top}
            containerWidth={width}
            label={ex.name ?? ex.label}
            rows={[{ name: ex.note ?? "Ingår inte", value: format(ex.value), strong: true }]}
          />
        ) : null}
      </div>
    </ChartFigure>
  );
}

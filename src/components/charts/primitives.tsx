"use client";

import type { CSSProperties, ReactNode } from "react";
import { cn } from "@/lib/cn";
import { labelSpec, type Box, type LabelKind, type LabelLine } from "./layout";

/**
 * Monospace axeltext i SVG. Versaler som standard (kategorier, datum);
 * `upper={false}` för tal och enheter, så att "tkr" aldrig blir "TKR".
 */
export function AxisText({
  x,
  y,
  children,
  anchor = "middle",
  baseline = "auto",
  emphasis,
  upper = true,
}: {
  x: number;
  y: number;
  children: ReactNode;
  anchor?: "start" | "middle" | "end";
  baseline?: "auto" | "middle" | "hanging";
  emphasis?: boolean;
  upper?: boolean;
}) {
  return (
    <text
      x={x}
      y={y}
      textAnchor={anchor}
      dominantBaseline={baseline}
      className="tnum"
      style={{
        fontFamily: "var(--bl-font-mono)",
        fontSize: 10,
        letterSpacing: upper ? "0.06em" : 0,
        textTransform: upper ? "uppercase" : "none",
        fill: emphasis ? "var(--bl-fg)" : "var(--bl-fg-subtle)",
      }}
    >
      {children}
    </text>
  );
}

/** Axelns enhet, en gång, ovanför axeln. Gemener: "tkr", "köp/tim". */
export function AxisUnitLabel({
  x,
  y,
  children,
  anchor = "end",
}: {
  x: number;
  y: number;
  children: ReactNode;
  anchor?: "start" | "middle" | "end";
}) {
  return (
    <AxisText x={x} y={y} anchor={anchor} upper={false}>
      {children}
    </AxisText>
  );
}

const KIND_STYLE: Record<LabelKind, CSSProperties> = {
  title: { fontFamily: "var(--bl-font-sans)", fontWeight: 500, fill: "var(--bl-fg)" },
  body: { fontFamily: "var(--bl-font-sans)", fill: "var(--bl-fg-muted)" },
  value: { fontFamily: "var(--bl-font-mono)", fill: "var(--bl-fg-muted)" },
  caps: {
    fontFamily: "var(--bl-font-mono)",
    letterSpacing: "0.06em",
    textTransform: "uppercase",
    fill: "var(--bl-fg-subtle)",
  },
};

/**
 * Direktetikett i SVG: en eller flera rader, där varje rad kan blanda
 * typer (t.ex. "SNITT" i versaler + "4 131 kr" i gemener). Placeras i en ruta
 * som räknats fram med layout.place().
 */
export function LabelBlock({
  box,
  lines,
  align = "start",
  tone,
}: {
  box: Box;
  lines: ReadonlyArray<LabelLine>;
  align?: "start" | "end";
  /** "signal" färgar första raden i signaltext (endast för det som kräver åtgärd) */
  tone?: "signal";
}) {
  const x = align === "end" ? box.x + box.w : box.x;
  const heights = lines.map((line) => Math.max(...line.map((s) => labelSpec(s.kind).lh)));
  return (
    <g pointerEvents="none">
      {lines.map((line, li) => {
        const y = box.y + heights.slice(0, li + 1).reduce((a, b) => a + b, 0);
        return (
          <text
            key={li}
            x={x}
            y={y - 4}
            textAnchor={align}
            className="tnum"
            // Gloria i ytans färg: linjer som korsar etiketten bryts i stället för att störa texten
            style={{
              fontSize: labelSpec(line[0]?.kind ?? "body").size,
              stroke: "var(--bl-chart-halo, var(--bl-surface))",
              strokeWidth: 4,
              strokeLinejoin: "round",
              paintOrder: "stroke",
            }}
          >
            {line.map((s, si) => (
              <tspan
                key={si}
                style={{
                  ...KIND_STYLE[s.kind],
                  fontSize: labelSpec(s.kind).size,
                  ...(tone === "signal" && li === 0 ? { fill: "var(--bl-signal-fg)" } : null),
                }}
              >
                {s.text}
              </tspan>
            ))}
          </text>
        );
      })}
    </g>
  );
}

/**
 * Skraffering för minskningar och avdrag. userSpaceOnUse ger samma täthet i
 * alla staplar; 1 px linje i fg-muted håller över 3:1 i alla tre teman.
 */
export function HatchPattern({ id, tone = "muted" }: { id: string; tone?: "muted" | "signal" }) {
  return (
    <pattern
      id={id}
      width={4}
      height={4}
      patternUnits="userSpaceOnUse"
      patternTransform="rotate(45)"
    >
      <line
        x1={0}
        y1={0}
        x2={0}
        y2={4}
        strokeWidth={1}
        style={{ stroke: tone === "signal" ? "var(--bl-signal)" : "var(--bl-fg-muted)" }}
      />
    </pattern>
  );
}

/**
 * Nod på datapunkt. Formen bär betydelsen, så att den överlever svartvitt:
 * - "hollow": ihålig kvadrat (vanlig punkt, t.ex. lägsta/senaste)
 * - "solid": fylld kvadrat i fg (aktiv punkt, topp/rekord)
 * - "circle": ihålig cirkel (jämförelseserien)
 * - "signal-ring" / "alert": fylld kvadrat + ring i signal (kräver åtgärd)
 * - "signal": fylld kvadrat i signal (aktiv punkt som kräver åtgärd)
 */
export function Node({
  x,
  y,
  size = 5,
  variant = "hollow",
}: {
  x: number;
  y: number;
  size?: number;
  variant?: "hollow" | "solid" | "circle" | "signal" | "signal-ring" | "alert";
}) {
  const h = size / 2;
  if (variant === "circle") {
    return (
      <circle
        cx={x}
        cy={y}
        r={h}
        strokeWidth={1}
        style={{ fill: "var(--bl-surface)", stroke: "var(--bl-data-2)" }}
      />
    );
  }
  if (variant === "signal-ring" || variant === "alert") {
    return (
      <g>
        <rect
          x={x - h - 3}
          y={y - h - 3}
          width={size + 6}
          height={size + 6}
          fill="none"
          style={{ stroke: "var(--bl-signal)" }}
          strokeWidth={1}
        />
        <rect x={x - h} y={y - h} width={size} height={size} style={{ fill: "var(--bl-signal)" }} />
      </g>
    );
  }
  return (
    <rect
      x={x - h}
      y={y - h}
      width={size}
      height={size}
      strokeWidth={1}
      style={{
        fill:
          variant === "hollow"
            ? "var(--bl-surface)"
            : variant === "signal"
              ? "var(--bl-signal)"
              : "var(--bl-fg)",
        stroke:
          variant === "signal"
            ? "var(--bl-signal)"
            : variant === "hollow"
              ? "var(--bl-data-2)"
              : "var(--bl-fg)",
      }}
    />
  );
}

/** Läsruta vid hover: etikett i monospace och exakt värde. Placeras i HTML ovanpå SVG. */
export function Readout({
  x,
  y = 0,
  containerWidth,
  label,
  rows,
}: {
  x: number;
  y?: number;
  containerWidth: number;
  label: string;
  rows: Array<{ name?: string; value: string; strong?: boolean; marker?: ReactNode }>;
}) {
  const w = 188;
  const flip = x + 12 + w > containerWidth;
  const left = flip ? Math.max(0, x - 12 - w) : x + 12;
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute z-10 flex flex-col gap-1 rounded-sm border border-line-strong bg-raised px-2.5 py-2"
      style={{ left, top: y, width: w }}
    >
      <span className="label text-subtle">{label}</span>
      {rows.map((r, i) => (
        <span key={i} className="flex items-baseline justify-between gap-3">
          {r.name ? (
            <span className="flex items-center gap-1.5 text-xs whitespace-nowrap text-muted">
              {r.marker}
              {r.name}
            </span>
          ) : null}
          <span
            className={cn("tnum font-mono", r.strong ? "text-base text-fg" : "text-sm text-muted")}
          >
            {r.value}
          </span>
        </span>
      ))}
    </div>
  );
}

/** Ram runt ett diagram med visuellt dold sammanfattning för skärmläsare. */
export function ChartFigure({
  summary,
  children,
  className,
}: {
  summary: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <figure className={cn("relative m-0 w-full [contain:inline-size]", className)}>
      {children}
      <figcaption className="sr-only">{summary}</figcaption>
    </figure>
  );
}

export function nearestIndex(xs: number[], px: number): number {
  let best = 0;
  let dist = Infinity;
  xs.forEach((x, i) => {
    const d = Math.abs(x - px);
    if (d < dist) {
      dist = d;
      best = i;
    }
  });
  return best;
}

"use client";

import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

/** Monospace axeltext i SVG. */
export function AxisText({
  x,
  y,
  children,
  anchor = "middle",
  baseline = "auto",
  emphasis,
}: {
  x: number;
  y: number;
  children: ReactNode;
  anchor?: "start" | "middle" | "end";
  baseline?: "auto" | "middle" | "hanging";
  emphasis?: boolean;
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
        letterSpacing: "0.06em",
        textTransform: "uppercase",
        fill: emphasis ? "var(--bl-fg)" : "var(--bl-fg-subtle)",
      }}
    >
      {children}
    </text>
  );
}

/** Kvadratisk nod på datapunkt. Ihålig som standard, fylld när aktiv. */
export function Node({
  x,
  y,
  size = 5,
  variant = "hollow",
}: {
  x: number;
  y: number;
  size?: number;
  variant?: "hollow" | "solid" | "signal" | "signal-ring";
}) {
  const h = size / 2;
  if (variant === "signal-ring") {
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
    <figure className={cn("relative m-0 w-full", className)}>
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

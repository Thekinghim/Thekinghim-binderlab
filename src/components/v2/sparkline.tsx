import { cn } from "@/lib/cn";

/** SVG-väg för en liten linje i rutan 0..width × 0..height (null-värden hoppas över). */
export function sparkPath(
  values: ReadonlyArray<number | null>,
  width: number,
  height: number,
  pad = 2,
): {
  d: string;
  last: { x: number; y: number } | null;
} {
  const points = values
    .map((v, i) => (v === null || !Number.isFinite(v) ? null : { i, v }))
    .filter((p): p is { i: number; v: number } => p !== null);
  if (points.length === 0) return { d: "", last: null };
  const min = Math.min(...points.map((p) => p.v));
  const max = Math.max(...points.map((p) => p.v));
  const span = max - min || 1;
  const n = Math.max(1, values.length - 1);
  const xy = points.map((p) => ({
    x: (p.i / n) * width,
    y: max === min ? height / 2 : pad + (1 - (p.v - min) / span) * (height - pad * 2),
  }));
  const d = xy.map((p, k) => `${k === 0 ? "M" : "L"}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join("");
  return { d, last: xy[xy.length - 1] ?? null };
}

/**
 * Liten linje med slutpunkt (KPI-rutorna, automatlistan). Ritas i hela bredden; höjden fast.
 * Linjen är dekor: talet står alltid bredvid (aria-hidden).
 */
export function Sparkline({
  values,
  height = 24,
  dot = true,
  className,
  tone = "muted",
}: {
  values: ReadonlyArray<number | null>;
  height?: number;
  dot?: boolean;
  className?: string;
  /** muted: grå linje (som prototypen), ink: mörk, profit: grön. */
  tone?: "muted" | "ink" | "profit";
}) {
  const width = 100;
  const { d, last } = sparkPath(values, width, height);
  if (!d) return null;
  const stroke =
    tone === "ink" ? "var(--v2-ink)" : tone === "profit" ? "var(--v2-profit)" : "var(--v2-line3)";
  return (
    <span className={cn("relative block", className)} style={{ height }} aria-hidden="true">
      <svg
        className="block h-full w-full"
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
      >
        <path
          d={d}
          fill="none"
          stroke={stroke}
          strokeWidth={1.5}
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      {dot && last ? (
        <span
          className="absolute size-[5px] rounded-full bg-v2-ink"
          style={{
            left: `${last.x}%`,
            top: last.y,
            transform: `translate(${last.x >= width ? "-100%" : "-50%"}, -50%)`,
          }}
        />
      ) : null}
    </span>
  );
}

import { extent } from "d3-array";
import { scaleLinear } from "d3-scale";
import { area, curveLinear, line } from "d3-shape";

type SparklineProps = {
  data: ReadonlyArray<number>;
  width?: number;
  height?: number;
  /** Markera sista punkten med signalfärg (t.ex. avvikelse) */
  alert?: boolean;
  /** Visa en referenslinje, t.ex. föregående periods snitt */
  reference?: number;
  className?: string;
  label?: string;
};

/** Liten trendlinje utan axlar. viewBox skalar fritt i bredd. */
export function Sparkline({
  data,
  width = 120,
  height = 32,
  alert,
  reference,
  className,
  label,
}: SparklineProps) {
  if (data.length < 2) return null;
  const pad = 3;
  const [min = 0, max = 1] = extent(reference !== undefined ? [...data, reference] : data);
  const x = scaleLinear()
    .domain([0, data.length - 1])
    .range([pad, width - pad]);
  const y = scaleLinear()
    .domain([min, max === min ? min + 1 : max])
    .range([height - pad, pad]);
  const pts = data.map((d, i) => [x(i), y(d)] as [number, number]);
  const linePath = line().curve(curveLinear)(pts) ?? "";
  const areaPath =
    area<[number, number]>()
      .x((p) => p[0])
      .y0(height)
      .y1((p) => p[1])(pts) ?? "";
  const last = pts[pts.length - 1] ?? [0, 0];
  const s = 4;

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width="100%"
      height={height}
      preserveAspectRatio="none"
      className={className}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <path d={areaPath} style={{ fill: "var(--bl-fg)", opacity: 0.05 }} />
      {reference !== undefined ? (
        <line
          x1={0}
          x2={width}
          y1={y(reference)}
          y2={y(reference)}
          style={{ stroke: "var(--bl-fg-faint)" }}
          strokeDasharray="2 2"
          vectorEffect="non-scaling-stroke"
        />
      ) : null}
      <path
        d={linePath}
        fill="none"
        style={{ stroke: "var(--bl-data-2)" }}
        strokeWidth={1.25}
        vectorEffect="non-scaling-stroke"
      />
      <rect
        x={last[0] - s / 2}
        y={last[1] - s / 2}
        width={s}
        height={s}
        style={{ fill: alert ? "var(--bl-signal)" : "var(--bl-fg)" }}
      />
    </svg>
  );
}

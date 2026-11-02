import { extent } from "d3-array";
import { scaleLinear } from "d3-scale";
import { area, curveLinear, line } from "d3-shape";
import { cn } from "@/lib/cn";

type SparklineProps = {
  data: ReadonlyArray<number>;
  width?: number;
  height?: number;
  /** Sista punkten kräver åtgärd: signalfärg + ring, så att den syns även i svartvitt */
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

  // Noden ritas i HTML ovanpå, så att den förblir kvadratisk när viewBox sträcks i bredd.
  return (
    <span className={cn("relative block w-full", className)} style={{ height }}>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        width="100%"
        height={height}
        preserveAspectRatio="none"
        className="block"
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
      </svg>
      <span
        aria-hidden
        className={cn(
          "absolute -translate-x-1/2 -translate-y-1/2",
          alert ? "bg-signal outline outline-1 outline-offset-2 outline-signal" : "bg-fg",
        )}
        style={{ left: `${(last[0] / width) * 100}%`, top: last[1], width: s, height: s }}
      />
    </span>
  );
}

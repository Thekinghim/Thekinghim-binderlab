import { cn } from "@/lib/cn";

type KpiTraceProps = {
  data: ReadonlyArray<number>;
  /** Föregående periods snitt: ritas som 1px streckad hjälplinje */
  reference?: number;
  /** Kräver åtgärd: slutnoden ritas i signalfärg */
  alert?: boolean;
  /**
   * Visa slutnoden även utan larm (liten kvadrat i förgrundsfärg). Av som
   * standard: en nod överallt blir dekor och tar udden av larmnoden.
   */
  node?: boolean;
  height?: number;
  /** Beskrivning för skärmläsare. Utan den döljs linjen (värdet står ju i text bredvid). */
  label?: string;
  className?: string;
};

const W = 100;
const PAD = 2;

/**
 * Konstruerad mikrotrend för nyckeltal: en 1px linje, en streckad
 * hjälplinje för jämförelseperiodens snitt och, bara vid larm (eller med
 * node), en kvadratisk slutnod.
 * Ingen ytfyllnad, inga axlar. Noden ritas i HTML så att den förblir
 * kvadratisk när linjen sträcks i bredd.
 */
export function KpiTrace({
  data,
  reference,
  alert,
  node = false,
  height = 32,
  label,
  className,
}: KpiTraceProps) {
  if (data.length < 2) return null;
  const values = reference !== undefined ? [...data, reference] : [...data];
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max === min ? 1 : max - min;
  const x = (i: number) => (i / (data.length - 1)) * W;
  const y = (v: number) => PAD + (1 - (v - min) / span) * (height - PAD * 2);
  const points = data.map((v, i) => `${x(i).toFixed(2)},${y(v).toFixed(2)}`).join(" ");
  const lastY = y(data[data.length - 1] ?? min);
  const showNode = node || alert;
  const n = alert ? 5 : 3;

  return (
    <div
      className={cn("relative w-full", className)}
      style={{ height }}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <svg
        viewBox={`0 0 ${W} ${height}`}
        width="100%"
        height={height}
        preserveAspectRatio="none"
        className="block overflow-visible"
      >
        {reference !== undefined ? (
          <line
            x1={0}
            x2={W}
            y1={y(reference)}
            y2={y(reference)}
            stroke="var(--bl-fg-faint)"
            strokeWidth={1}
            strokeDasharray="2 3"
            vectorEffect="non-scaling-stroke"
            shapeRendering="crispEdges"
          />
        ) : null}
        <polyline
          points={points}
          fill="none"
          stroke="var(--bl-data-2)"
          strokeWidth={1}
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      {showNode ? (
        <span
          aria-hidden
          className={cn("absolute right-0 block", alert ? "bg-signal" : "bg-fg")}
          style={{ width: n, height: n, top: lastY - n / 2, marginRight: -Math.floor(n / 2) }}
        />
      ) : null}
    </div>
  );
}

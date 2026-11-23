import type { CSSProperties, ReactNode } from "react";

import { cn } from "@/lib/cn";
import { NBSP } from "@/lib/format";

import { RING, ringGeometry } from "./visual-math";

/**
 * Målring: grå bana, grön båge för utfallet (runda ändar), streckad ljusgrön båge fram till
 * prognosen och en mörk markör tvärs över ringen där takten säger att man borde vara i dag.
 * Mitten: procenten (eller `center`) och en rad under (`caption`, t.ex. "av 50 000 kr").
 *
 * Kronor: komponenten visar bara det den får. Sidor för påfyllare och demokund skickar
 * `caption` utan belopp.
 *
 * Bågen ritas fram från noll när ringen visas (900 ms, ease-out); inte med
 * prefers-reduced-motion. `size` = px på dator, `phoneSize` på telefon (≤ 900 px).
 * CSS: src/styles/v2.css, blocket "Målring".
 */
export function ProgressRing({
  value,
  goal,
  pace,
  forecast,
  label,
  center,
  caption,
  size = 150,
  phoneSize = 124,
  className,
}: {
  value: number;
  goal: number;
  pace?: number | null;
  forecast?: number | null;
  /** Hela ringen i ord för skärmläsare, t.ex. "74 procent av målet 50 000 kr, takten 77 procent". */
  label: string;
  /** Ersätter procenten i mitten. */
  center?: ReactNode;
  caption?: ReactNode;
  size?: number;
  phoneSize?: number;
  className?: string;
}) {
  const g = ringGeometry({ value, goal, pace, forecast });
  const { box, cx, r, stroke } = RING;
  return (
    <div
      role="img"
      aria-label={label}
      className={cn("v2-ring", g.reached && "reached", className)}
      style={
        { "--s": `${size}px`, "--s-ph": `${phoneSize}px`, "--c": g.c.toFixed(2) } as CSSProperties
      }
    >
      <svg viewBox={`0 0 ${box} ${box}`} aria-hidden="true" focusable="false">
        <circle className="v2-ring-track" cx={cx} cy={cx} r={r} strokeWidth={stroke} />
        {g.forecastPath ? (
          <path className="v2-ring-fc" d={g.forecastPath} strokeWidth={stroke} />
        ) : null}
        {g.resultDash ? (
          <circle
            className="v2-ring-res"
            cx={cx}
            cy={cx}
            r={r}
            strokeWidth={stroke}
            strokeDasharray={g.resultDash}
          />
        ) : null}
        {g.paceTick ? (
          <g className="v2-ring-pace">
            <line {...g.paceTick} className="halo" />
            <line {...g.paceTick} className="tick" />
          </g>
        ) : null}
      </svg>
      <div className="v2-ring-c" aria-hidden="true">
        <b>{center ?? (g.percent == null ? "–" : `${g.percent}${NBSP}%`)}</b>
        {caption ? <span>{caption}</span> : null}
      </div>
    </div>
  );
}

/**
 * Förklaringens markör för ringen: "result" (fylld grön prick), "pace" (mörkt streck),
 * "forecast" (streckad ring). Används i ringens förklaring bredvid, med texten intill.
 */
export function RingKey({ kind }: { kind: "result" | "pace" | "forecast" }) {
  return <span aria-hidden="true" className={cn("v2-ring-key", kind)} />;
}

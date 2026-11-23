import type { CSSProperties, ReactNode } from "react";

import { cn } from "@/lib/cn";
import { NBSP } from "@/lib/format";

import { profitBarParts } from "./visual-math";

/**
 * Staplad intäktsstapel: inköp (grått) + vinst (grönt), med marginalen i text efter. Längden är
 * intäkten relativt `max` (störst i listan = full längd), så att rader går att jämföra.
 * Okänt inköp (`cost` null) ger en randig stapel och texten "vinst okänd" (eller `label`).
 * Förlust: bara inköpsdelen, och marginalen i rött.
 *
 * Inköpspriset syns aldrig för butiken: sidor för butiker skickar inte `cost` (då blir det den
 * randiga stapeln) eller visar inte stapeln alls. Belopp i `title` är sidans ansvar.
 *
 * Stapeln växer fram från vänster när den visas (700 ms, `delay` ms för listor); inte med
 * prefers-reduced-motion. `wide` = stapeln fyller raden (utan skala), t.ex. i ett kort.
 * CSS: src/styles/v2.css, blocket "Vinststapel".
 */
export function ProfitBar({
  revenue,
  cost,
  max,
  label,
  title,
  wide = false,
  delay = 0,
  className,
}: {
  revenue: number;
  cost: number | null | undefined;
  max: number;
  /** Ersätter marginalen efter stapeln. */
  label?: ReactNode;
  /** Tooltip, t.ex. "Intäkt 21 000 kr · Inköp 13 000 kr · Vinst 8 000 kr". */
  title?: string;
  wide?: boolean;
  delay?: number;
  className?: string;
}) {
  const p = profitBarParts(revenue, cost, wide ? revenue : max);
  const unknown = p.costPct == null;
  const end =
    label ??
    (unknown ? (
      "vinst okänd"
    ) : p.marginPct == null ? null : (
      <b>{`${p.marginPct.toLocaleString("sv-SE", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}${NBSP}%`}</b>
    ));
  return (
    <div
      className={cn("v2-pbar", wide && "wide", unknown && "unknown", p.loss && "loss", className)}
      title={title}
      style={{ "--wf": p.widthPct / 100, "--d": `${delay}ms` } as CSSProperties}
    >
      <span className="v2-pbar-trk" aria-hidden="true">
        {unknown ? (
          <i className="hatch" />
        ) : (
          <>
            <i className="cost" style={{ width: `${p.costPct}%` }} />
            {p.profitPct ? <i className="prof" /> : null}
          </>
        )}
      </span>
      {end != null ? <span className="v2-pbar-end">{end}</span> : null}
    </div>
  );
}

import type { Evidence } from "@/reports";
import { KeyValues } from "@/components/v2/key-values";
import { cn } from "@/lib/cn";
import { formatInt } from "@/lib/format";

import { dateText, figureText } from "./text";

/**
 * Underlaget till en siffra: regeln i klartext, vilka order som ingår och talen
 * den räknas ur. Samma underlag som i butiksrapporten (Evidence i @/reports).
 * V2: en hopfälld rad ("› Så räknas det") som öppnar en grå ruta med regeln och talen.
 */
export function EvidenceDetails({
  evidence,
  summary = "Så räknas det",
  className,
  id,
}: {
  evidence: Evidence;
  summary?: string;
  className?: string;
  id?: string;
}) {
  const { scope } = evidence;
  return (
    <details id={id} className={cn("pt-ev scroll-mt-28", className)}>
      <summary>
        <span aria-hidden className="chev">
          ›
        </span>
        {summary}
      </summary>
      <div className="in">
        <p>{evidence.rule}</p>
        <KeyValues
          items={[
            {
              key: "period",
              label: "Period",
              value:
                scope.period.start === scope.period.end
                  ? dateText(scope.period.start)
                  : `${dateText(scope.period.start)} – ${dateText(scope.period.end)}`,
            },
            { key: "orders", label: "Sålda pack", value: formatInt(evidence.orderCount) },
            ...evidence.figures.map((f) => ({
              key: `f-${f.label}`,
              label: f.label,
              value: figureText(f.value, f.unit),
            })),
          ]}
        />
      </div>
    </details>
  );
}

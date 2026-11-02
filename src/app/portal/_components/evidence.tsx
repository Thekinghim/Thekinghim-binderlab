import type { Evidence } from "@/reports";
import { cn } from "@/lib/cn";
import { formatInt } from "@/lib/format";

import { dateText, figureText } from "./text";

/**
 * Underlaget till en siffra: regeln i klartext, vilka order som ingår och talen
 * den räknas ur. Samma underlag som i butiksrapporten (Evidence i @/reports).
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
    <details id={id} className={cn("group scroll-mt-28", className)}>
      <summary className="meta inline-flex cursor-pointer list-none items-center gap-1.5 rounded-xs text-muted transition-colors duration-fast ease-instrument select-none hover:text-fg [&::-webkit-details-marker]:hidden">
        <span aria-hidden className="text-faint transition-transform group-open:rotate-90">
          ›
        </span>
        {summary}
      </summary>
      <div className="mt-3 flex flex-col gap-3 border-t border-line pt-3">
        <p className="text-sm text-muted">{evidence.rule}</p>
        <dl className="flex flex-col">
          <div className="flex items-baseline justify-between gap-4 border-b border-line py-1.5">
            <dt className="label text-subtle">Period</dt>
            <dd className="meta tnum text-right text-fg">
              {scope.period.start === scope.period.end
                ? dateText(scope.period.start)
                : `${dateText(scope.period.start)} – ${dateText(scope.period.end)}`}
            </dd>
          </div>
          <div className="flex items-baseline justify-between gap-4 border-b border-line py-1.5">
            <dt className="label text-subtle">Sålda pack</dt>
            <dd className="meta tnum text-right text-fg">{formatInt(evidence.orderCount)}</dd>
          </div>
          {evidence.figures.map((f) => (
            <div
              key={f.label}
              className="flex items-baseline justify-between gap-4 border-b border-line py-1.5"
            >
              <dt className="text-sm text-muted">{f.label}</dt>
              <dd className="meta tnum text-right text-fg">{figureText(f.value, f.unit)}</dd>
            </div>
          ))}
        </dl>
      </div>
    </details>
  );
}

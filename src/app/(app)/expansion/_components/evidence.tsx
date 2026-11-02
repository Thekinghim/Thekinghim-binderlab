import Link from "next/link";

import type { ScenarioEvidence } from "@/analytics/expansion";
import { cn } from "@/lib/cn";
import { formatInt } from "@/lib/format";

import { figureText } from "../_lib/display";
import type { EvidenceLink } from "../_lib/model";

/**
 * Underlaget för en siffra: regeln i klartext, talen den bygger på och länkar till samma
 * period och urval i Lönsamhet. Utfällbart (<details>), så att svaret står först och
 * underlaget en klick bort. Ingen klientkod.
 */
export function EvidenceDetails({
  evidence,
  links,
  label = "Underlag",
  className,
}: {
  evidence: ScenarioEvidence;
  links: readonly EvidenceLink[];
  label?: string;
  className?: string;
}) {
  const parts: string[] = [];
  if (evidence.orderIds.length > 0) parts.push(`${formatInt(evidence.orderIds.length)} order`);
  if (evidence.dates.length > 0) parts.push(`${formatInt(evidence.dates.length)} dagar`);
  return (
    <details className={cn("group min-w-0", className)}>
      <summary className="meta inline-flex cursor-pointer list-none items-center gap-2 rounded-xs text-muted transition-colors duration-fast ease-instrument hover:text-fg [&::-webkit-details-marker]:hidden">
        <span aria-hidden className="font-mono text-faint group-open:rotate-90">
          ›
        </span>
        <span>{label}</span>
        {parts.length > 0 ? <span className="text-subtle">· {parts.join(" · ")}</span> : null}
      </summary>
      <div className="mt-3 flex flex-col gap-3 border-t border-line pt-3">
        <p className="text-sm text-muted">{evidence.rule}</p>
        {evidence.figures.length > 0 ? (
          <dl className="grid grid-cols-1 gap-x-8 sm:grid-cols-2">
            {evidence.figures.map((f) => (
              <div
                key={f.key}
                className="flex items-baseline justify-between gap-4 border-t border-line py-1.5"
              >
                <dt className="min-w-0 text-sm text-muted">{f.label}</dt>
                <dd className="tnum shrink-0 text-sm text-fg">{figureText(f)}</dd>
              </div>
            ))}
          </dl>
        ) : null}
        {links.length > 0 ? (
          <ul className="flex flex-wrap gap-x-4 gap-y-1">
            {links.map((l) => (
              <li key={l.href}>
                <Link
                  href={l.href}
                  className="meta rounded-xs text-fg underline decoration-line-control underline-offset-4 hover:decoration-fg"
                >
                  {l.label} →
                </Link>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </details>
  );
}

/** Märkning för uppskattningar: streckad kant (inte uppmätt), mono-etikett. */
export function EstimateTag({ children = "Uppskattning" }: { children?: string }) {
  return (
    <span className="label inline-flex h-6 shrink-0 items-center rounded-xs border border-dashed border-line-control px-1.5 text-muted">
      {children}
    </span>
  );
}

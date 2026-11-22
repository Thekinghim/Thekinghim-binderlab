import Link from "next/link";

import type { ScenarioEvidence } from "@/analytics/expansion";
import { day, periodText } from "@/analytics/todos/text";
import type { IsoDate, Period } from "@/domain";
import { cn } from "@/lib/cn";
import { formatInt } from "@/lib/format";

import { figureText } from "../_lib/display";
import type { EvidenceLink } from "../_lib/model";
import { orderCountOf, type OrderCounted } from "../_lib/slim";

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
  /** Order-id:na kan vara utbytta mot antalet (withOrderCounts). */
  evidence: ScenarioEvidence & OrderCounted;
  links: readonly EvidenceLink[];
  label?: string;
  className?: string;
}) {
  const parts: string[] = [];
  const orders = orderCountOf(evidence);
  if (orders > 0) parts.push(`${formatInt(orders)} order`);
  if (evidence.dates.length > 0)
    parts.push(
      `${formatInt(evidence.dates.length)} ${evidence.dates.length === 1 ? "dag" : "dagar"}`,
    );
  return (
    <details className={cn("group min-w-0", className)}>
      <summary className="meta inline-flex cursor-pointer list-none items-center gap-2 rounded-v2-sm text-v2-mute transition-colors duration-fast ease-instrument hover:text-v2-ink [&::-webkit-details-marker]:hidden">
        <span aria-hidden className="text-v2-faint group-open:rotate-90">
          ›
        </span>
        <span>{label}</span>
        {parts.length > 0 ? <span className="text-v2-mute">· {parts.join(" · ")}</span> : null}
      </summary>
      <div className="mt-3 flex flex-col gap-3 border-t border-v2-line pt-3">
        <p className="text-v2-sm text-v2-mute">{evidence.rule}</p>
        {evidence.figures.length > 0 ? (
          <dl className="grid grid-cols-1 gap-x-8 sm:grid-cols-2">
            {evidence.figures.map((f) => (
              <div
                key={f.key}
                className="flex items-baseline justify-between gap-4 border-t border-v2-line py-1.5"
              >
                <dt className="min-w-0 text-v2-sm text-v2-mute">{f.label}</dt>
                <dd className="tnum shrink-0 text-v2-sm text-v2-ink">{figureText(f)}</dd>
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
                  className="meta rounded-v2-sm text-v2-ink underline decoration-line-control underline-offset-4 hover:decoration-fg max-md:tap"
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
    <span className="label inline-flex h-6 shrink-0 items-center rounded-v2-sm border border-dashed border-v2-line3 px-1.5 text-v2-mute">
      {children}
    </span>
  );
}

/**
 * Mono-rad när skalets period börjar före första ordern: siffrorna räknas då från första
 * ordern, så att dagar utan data inte räknas som dagar utan försäljning.
 */
export function DataStartNote({
  clippedFrom,
  requested,
}: {
  clippedFrom: IsoDate | null;
  requested?: Period;
}) {
  if (!clippedFrom) return null;
  return (
    <p className="text-v2-sm break-words text-v2-mute">
      Räknat från första ordern {day(clippedFrom)}
      {requested ? `; perioden ${periodText(requested)} börjar före den` : ""}. Dagar utan data
      räknas inte som dagar utan försäljning.
    </p>
  );
}

import Link from "next/link";

import type { FinanceEvidence } from "@/analytics/reconciliation";
import { formatInt, formatPercent } from "@/lib/format";

import { kr, periodText, plural } from "../_lib/view";

function figureText(f: FinanceEvidence["figures"][number]): string {
  switch (f.unit) {
    case "ore":
      return kr(f.value);
    case "bp":
      return formatPercent(f.value / 10_000);
    case "days":
      return plural(f.value, "dag", "dagar");
    case "tenths":
      return formatInt(f.value / 10);
    default:
      return formatInt(f.value);
  }
}

/** Länk till orderlistan för underlagets period (och ordern när den är en enda). */
export function ordersHref(evidence: FinanceEvidence): string | null {
  const p = evidence.period;
  if (!p) return null;
  const q = new URLSearchParams({ period: "eget", from: p.start, to: p.end });
  if (evidence.orderIds.length === 1) q.set("order", evidence.orderIds[0]!);
  return `/order?${q.toString()}`;
}

/**
 * Underlaget bakom en siffra: regeln i klartext, perioden, talen och länkar till orderna.
 * Fälls ut på begäran (details), så att listan står kort.
 */
export function EvidenceDetails({
  evidence,
  label = "Underlag",
}: {
  evidence: FinanceEvidence;
  label?: string;
}) {
  const href = ordersHref(evidence);
  return (
    <details className="group text-sm">
      <summary className="inline-flex cursor-pointer list-none items-center gap-1 rounded-xs font-mono text-xs text-muted transition-colors hover:text-fg [&::-webkit-details-marker]:hidden">
        <span aria-hidden className="text-faint group-open:rotate-90">
          ›
        </span>
        {label}
      </summary>
      <div className="mt-2 flex flex-col gap-2 border-t border-line pt-2">
        <p className="text-muted">{evidence.rule}</p>
        {evidence.figures.length > 0 ? (
          <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1">
            {evidence.figures.map((f) => (
              <div key={f.key} className="contents">
                <dt className="text-subtle">{f.label}</dt>
                <dd className="tnum text-right text-fg">{figureText(f)}</dd>
              </div>
            ))}
          </dl>
        ) : null}
        <p className="meta text-subtle">
          {evidence.period ? periodText(evidence.period) : null}
          {evidence.orderIds.length > 0
            ? ` · ${plural(evidence.orderIds.length, "order", "order")}`
            : ""}
          {evidence.payoutReferences.length > 0
            ? ` · utbetalning ${evidence.payoutReferences.join(", ")}`
            : ""}
        </p>
        {href ? (
          <Link
            href={href}
            className="w-fit rounded-xs text-sm text-fg underline-offset-4 hover:underline max-md:tap"
          >
            {evidence.orderIds.length === 1 ? "Visa ordern" : "Visa orderna i perioden"} →
          </Link>
        ) : null}
      </div>
    </details>
  );
}

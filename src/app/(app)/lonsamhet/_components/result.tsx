import Link from "next/link";

import { PanelSection } from "@/components/ui/frame";
import { formatInt, formatPercent, formatSek, MINUS, NBSP } from "@/lib/format";

import type { ResultAfterProfit } from "../_lib/result";

const kr = (ore: number) => formatSek(ore / 100);
/** Ett avdrag: "−1 200 kr" (0 kr utan minus). */
const minus = (ore: number) => (ore > 0 ? `${MINUS}${kr(ore)}` : kr(0));

const LINK =
  "meta inline-flex min-h-7 items-center gap-1.5 rounded-xs text-muted underline-offset-4 transition-colors hover:text-fg hover:underline";

function Line({
  label,
  value,
  detail,
  total,
}: {
  label: string;
  value: string;
  detail?: string;
  total?: boolean;
}) {
  return (
    <div
      className={
        total
          ? "flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-t border-line-strong py-2.5"
          : "flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-t border-line py-2.5 first:border-t-0 first:pt-0"
      }
    >
      <dt className="flex min-w-0 flex-col">
        <span className={total ? "font-medium text-fg" : "text-muted"}>{label}</span>
        {detail ? <span className="meta text-subtle">{detail}</span> : null}
      </dt>
      <dd className={total ? "tnum font-medium text-fg" : "tnum text-fg"}>{value}</dd>
    </div>
  );
}

/**
 * Efter vinsten: återbetalningar och fasta kostnader som egna rader under vattenfallet.
 * Vinsten är densamma som vattenfallets; inget ovanför ändras.
 */
export function ResultAfterProfitPanel({ result }: { result: ResultAfterProfit }) {
  const r = result;
  const margin =
    r.resultMarginBp === null
      ? undefined
      : `${formatPercent(r.resultMarginBp / 10_000)} av intäkten med inköpspris`;
  return (
    <PanelSection label="Efter vinsten" meta="Återbetalningar och fasta kostnader">
      <dl className="flex flex-col">
        <Line label="Vinst" value={kr(r.profitOre)} detail="Samma som vattenfallet ovan." />
        <Line
          label="Återbetalningar till kunder"
          value={minus(r.refundOre)}
          detail={
            r.refundCount > 0
              ? `${formatInt(r.refundCount)}${NBSP}${r.refundCount === 1 ? "ärende" : "ärenden"}, räknade på återbetalningsdagen.`
              : "Inga återbetalningar i perioden."
          }
        />
        <Line label="Vinst efter återbetalningar" value={kr(r.profitAfterRefundsOre)} total />
        {r.fixedCostOre === null ? (
          <Line label="Fasta kostnader" value="–" detail={r.fixedNote ?? undefined} />
        ) : (
          <Line
            label="Fasta kostnader"
            value={minus(r.fixedCostOre)}
            detail={
              r.fixedCostOre > 0
                ? `Gemensamma ${kr(r.sharedFixedOre ?? 0)} fördelade efter nettointäkt, direkt på automat ${kr(r.directFixedOre ?? 0)}.`
                : "Inga fasta kostnader i perioden."
            }
          />
        )}
        <Line
          label={
            r.fixedCostOre === null
              ? "Resultat efter återbetalningar"
              : "Resultat efter fasta kostnader"
          }
          value={kr(r.resultOre)}
          detail={margin}
          total
        />
      </dl>
      <p className="flex flex-wrap gap-x-6 gap-y-1">
        <Link href="/inkorg" className={LINK}>
          <span>Kundärenden</span>
          <span aria-hidden className="text-subtle">
            →
          </span>
        </Link>
        <Link href="/ekonomi#fasta-kostnader" className={LINK}>
          <span>Fasta kostnader i Ekonomi</span>
          <span aria-hidden className="text-subtle">
            →
          </span>
        </Link>
      </p>
    </PanelSection>
  );
}

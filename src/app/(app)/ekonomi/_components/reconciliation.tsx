import type {
  Deviation,
  PayoutReconciliation,
  PayoutStatus,
  ReconciliationResult,
} from "@/analytics/reconciliation";
import { StateMessage } from "@/components/ui/state-message";
import { StatusTag, type Status } from "@/components/ui/status-tag";
import { formatDate, formatInt } from "@/lib/format";

import { isoToDate, kr, periodText, signedKr } from "../_lib/view";
import { DeviationReview } from "./deviation-review";
import { PayoutArchive } from "./payout-archive";
import { EvidenceDetails } from "./evidence";

const STATUS: Record<PayoutStatus, { status: Status; label: string }> = {
  matched: { status: "ok", label: "Stämmer" },
  explained: { status: "neutral", label: "Förklarad" },
  deviation: { status: "warning", label: "Avvikelse" },
  investigated: { status: "neutral", label: "Utredd" },
};

const CONFIDENCE: Record<Deviation["confidence"], string> = {
  confirmed: "Belagd order för order",
  inferred: "Härledd ur beloppen",
};

function DeviationItem({
  d,
  period,
  canEdit,
}: {
  d: Deviation;
  period: { start: string; end: string };
  canEdit: boolean;
}) {
  const investigated = d.status === "investigated";
  return (
    <li className="flex flex-col gap-2 border-t border-line py-4 first:border-t-0 first:pt-0">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <p className="text-base text-fg">{d.title}</p>
        <p className="tnum text-base text-fg">{signedKr(d.impactOre)}</p>
      </div>
      <p className="text-sm text-muted">{d.explanation}</p>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <StatusTag status={!d.requiresAction ? "neutral" : investigated ? "ok" : "warning"}>
          {!d.requiresAction ? "Jämnas ut" : investigated ? "Utredd" : "Att utreda"}
        </StatusTag>
        <span className="meta text-subtle">{CONFIDENCE[d.confidence]}</span>
        {canEdit && d.requiresAction ? (
          <DeviationReview
            deviationKey={d.key}
            title={d.title}
            period={period}
            investigated={investigated}
          />
        ) : null}
      </div>
      {d.resolution ? (
        <p className="text-sm text-muted">
          <span className="meta text-subtle">
            {d.resolution.resolvedBy ?? "Okänd"}
            {d.resolution.resolvedAt
              ? ` · ${formatDate(new Date(d.resolution.resolvedAt), { year: "auto" })}`
              : ""}
            {": "}
          </span>
          {d.resolution.note}
        </p>
      ) : null}
      <EvidenceDetails evidence={d.evidence} />
    </li>
  );
}

function PayoutBlock({
  p,
  today,
  canEdit,
  viewPeriod,
  payoutId,
}: {
  p: PayoutReconciliation;
  today: string;
  canEdit: boolean;
  viewPeriod: { start: string; end: string };
  payoutId: string | undefined;
}) {
  const s = STATUS[p.status];
  return (
    <article
      aria-labelledby={`utbetalning-${p.key}`}
      className="flex flex-col gap-4 border-t border-line py-6 first:border-t-0 first:pt-0"
    >
      <header className="grid grid-cols-1 gap-3 md:grid-cols-12 md:items-baseline">
        <div className="flex flex-col gap-1 md:col-span-5">
          <h3
            id={`utbetalning-${p.key}`}
            className="flex flex-wrap items-baseline gap-x-3 text-md text-fg"
          >
            <span className="font-mono text-sm">{p.reference}</span>
            <span>{periodText(p.period)}</span>
          </h3>
          <p className="meta text-subtle">
            {p.paidOn > today ? "Utbetalas" : "Utbetald"}{" "}
            {formatDate(isoToDate(p.paidOn), { year: "always" })} · {formatInt(p.expected.orders)} order
          </p>
        </div>
        <dl className="grid grid-cols-3 gap-4 md:col-span-5">
          <div className="flex flex-col gap-1">
            <dt className="label text-subtle">Väntat</dt>
            <dd className="tnum text-base text-fg">{kr(p.expected.payoutOre)}</dd>
          </div>
          <div className="flex flex-col gap-1">
            <dt className="label text-subtle">Utbetalt</dt>
            <dd className="tnum text-base text-fg">{kr(p.actual.payoutOre)}</dd>
          </div>
          <div className="flex flex-col gap-1">
            <dt className="label text-subtle">Skillnad</dt>
            <dd className="tnum text-base text-fg">{signedKr(p.differenceOre)}</dd>
          </div>
        </dl>
        <div className="flex flex-wrap items-center gap-2 md:col-span-2 md:flex-col md:items-end md:justify-self-end">
          <StatusTag status={s.status}>{s.label}</StatusTag>
          {canEdit && payoutId ? <PayoutArchive id={payoutId} reference={p.reference} /> : null}
        </div>
      </header>
      <p className="text-sm text-muted">{p.summary}</p>
      {p.deviations.length > 0 ? (
        <ul className="flex flex-col pl-0 md:pl-4">
          {p.deviations.map((d) => (
            <DeviationItem key={d.key} d={d} period={viewPeriod} canEdit={canEdit} />
          ))}
        </ul>
      ) : null}
      <EvidenceDetails evidence={p.evidence} label="Underlag för utbetalningen" />
    </article>
  );
}

/** Varje utbetalning med väntat, utbetalt, skillnad, avvikelser och underlag. */
export function ReconciliationList({
  result,
  today,
  canEdit,
  period,
  payoutIds,
}: {
  result: ReconciliationResult;
  /** I dag ('ÅÅÅÅ-MM-DD'): en utbetalningsdag efter i dag skrivs "Utbetalas". */
  today: string;
  canEdit: boolean;
  period: { start: string; end: string };
  /** Utbetalningens id per referens (för arkiveringen). */
  payoutIds: Readonly<Record<string, string>>;
}) {
  return (
    <div className="flex flex-col">
      {result.payouts.map((p) => (
        <PayoutBlock
          key={p.key}
          p={p}
          today={today}
          canEdit={canEdit}
          viewPeriod={period}
          payoutId={p.key === p.reference ? payoutIds[p.reference] : undefined}
        />
      ))}
      {result.uncovered.length > 0 ? (
        <section
          aria-labelledby="utan-utbetalning"
          className="flex flex-col gap-3 border-t border-line py-6"
        >
          <h3 id="utan-utbetalning" className="text-md text-fg">
            Försäljning som ingen utbetalning täcker.
          </h3>
          <ul className="flex flex-col">
            {result.uncovered.map((d) => (
              <DeviationItem key={d.key} d={d} period={period} canEdit={canEdit} />
            ))}
          </ul>
        </section>
      ) : null}
      {result.staleResolutions.length > 0 ? (
        <StateMessage
          compact
          kind="no-results"
          code={`${result.staleResolutions.length} ändrade`}
          message="Avvikelser som utretts har ändrats sedan dess och visas som öppna igen."
          detail={result.staleResolutions.map((r) => r.note).join(" · ")}
        />
      ) : null}
    </div>
  );
}

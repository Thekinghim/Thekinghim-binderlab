import Link from "next/link";
import type { ReactNode } from "react";

import type { ScenarioFigure } from "@/analytics/expansion/common";
import type { IsoDate, Period } from "@/domain";
import { formatInt, NBSP } from "@/lib/format";
import { dayText, figureText, kronor, orderLinks, periodLabel } from "@/server/market/display";

/** Underlaget som analysen lämnar (MarketEvidence eller ScenarioEvidence). */
export interface EvidenceLike {
  readonly rule: string;
  readonly period: Period | null;
  readonly orderIds: readonly string[];
  readonly dates: readonly IsoDate[];
  readonly titleIds: readonly string[];
  readonly machineIds: readonly string[];
  readonly figures: readonly ScenarioFigure[];
  readonly purchaseIds?: readonly string[];
}

/** Namn och inköp som underlaget hänvisar till. */
export interface EvidenceNames {
  readonly today: IsoDate;
  readonly title: Readonly<Record<string, string>>;
  readonly machine: Readonly<Record<string, string>>;
  readonly supplier: Readonly<Record<string, string>>;
  readonly purchases: Readonly<
    Record<
      string,
      {
        readonly origin: "quote" | "purchase-order";
        readonly supplierId: string;
        readonly date: IsoDate;
        readonly unitCostOre: number;
        readonly quantity: number;
      }
    >
  >;
}

function names(ids: readonly string[], lookup: Readonly<Record<string, string>>): string {
  const list = ids.map((id) => lookup[id] ?? id);
  return list.length > 6
    ? `${list.slice(0, 6).join(", ")} och ${list.length - 6} till`
    : list.join(", ");
}

/**
 * "Underlag": regeln i klartext, talen beräkningen bygger på, perioden, vilka titlar,
 * automater och inköp som ingår och en länk till orderna. Utfällbar, så att varje
 * rekommendation och siffra kan granskas där den står.
 */
export function Evidence({
  evidence,
  names: n,
  label = "Underlag",
  extra,
}: {
  evidence: EvidenceLike;
  names: EvidenceNames;
  label?: string;
  extra?: ReactNode;
}) {
  const links = orderLinks(evidence, (id) => n.title[id] ?? id);
  const purchases = (evidence.purchaseIds ?? []).flatMap((id) => {
    const p = n.purchases[id];
    return p ? [{ id, ...p }] : [];
  });
  return (
    <details className="group min-w-0 text-sm">
      <summary className="label inline-flex cursor-pointer list-none items-center gap-2 rounded-xs text-subtle hover:text-fg [&::-webkit-details-marker]:hidden">
        <span
          aria-hidden
          className="text-faint transition-transform duration-fast group-open:rotate-90"
        >
          ›
        </span>
        {label}
      </summary>
      <div className="mt-3 flex min-w-0 flex-col gap-3 border-t border-line pt-3">
        <p className="text-muted">{evidence.rule}</p>
        {evidence.figures.length > 0 ? (
          <dl className="grid grid-cols-1 gap-x-8 gap-y-1 sm:grid-cols-2">
            {evidence.figures.map((f) => (
              <div key={f.key} className="flex min-w-0 items-baseline justify-between gap-4">
                <dt className="truncate text-subtle">{f.label}</dt>
                <dd className="tnum shrink-0 text-fg">{figureText(f)}</dd>
              </div>
            ))}
          </dl>
        ) : null}
        <dl className="meta flex flex-col gap-1 text-subtle">
          {evidence.period ? (
            <div>
              <dt className="inline">Period: </dt>
              <dd className="inline text-muted">{periodLabel(evidence.period)}</dd>
            </div>
          ) : null}
          {evidence.titleIds.length > 0 ? (
            <div>
              <dt className="inline">Titlar: </dt>
              <dd className="inline text-muted">{names(evidence.titleIds, n.title)}</dd>
            </div>
          ) : null}
          {evidence.machineIds.length > 0 ? (
            <div>
              <dt className="inline">Automater: </dt>
              <dd className="inline text-muted">{names(evidence.machineIds, n.machine)}</dd>
            </div>
          ) : null}
        </dl>
        {purchases.length > 0 ? (
          <ul className="flex flex-col gap-1" aria-label="Inköp i underlaget">
            {purchases.slice(0, 12).map((p) => (
              <li key={p.id} className="flex flex-wrap items-baseline justify-between gap-x-4">
                <span className="text-muted">
                  {dayText(p.date, n.today)} · {n.supplier[p.supplierId] ?? "Okänd leverantör"} ·{" "}
                  {p.origin === "quote" ? "registrerat pris" : "inköpsorder"}
                </span>
                <span className="tnum text-fg">
                  {kronor(p.unitCostOre)} × {formatInt(p.quantity)}
                </span>
              </li>
            ))}
            {purchases.length > 12 ? (
              <li className="text-subtle">och {formatInt(purchases.length - 12)} till</li>
            ) : null}
          </ul>
        ) : null}
        {extra}
        {links.length === 1 ? (
          <Link
            href={links[0]!.href}
            className="self-start rounded-xs text-muted underline decoration-line-strong underline-offset-4 hover:text-fg"
          >
            {links[0]!.label}
          </Link>
        ) : links.length > 1 ? (
          <div className="flex flex-col gap-1">
            <p className="text-sm text-subtle">
              {formatInt(evidence.orderIds.length)}
              {NBSP}order i underlaget, per titel (orderlistan visar titelns alla order i perioden):
            </p>
            <ul className="flex flex-wrap gap-x-4 gap-y-1">
              {links.map((l) => (
                <li key={l.href}>
                  <Link
                    href={l.href}
                    className="rounded-xs text-muted underline decoration-line-strong underline-offset-4 hover:text-fg"
                  >
                    {l.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </details>
  );
}

import Link from "next/link";

import { formatInt, formatPercent, formatSek, NBSP } from "@/lib/format";

import type { Bridge, UnpricedBlock } from "../_lib/model";

const kr = (ore: number) => formatSek(ore / 100);

function Row({ label, value, sub }: { label: string; value: string; sub?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-t border-line py-2 first:border-t-0 first:pt-0">
      <dt className={sub ? "pl-4 text-sm text-subtle" : "text-muted"}>{label}</dt>
      <dd className={sub ? "tnum text-sm text-subtle" : "tnum text-fg"}>{value}</dd>
    </div>
  );
}

/** Butiksersättningen uppdelad i provision och hyra. */
export function CompensationBreakdown({ bridge }: { bridge: Bridge }) {
  return (
    <details className="group border-t border-line pt-4">
      <summary className={SUMMARY}>
        <span className="label text-muted">Butiksersättning</span>
        <span className="label tnum text-subtle">{kr(bridge.compensationOre)}</span>
      </summary>
      <dl className="fade-in mt-3 flex flex-col">
        <Row label="Provision" value={kr(bridge.commissionOre)} />
        <Row label="Hyra" value={kr(bridge.rentOre)} />
        {bridge.unallocatedRentOre > 0 ? (
          <Row label="varav hyra utan prissatta order" value={kr(bridge.unallocatedRentOre)} sub />
        ) : null}
      </dl>
    </details>
  );
}

const SUMMARY =
  "flex min-h-9 cursor-pointer list-none items-center justify-between gap-3 rounded-xs transition-colors hover:text-fg [&::-webkit-details-marker]:hidden";

/**
 * Hur stor del av intäkten som saknar inköpspris, per titel med länk till priset.
 * Den enda signalmarkeringen i sektionen: order utan pris gör vinsten ofullständig.
 */
export function UnpricedSummary({ unpriced }: { unpriced: UnpricedBlock }) {
  if (unpriced.orders === 0) return null;

  const share = formatPercent(unpriced.shareBp / 10_000);
  return (
    <details className="group border-t border-line pt-4">
      <summary className={SUMMARY}>
        <span className="label flex items-center gap-2 text-muted">
          <span aria-hidden className="size-2 shrink-0 bg-signal" />
          <span className="sr-only">Kräver åtgärd: </span>
          Utan inköpspris · {share}
        </span>
        <span className="label tnum text-subtle">{formatInt(unpriced.titles.length)} st</span>
      </summary>
      <div className="fade-in mt-3 flex flex-col gap-2">
        <p className="text-sm text-muted">
          {kr(unpriced.revenueOre)} från {formatInt(unpriced.orders)}
          {NBSP}order räknas inte i vinsten.
        </p>
      </div>
      <ul className="flex flex-col">
        {unpriced.titles.map((t) => (
          <li
            key={t.titleId}
            className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-t border-line py-2.5"
          >
            <span className="flex min-w-0 flex-col">
              <span className="text-fg">{t.name}</span>
              <span className="meta tnum text-subtle">
                {formatInt(t.orders)}
                {NBSP}order · {kr(t.revenueOre)} · {formatPercent(t.shareBp / 10_000)}
              </span>
            </span>
            <Link
              href={t.href}
              className="rounded-xs text-sm whitespace-nowrap text-fg underline decoration-line-strong underline-offset-4 transition-colors hover:decoration-fg"
            >
              Lägg in pris<span className="sr-only"> för {t.name}</span>
              <span aria-hidden>{`${NBSP}→`}</span>
            </Link>
          </li>
        ))}
      </ul>
    </details>
  );
}

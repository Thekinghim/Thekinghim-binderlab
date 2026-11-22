import Link from "next/link";

import { ALL_COST_LINES, type CostLines } from "@/lib/cost-lines";
import { formatInt, formatPercent, formatSek, NBSP } from "@/lib/format";

import type { Bridge, UnpricedBlock } from "../_lib/model";

const kr = (ore: number) => formatSek(ore / 100);

function Row({ label, value, sub }: { label: string; value: string; sub?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-t border-v2-line2 py-2 text-v2-md first:border-t-0 first:pt-0">
      <dt className={sub ? "pl-4 text-v2-sm text-v2-mute" : "text-v2-mute"}>{label}</dt>
      <dd className={sub ? "tnum text-v2-sm text-v2-mute" : "tnum text-v2-ink"}>{value}</dd>
    </div>
  );
}

/**
 * Rubriken för uppdelningen: samma ord som nyckeltalet ("Butikernas andel", med en butik
 * eller automat "Butikens andel"), inte det äldre "Butiksersättning".
 */
export function compensationBreakdownLabel(bridge: Pick<Bridge, "storeShareLabel">): string {
  return bridge.storeShareLabel === "Butikernas andel" ? "Butikernas andel" : "Butikens andel";
}

/** Butikernas andel uppdelad i provision och hyra (hyran bara när något avtal har hyra). */
export function CompensationBreakdown({
  bridge,
  costLines = ALL_COST_LINES,
}: {
  bridge: Bridge;
  costLines?: CostLines;
}) {
  const showRent = costLines.rent || bridge.rentOre !== 0;
  return (
    <details className="group border-t border-v2-line2 pt-3">
      <summary className={SUMMARY}>
        <span className="text-v2-md font-[550] text-v2-ink">
          {compensationBreakdownLabel(bridge)}
        </span>
        <span className="tnum text-v2-md text-v2-ink">{kr(bridge.compensationOre)}</span>
      </summary>
      <dl className="mt-3 flex flex-col">
        <Row label="Provision" value={kr(bridge.commissionOre)} />
        {showRent ? <Row label="Hyra" value={kr(bridge.rentOre)} /> : null}
        {showRent && bridge.unallocatedRentOre > 0 ? (
          <Row label="varav hyra utan prissatta order" value={kr(bridge.unallocatedRentOre)} sub />
        ) : null}
      </dl>
    </details>
  );
}

const SUMMARY =
  "flex min-h-9 cursor-pointer list-none max-md:min-h-11 items-center justify-between gap-3 rounded-v2-sm [&::-webkit-details-marker]:hidden";

/**
 * Hur stor del av intäkten som saknar inköpspris, per titel med länk till priset.
 * Den enda signalmarkeringen i sektionen: order utan pris gör vinsten ofullständig.
 */
export function UnpricedSummary({ unpriced }: { unpriced: UnpricedBlock }) {
  if (unpriced.orders === 0) return null;

  const share = formatPercent(unpriced.shareBp / 10_000);
  return (
    <details className="group border-t border-v2-line2 pt-3">
      <summary className={SUMMARY}>
        <span className="flex items-center gap-2 text-v2-md font-[550] text-v2-ink">
          <span aria-hidden className="size-2 shrink-0 rounded-full bg-v2-crit" />
          <span className="sr-only">Kräver åtgärd: </span>
          Saknar inköpspris · {share} av intäkten
        </span>
        <span className="tnum text-v2-sm text-v2-mute">{formatInt(unpriced.titles.length)} st</span>
      </summary>
      <div className="mt-3 flex flex-col gap-2">
        <p className="text-v2-sm text-v2-mute">
          {kr(unpriced.revenueOre)} · {formatInt(unpriced.orders)}
          {NBSP}order ingår inte i vinsten.
        </p>
      </div>
      <ul className="flex flex-col">
        {unpriced.titles.map((t) => (
          <li
            key={t.titleId}
            className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-t border-v2-line2 py-2.5 text-v2-md"
          >
            <span className="flex min-w-0 flex-col">
              <span className="text-v2-ink">{t.name}</span>
              <span className="tnum text-v2-xs text-v2-mute">
                {formatInt(t.orders)}
                {NBSP}order · {kr(t.revenueOre)} · {formatPercent(t.shareBp / 10_000)}
              </span>
            </span>
            <Link
              href={t.href}
              className="text-v2-sm font-[550] whitespace-nowrap text-v2-ink hover:underline max-md:inline-flex max-md:min-h-11 max-md:items-center"
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

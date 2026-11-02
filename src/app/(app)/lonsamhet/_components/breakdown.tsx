import Link from "next/link";

import { PanelSection } from "@/components/ui/frame";
import { StatusTag } from "@/components/ui/status-tag";
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
    <PanelSection label="Butiksersättning" meta={kr(bridge.compensationOre)}>
      <dl className="flex flex-col">
        <Row label="Provision" value={kr(bridge.commissionOre)} />
        <Row label="Hyra" value={kr(bridge.rentOre)} />
        {bridge.unallocatedRentOre > 0 ? (
          <Row
            label="varav hyra som ingen order med inköpspris bär"
            value={kr(bridge.unallocatedRentOre)}
            sub
          />
        ) : null}
      </dl>
    </PanelSection>
  );
}

/**
 * Hur stor del av intäkten som saknar inköpspris, per titel med länk till priset.
 * Den enda signalmarkeringen i sektionen: order utan pris gör vinsten ofullständig.
 */
export function UnpricedSummary({ unpriced }: { unpriced: UnpricedBlock }) {
  if (unpriced.orders === 0) {
    return (
      <PanelSection label="Inköpspriser">
        <p className="flex flex-wrap items-center gap-3 text-muted">
          <StatusTag status="ok">Komplett</StatusTag>
          <span>Alla order i perioden har inköpspris.</span>
        </p>
      </PanelSection>
    );
  }

  const share = formatPercent(unpriced.shareBp / 10_000);
  return (
    <PanelSection label="Utan inköpspris" meta={`${formatInt(unpriced.titles.length)} st`}>
      <div className="flex flex-col gap-2">
        <p className="flex items-baseline gap-2 text-xl font-medium md:text-2xl">
          <span aria-hidden className="size-2 shrink-0 translate-y-[-0.2em] bg-signal" />
          <span className="sr-only">Kräver åtgärd: </span>
          <span className="tnum text-fg">{share}</span>
          <span className="text-base font-normal text-muted">av intäkten saknar inköpspris.</span>
        </p>
        <p className="text-sm text-muted">
          {kr(unpriced.revenueOre)} från {formatInt(unpriced.orders)}
          {NBSP}order räknas inte in i vinsten förrän priset finns.
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
    </PanelSection>
  );
}

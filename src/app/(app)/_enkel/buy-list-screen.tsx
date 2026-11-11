import Link from "next/link";
import type { CSSProperties } from "react";

import { Icon } from "@/components/ui/icon";
import { StateMessage } from "@/components/ui/state-message";
import { PRICES_HREF } from "@/components/shell/simple-view";
import { formatters, messages } from "@/i18n";
import type { AppContext } from "@/server/data/core";

import { currentViewer } from "../lager/_lib/session";
import { PageHead } from "../vart-lager/_components/page-head";
import { loadVartLagerFor } from "../vart-lager/_lib/data";
import { packActionHref } from "../vart-lager/mystery/_lib/model";
import { BuyButtons, OnTheWayList } from "../prognos/_components/buy-actions";
import { buyList } from "./model";
import { StockTabs } from "./stock-tabs";

/**
 * Inköpslistan i den enkla vyn (/prognos): vad som ska köpas in och hur mycket, samma
 * titlar och antal som Inköp i hela appen. Egna produkter (mystery packs) packas och leder
 * till Mystery. Med inköpspris visas ungefär vad det kostar. Inga leverantörer, ingen
 * prognos, inga inköpsorder: det sköter ägaren.
 */
export async function SimpleBuyListScreen({ ctx }: { ctx: AppContext }) {
  const t = messages(ctx.locale);
  const f = formatters(ctx.locale);
  const r2 = t.r2.t3;
  const viewer = await currentViewer();
  const view = await loadVartLagerFor(viewer, new Date(ctx.now));
  const places = view.places.map((p) => ({ id: p.id, name: p.name }));
  const scope = `${viewer.organization.id}:${viewer.user.userId}`;
  const list = buyList(view.rows);
  const toBuy = list.items.length;
  const aside =
    toBuy === 0
      ? undefined
      : list.noPlan
        ? t.stock.buyNoPlan
        : list.totalOre > 0
          ? `${t.stock.buyAside} ${t.stock.totalAbout(f.sek(list.totalOre / 100))}`
          : t.stock.buyAside;

  return (
    <div className="mx-auto flex w-full max-w-[720px] flex-col gap-6 px-4 pt-4 pb-8 md:px-8 md:pt-10">
      <StockTabs active="buy" t={t} />
      <PageHead eyebrow={t.stock.buyTitle} title={t.stock.buyHeadline(toBuy)} aside={aside} />
      {view.hasWarehouse ? (
        <OnTheWayList
          items={view.onTheWay}
          today={view.today}
          canEdit={view.canEdit}
          places={places}
          scope={scope}
        />
      ) : null}
      {!view.hasWarehouse ? (
        <StateMessage kind="empty" message={t.stock.noWarehouse} />
      ) : toBuy === 0 ? null : (
        <ul aria-label={t.stock.buyTitle} className="flex flex-col gap-3">
          {list.items.map((item, i) => {
            // Mystery packs alltid i hela omgångar, samma tal som Inköp och Vårt lager.
            const what = item.own
              ? item.batches !== null
                ? r2.packBatches(item.batches)
                : item.qty !== null
                  ? t.stock.packOwn(item.qty)
                  : t.stock.packMore
              : item.qty !== null
                ? t.stock.buy(item.qty)
                : t.stock.buyMore;
            // Under 0 hemma: räkna om först (samma två steg som i hela appen).
            const action = item.countFirst ? r2.countFirst(what) : what;
            return (
              <li
                key={item.titleId}
                className="rise flex flex-col gap-2 rounded-md border border-line-strong bg-surface p-4"
                style={{ "--i": Math.min(i + 1, 8) } as CSSProperties}
              >
                <span className="flex items-baseline justify-between gap-3">
                  <span className="min-w-0 text-lg font-medium [overflow-wrap:anywhere] text-fg">
                    {item.name}
                  </span>
                  {item.out ? (
                    <span className="inline-flex shrink-0 items-center gap-1 text-sm font-medium text-signal-fg">
                      <Icon name="alert" size={14} />
                      {t.stock.out}
                    </span>
                  ) : null}
                </span>
                <span className="text-2xl font-medium text-fg">{action}</span>
                {/* En del i mystery packs: så många av packen går dit. */}
                {item.toMystery ? (
                  <span className="tnum text-base text-fg">
                    {item.toMystery.all
                      ? r2.toMysteryAll(item.toMystery.into ?? r2.mysteryPacks)
                      : r2.toMystery(item.toMystery.packs, item.toMystery.into ?? r2.mysteryPacks)}
                  </span>
                ) : null}
                <span className="tnum text-sm text-muted">
                  {t.stock.haveLine(item.home, item.inMachines)}
                </span>
                {item.countFirst ? (
                  <span className="text-base text-signal-fg">{r2.countFirstHint}</span>
                ) : null}
                {item.own ? (
                  <Link
                    href={packActionHref(item.titleId, item.qty, item.packPlaceId)}
                    className="flex min-h-12 items-center justify-center gap-2 rounded-md border border-inverse bg-inverse px-4 text-lg font-medium text-on-inverse active:bg-inverse-hover"
                  >
                    <Icon name="plus" size={18} />
                    {t.mystery.pack}
                  </Link>
                ) : item.costOre !== null ? (
                  <span className="tnum text-base text-fg">
                    {t.stock.costAbout(f.sek(item.costOre / 100))}
                    {item.unitCostOre !== null
                      ? ` · ${t.stock.perPack(f.kronor(item.unitCostOre / 100))}`
                      : ""}
                  </span>
                ) : item.unitCostOre === null ? (
                  <Link
                    href={PRICES_HREF}
                    className="inline-flex min-h-11 w-fit items-center gap-1 text-base text-signal-fg underline"
                  >
                    {t.stock.noPrice}
                  </Link>
                ) : null}
                {/* Beställt eller redan köpt: ett tryck, utan leverantörsregister. */}
                {!item.own && view.canEdit ? (
                  <BuyButtons
                    target={{
                      titleId: item.titleId,
                      name: item.name,
                      qty: item.qty,
                      unitCostOre: item.unitCostOre,
                    }}
                    places={places}
                    scope={scope}
                  />
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

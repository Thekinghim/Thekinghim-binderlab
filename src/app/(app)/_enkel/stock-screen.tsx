import Link from "next/link";

import { COUNT_HREF } from "@/components/shell/simple-view";
import { Icon } from "@/components/ui/icon";
import { StateMessage } from "@/components/ui/state-message";
import { messages } from "@/i18n";
import type { AppContext } from "@/server/data/core";

import { currentViewer } from "../lager/_lib/session";
import { PageHead } from "../vart-lager/_components/page-head";
import { loadVartLagerFor } from "../vart-lager/_lib/data";
import { stockBadge, stockRows } from "./model";
import { StockList, type StockListRow } from "./stock-list";
import { StockTabs } from "./stock-tabs";

/**
 * Lager i den enkla vyn (/vart-lager): hur många pack vi har i lagren (Hemma, Kontoret …)
 * och i automaterna. "Ändra" på en rad: en leverans kom in (lägger till pack) eller rätta
 * antalet (räkning). Samma server actions och regler som Vårt lager (ägare och admin
 * skriver; läsaren ser bara). Inga belopp, inga flyttar, inga lagerinställningar.
 * "Inventera" (Count stock) öppnar inventeringen av ett helt lager (/vart-lager/inventering).
 */
export async function SimpleStockScreen({ ctx }: { ctx: AppContext }) {
  const t = messages(ctx.locale);
  const view = await loadVartLagerFor(await currentViewer(), new Date(ctx.now));
  const rows: StockListRow[] = stockRows(view.rows).map((r) => ({
    titleId: r.titleId,
    name: r.name,
    home: r.home,
    byPlace: r.byPlace,
    inMachines: r.inMachines,
    sold7: r.sold7,
    lastsDays: r.lastsDays,
    badge: stockBadge(r),
    unitCostOre: r.unitCostOre,
    own: r.own,
  }));
  const places = view.places.map((p) => ({ id: p.id, name: p.name }));
  const aside =
    places.length > 1
      ? [
          ...places.map((p) => t.stock.placeLine(p.name, view.totals.byPlace[p.id] ?? 0)),
          t.stock.inMachines(view.totals.inMachines),
        ].join(" · ")
      : t.stock.inMachines(view.totals.inMachines);

  return (
    <div className="mx-auto flex w-full max-w-[720px] flex-col gap-6 px-4 pt-4 pb-8 md:px-8 md:pt-10">
      <StockTabs active="stock" t={t} />
      <PageHead eyebrow={t.stock.title} title={t.stock.headline(view.totals.home)} aside={aside} />
      {!view.hasWarehouse ? (
        <StateMessage kind="empty" message={t.stock.noWarehouse} />
      ) : rows.length === 0 ? (
        <StateMessage kind="empty" message={t.stock.noTitles} />
      ) : (
        <>
          {view.canEdit ? (
            <Link
              href={COUNT_HREF}
              className="flex min-h-14 w-full items-center justify-between gap-3 rounded-md border border-line-strong bg-surface px-4 py-2 active:bg-hover"
            >
              <span className="flex min-w-0 flex-col">
                <span className="text-lg font-medium text-fg">{t.count.open}</span>
                <span className="text-sm text-muted">{t.count.openHint}</span>
              </span>
              <Icon name="chevronRight" size={20} className="shrink-0 text-muted" />
            </Link>
          ) : (
            <p className="text-base text-muted">{t.stock.readOnly}</p>
          )}
          <StockList rows={rows} places={places} canEdit={view.canEdit} />
        </>
      )}
    </div>
  );
}

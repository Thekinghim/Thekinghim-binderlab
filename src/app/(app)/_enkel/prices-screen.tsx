import { StateMessage } from "@/components/ui/state-message";
import { messages } from "@/i18n";
import { loadMasterData, type AppContext } from "@/server/data/core";
import { requireUser } from "@/server/session";

import { currentViewer } from "../lager/_lib/session";
import { PageHead } from "../vart-lager/_components/page-head";
import { CostNotice } from "../vart-lager/mystery/_components/cost-notice";
import { loadMysteryCostDriftsFor } from "../vart-lager/mystery/_lib/data";
import { loadPricePageFor } from "../inkopspriser/_lib/data";
import { priceRows } from "./model";
import { PriceList } from "./price-list";
import { StockTabs } from "./stock-tabs";

/**
 * Inköpspriserna i den enkla vyn (/inkopspriser): vad ett pack kostar att köpa in, per
 * produkt, och "Ändra" med ägarens två val (Rätta priset för all försäljning, eller Nytt
 * pris från i dag). Samma server actions och regler som Inköpspriser (ägare och admin
 * skriver, stängda månader skyddas av databasen). Ingen butiksandel, inga ändringsloggar.
 * Överst: notisen när ett mystery pack kostar något annat än sitt inköpspris.
 */
export async function SimplePricesScreen({ ctx }: { ctx: AppContext }) {
  const t = messages(ctx.locale);
  const [user, master] = await Promise.all([requireUser(), loadMasterData()]);
  const [data, drifts] = await Promise.all([
    loadPricePageFor(user, ctx.organization.id),
    // Mystery packs vars inköpspris inte stämmer med kalkylen ("now costs X kr, not Y kr").
    currentViewer().then((viewer) => loadMysteryCostDriftsFor(viewer, new Date(ctx.now))),
  ]);
  const { rows, missing } = priceRows(master.titles, data.prices, ctx.today);

  return (
    <div className="mx-auto flex w-full max-w-[720px] flex-col gap-6 px-4 pt-4 pb-8 md:px-8 md:pt-10">
      <StockTabs active="prices" t={t} />
      <PageHead
        eyebrow={t.stock.pricesTitle}
        title={t.stock.pricesHeadline(missing)}
        aside={t.stock.pricesAside}
      />
      {drifts.map((d) => (
        <CostNotice
          key={d.titleId}
          titleId={d.titleId}
          name={d.name}
          currentOre={d.currentOre}
          calculatedOre={d.calculatedOre}
          canUpdate={ctx.canEdit}
          href={`/vart-lager/mystery/${d.titleId}#kalkyl`}
        />
      ))}
      {rows.length === 0 ? (
        <StateMessage kind="empty" message={t.stock.noTitles} />
      ) : (
        <>
          {!ctx.canEdit ? <p className="text-base text-muted">{t.stock.readOnlyPrices}</p> : null}
          <PriceList rows={rows} canEdit={ctx.canEdit} today={ctx.today} />
        </>
      )}
    </div>
  );
}

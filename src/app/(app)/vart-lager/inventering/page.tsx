import type { Metadata } from "next";
import { Empty } from "@/components/v2/empty";
import { V2Page, headerDate } from "@/components/v2/shell/page";
import { messages } from "@/i18n";
import { loadOptionalContextIfSignedIn, requireRoute } from "@/server/data/core";

import { StockTabs } from "../../_enkel/stock-tabs";
import { currentViewer } from "../../lager/_lib/session";
import { BackToStock, CountFlow } from "./_components/count-flow";
import { loadStockCountFor } from "./_lib/data";

/** Inventering; i Enkel vy på personens språk ("Count stock"). */
export async function generateMetadata(): Promise<Metadata> {
  const ctx = await loadOptionalContextIfSignedIn().catch(() => null);
  return { title: messages(ctx?.locale ?? "sv").count.title };
}

/**
 * Vårt lager → Inventering: välj ett eget lager (Hemma, Kontoret …), räkna produkterna en
 * i taget eller som lista, se skillnaderna och spara allt på en gång. Det man räknat
 * ligger kvar på telefonen tills det är sparat. Samma skärm i hela appen och i Enkel vy
 * (där under Lager, på personens språk). Ägare och admin räknar; läsaren ser bara.
 */
// Lagret i länken (?lager=) läser CountFlow ur adressen (useSearchParams).
export default async function InventeringPage() {
  const ctx = await requireRoute("vart-lager");
  const t = messages(ctx.locale);
  const simple = ctx.viewMode === "simple";
  const viewer = await currentViewer();
  const view = await loadStockCountFor(viewer, new Date(ctx.now));

  const body = (
    <>
      {!view.hasWarehouse || view.rows.length === 0 || !view.canEdit ? (
        <div className="v2-count">
          <BackToStock href="/vart-lager" />
          <Empty
            title={
              !view.hasWarehouse
                ? t.stock.noWarehouse
                : view.rows.length === 0
                  ? t.stock.noTitles
                  : t.count.readOnly
            }
            className="v2-card"
          />
        </div>
      ) : (
        <CountFlow
          places={view.places}
          rows={view.rows}
          scope={`${viewer.organization.id}:${viewer.user.userId}`}
          stockHref="/vart-lager"
        />
      )}
    </>
  );

  // Enkel vy: skalets eget huvud på personens språk (V2Page är svensk), samma innehåll.
  if (simple) {
    return (
      <div className="mx-auto flex w-full max-w-[720px] flex-col gap-4 px-3 pt-3 pb-8 md:px-6 md:pt-6">
        <StockTabs active="stock" t={t} />
        {body}
      </div>
    );
  }
  return (
    <V2Page title={t.count.title} date={headerDate(new Date(ctx.now), ctx.timeZone)}>
      <div className="mx-auto w-full max-w-[720px]">{body}</div>
    </V2Page>
  );
}

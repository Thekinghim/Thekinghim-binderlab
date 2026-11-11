import type { Metadata } from "next";
import { StateMessage } from "@/components/ui/state-message";
import { messages } from "@/i18n";
import { loadOptionalContextIfSignedIn, requireRoute } from "@/server/data/core";

import { StockTabs } from "../../_enkel/stock-tabs";
import { currentViewer } from "../../lager/_lib/session";
import { BackToStock, CountFlow } from "./_components/count-flow";
import { loadStockCountFor } from "./_lib/data";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

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
export default async function InventeringPage({ searchParams }: { searchParams: SearchParams }) {
  const ctx = await requireRoute("vart-lager");
  const t = messages(ctx.locale);
  const simple = ctx.viewMode === "simple";
  const viewer = await currentViewer();
  const [view, sp] = await Promise.all([
    loadStockCountFor(viewer, new Date(ctx.now)),
    searchParams,
  ]);
  const wanted = typeof sp.lager === "string" ? sp.lager : null;

  return (
    <div className="mx-auto flex w-full max-w-[720px] flex-col gap-6 px-4 pt-4 pb-8 md:px-8 md:pt-10">
      {simple ? <StockTabs active="stock" t={t} /> : null}
      {!view.hasWarehouse || view.rows.length === 0 || !view.canEdit ? (
        <>
          <BackToStock href="/vart-lager" />
          <StateMessage
            kind="empty"
            message={
              !view.hasWarehouse
                ? t.stock.noWarehouse
                : view.rows.length === 0
                  ? t.stock.noTitles
                  : t.count.readOnly
            }
          />
        </>
      ) : (
        <CountFlow
          places={view.places}
          rows={view.rows}
          scope={`${viewer.organization.id}:${viewer.user.userId}`}
          initialPlaceId={wanted}
          stockHref="/vart-lager"
        />
      )}
    </div>
  );
}

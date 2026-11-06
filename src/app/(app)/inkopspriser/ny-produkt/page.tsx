import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense } from "react";

import { Skeleton } from "@/components/ui/skeleton";
import { StateMessage } from "@/components/ui/state-message";
import { cn } from "@/lib/cn";
import { AuthorizationError } from "@/server/access";
import { goodsOverviewFor, type GoodsOverview } from "@/server/awish/edit-good";
import { NewProductError } from "@/server/awish/goods";
import { AwishApiError } from "@/server/awish/grpc-client";
import { newProductPageFor } from "@/server/awish/new-product";
import {
  loadPeriod,
  OPERATOR_ROLES,
  requestStoreShareView,
  requestVmbView,
  requireRoute,
  requireViewer,
} from "@/server/data/core";
import type { Viewer } from "@/server/data/core/loaders";
import { safeErrorForLog } from "@/server/errors";

import { PageHead } from "../../vart-lager/_components/page-head";
import { GoodsManager } from "./_components/goods-manager";
import { NewProductPanels, SlotPanel } from "./_components/new-product-panels";
import { goodsPreselect, goodsTab, initialSlotMachine } from "./_lib/fack";

export const metadata: Metadata = { title: "Varor i Awish" };

type SearchParams = Record<string, string | string[] | undefined>;

function one(v: string | string[] | undefined): string | null {
  return typeof v === "string" ? v : Array.isArray(v) ? (v[0] ?? null) : null;
}

/** Listan med varorna (läser Awish): strömmas in medan resten av sidan redan syns. */
async function GoodsSection({
  viewer,
  scope,
  vmb,
  storeShare,
  preselect,
}: {
  viewer: Viewer;
  scope: { storeId: string | null; machineId: string | null };
  vmb: boolean;
  storeShare: boolean;
  preselect: { titleId: string | null; goodId: number | null };
}) {
  let overview: GoodsOverview;
  try {
    overview = await goodsOverviewFor(viewer, { ...scope, vmb, storeShare });
  } catch (error) {
    if (
      error instanceof NewProductError ||
      error instanceof AwishApiError ||
      error instanceof AuthorizationError
    ) {
      return <StateMessage kind="error" message={error.message} />;
    }
    console.error("[varor-i-awish]", safeErrorForLog(error));
    return <StateMessage kind="error" message="Kunde inte läsa varorna i Awish. Ladda om sidan." />;
  }
  return (
    <GoodsManager
      rows={overview.rows}
      titles={overview.titles}
      showShare={overview.showShare}
      notices={overview.notices}
      scope={scope}
      preselect={preselect}
    />
  );
}

function GoodsSkeleton() {
  return (
    <div className="flex flex-col gap-4" aria-busy="true" aria-label="Läser varorna i Awish">
      <Skeleton className="h-11 w-full" />
      {Array.from({ length: 4 }, (_, i) => (
        <div key={i} className="flex gap-3 border-b border-line py-4">
          <Skeleton className="size-14 shrink-0" />
          <div className="flex flex-1 flex-col gap-2">
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-3 w-1/2" />
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * Inköpspriser → Varor i Awish: "Redigera vara" (listan med Binderlabs siffror och flaggor;
 * namn, pris och bild), "Lägg i fack" (en vara i ett fack, ?vara= eller ?titel= förvald)
 * och "Ny produkt" (skapa en vara). Bara ägare och admin; alla andra skickas tillbaka till
 * Inköpspriser. Kräver att push till Awish är påslaget under Datakällor.
 */
export default async function NewProductPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const ctx = await requireRoute("inkopspriser");
  if (!(OPERATOR_ROLES as readonly string[]).includes(ctx.role)) redirect("/inkopspriser");
  const sp = await searchParams;
  const viewer = await requireViewer();
  const [data, period, vmb, storeShare] = await Promise.all([
    newProductPageFor(viewer),
    loadPeriod(sp),
    requestVmbView(),
    requestStoreShareView(),
  ]);
  const tab = goodsTab(one(sp.flik));
  const preselect = goodsPreselect(one(sp.vara), one(sp.titel));
  const scope = {
    storeId: period.scope.storeId ?? null,
    machineId: period.scope.machineId ?? null,
  };

  const tabs = [
    { id: "redigera", label: "Redigera vara", href: "/inkopspriser/ny-produkt" },
    { id: "fack", label: "Lägg i fack", href: "/inkopspriser/ny-produkt?flik=fack" },
    { id: "ny", label: "Ny produkt", href: "/inkopspriser/ny-produkt?flik=ny" },
  ] as const;

  return (
    <div className="mx-auto flex w-full max-w-[1280px] flex-col gap-8 px-4 pt-8 pb-16 md:px-8 md:pt-12">
      <div className="flex flex-col gap-3">
        <PageHead
          eyebrow="Inköpspriser · Varor i Awish"
          title="Varor i Awish"
          aside={
            tab === "ny"
              ? "Skapa varan i Awish. Du ser allt innan det skickas."
              : tab === "fack"
                ? "Välj fack och vara. Du ser allt innan det skickas."
                : "Det som behöver åtgärd står först. Du ser allt innan det sparas."
          }
        />
        <Link
          href="/inkopspriser"
          className="meta inline-flex min-h-11 w-fit items-center rounded-xs text-muted underline underline-offset-4 hover:text-fg md:min-h-0"
        >
          ← Inköpspriser
        </Link>
      </div>
      <nav aria-label="Varor i Awish" className="flex gap-1 border-b border-line sm:gap-2">
        {tabs.map((t) => (
          <Link
            key={t.id}
            href={t.href}
            aria-current={tab === t.id ? "page" : undefined}
            className={cn(
              "-mb-px inline-flex min-h-11 items-center border-b-2 px-2 text-base whitespace-nowrap transition-colors sm:px-3",
              tab === t.id
                ? "border-fg font-medium text-fg"
                : "border-transparent text-muted hover:text-fg",
            )}
          >
            {t.label}
          </Link>
        ))}
      </nav>
      {data.status.blocker ? (
        <StateMessage
          kind="empty"
          message={data.status.blocker}
          action={{ label: "Till Datakällor →", href: "/datakallor" }}
        />
      ) : tab === "ny" ? (
        <NewProductPanels />
      ) : tab === "fack" ? (
        <SlotPanel
          machines={data.machines}
          initialMachineId={initialSlotMachine(data.machines, scope.machineId)}
          preselect={{
            goodId: preselect.goodId,
            titleId: preselect.goodId === null ? preselect.titleId : null,
          }}
        />
      ) : (
        <Suspense fallback={<GoodsSkeleton />}>
          <GoodsSection
            viewer={viewer}
            scope={scope}
            vmb={vmb}
            storeShare={storeShare}
            preselect={preselect}
          />
        </Suspense>
      )}
    </div>
  );
}

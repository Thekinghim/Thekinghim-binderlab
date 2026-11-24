import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense } from "react";

import { StateMessage } from "@/components/ui/state-message";
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

import { ButtonLink } from "@/components/v2/button";
import { Notice } from "@/components/v2/notice";
import { PAGE_BODY } from "@/components/v2/page-intro";
import { V2Page, headerDate } from "@/components/v2/shell/page";
import { SkeletonCard } from "@/components/v2/skeleton";
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
  scope: {
    storeId: string | null;
    machineId: string | null;
    ownerId: string | null;
    storeIds: readonly string[] | null;
  };
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
    <div className="v2-stack" aria-busy="true" aria-label="Läser varorna i Awish">
      <SkeletonCard rows={6} />
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
    ownerId: period.scope.ownerId ?? null,
    storeIds: period.scope.storeIds ?? null,
  };

  const tabs = [
    { id: "redigera", label: "Redigera vara", href: "/inkopspriser/ny-produkt" },
    { id: "fack", label: "Lägg i fack", href: "/inkopspriser/ny-produkt?flik=fack" },
    { id: "ny", label: "Ny produkt", href: "/inkopspriser/ny-produkt?flik=ny" },
  ] as const;

  return (
    <V2Page
      title="Varor i Awish"
      date={headerDate(new Date(ctx.now), ctx.timeZone)}
      period={tab === "redigera"}
      sub={
        <>
          <Link href="/inkopspriser" className="font-[550] text-v2-ink hover:underline">
            <span aria-hidden="true">← </span>
            Inköpspriser
          </Link>
          <span aria-hidden="true">·</span>
          <span>
            {tab === "ny"
              ? "Skapa varan i Awish. Du ser allt innan det skickas."
              : tab === "fack"
                ? "Välj fack och vara. Du ser allt innan det skickas."
                : "Det som behöver åtgärd står först. Du ser allt innan det sparas."}
          </span>
        </>
      }
    >
      <div className={PAGE_BODY}>
        <nav aria-label="Varor i Awish" className="v2-subnav mb-0">
          {tabs.map((t) => (
            <Link key={t.id} href={t.href} aria-current={tab === t.id ? "page" : undefined}>
              {t.label}
            </Link>
          ))}
          <Link href="/inkopspriser/kategorier">Kategorier</Link>
        </nav>
        {data.status.blocker ? (
          <Notice
            tone="warning"
            title="Inte kopplad"
            action={
              <ButtonLink href="/datakallor" touch>
                Till Datakällor
              </ButtonLink>
            }
          >
            {data.status.blocker}
          </Notice>
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
    </V2Page>
  );
}

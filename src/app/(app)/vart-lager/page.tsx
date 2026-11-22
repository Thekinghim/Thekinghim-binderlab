import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { StateMessage } from "@/components/ui/state-message";
import { ButtonLink } from "@/components/v2/button";
import { DaySalesCard } from "@/components/v2/day-sales";
import { SkeletonCard } from "@/components/v2/skeleton";
import { V2Page, headerDate } from "@/components/v2/shell/page";
import { messages } from "@/i18n";
import { loadMasterData, loadOptionalContextIfSignedIn, requireRoute } from "@/server/data/core";
import { loadDaySales } from "@/server/data/v2/analytics/day-sales";
import { loadDayRoute } from "@/server/data/v2/route";

import { SimpleStockScreen } from "../_enkel/stock-screen";
import { currentViewer } from "../lager/_lib/session";
import { HomeStock } from "./_components/home-stock";
import { PlaceBar } from "./_components/place-bar";
import { TodoList, type TodoItem } from "./_components/todo-list";
import { LagerView } from "./_components/v2/lager-view";
import { loadVartLagerFor } from "./_lib/data";
import { headingOf } from "./_lib/heading";
import { stockTodos } from "./_lib/model";
import { loadVartLagerExtrasFor } from "./_lib/v2-data";
import { buyLines, machineValueOre, recentEvents } from "./_lib/v2-model";
import { packActionHref } from "./mystery/_lib/model";

/** Vårt lager; i Enkel vy Lager på personens språk. */
export async function generateMetadata(): Promise<Metadata> {
  const ctx = await loadOptionalContextIfSignedIn().catch(() => null);
  if (ctx?.viewMode === "simple") return { title: messages(ctx.locale).stock.title };
  return { title: "Vårt lager" };
}

/**
 * Vårt lager (V2, byggplanen 2.6): hur många pack vi har hemma och i automaterna, vad som är
 * på väg, en rad per titel (fördelning, Hemma räcker, Totalt; Alla/Lågt/Slut), Köpa (samma
 * antal som Inköp), Räkna lagret, Lagervärde och Senaste händelser. Överst raden "Dagens rutt
 * behöver …" (samma rutt som /rutt).
 *
 * `?vy=andra`: den tidigare vyn för att skriva antal, inköp och flytt mellan lagren (ägare och
 * admin skriver; RLS). Ägare, admin och läsare; i Enkel vy delägarens enkla skärm.
 */
export default async function VartLagerPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const ctx = await requireRoute("vart-lager");
  // Enkel vy: delägarens egen, enkla skärm (lagret, leverans in och rätta antalet).
  if (ctx.viewMode === "simple") return <SimpleStockScreen ctx={ctx} />;
  const sp = await searchParams;
  const viewer = await currentViewer();
  const now = new Date(ctx.now);
  const [view, extras, route] = await Promise.all([
    loadVartLagerFor(viewer, now),
    loadVartLagerExtrasFor(viewer),
    loadDayRoute().catch(() => null),
  ]);
  const date = headerDate(now, ctx.timeZone);

  if (sp.vy === "andra") {
    const scope = `${viewer.organization.id}:${viewer.user.userId}`;
    const heading = headingOf(view);
    const todos: TodoItem[] = stockTodos(view.rows).map((t) => ({
      key: t.titleId,
      verb: t.verb,
      title: t.title,
      qty: t.qty,
      unit: t.unit,
      note: t.steps,
      fact: t.fact,
      tone: t.tone,
      href:
        t.verb === "Beställ"
          ? "/prognos"
          : t.verb === "Packa"
            ? packActionHref(t.titleId, t.packs, t.placeId)
            : `#rad-${t.titleId}`,
    }));
    return (
      <V2Page
        title="Ändra"
        date={date}
        tools={
          <>
            {/* Inventering: räkna ett helt lager (ägare och admin). */}
            {view.canEdit && view.rows.length > 0 ? (
              <ButtonLink href="/vart-lager/inventering" size="lg">
                Inventera
              </ButtonLink>
            ) : null}
            <ButtonLink href="/vart-lager" size="lg" icon aria-label="Tillbaka till Vårt lager">
              ←
            </ButtonLink>
          </>
        }
      >
        <div className="mx-auto flex w-full max-w-[1080px] flex-col gap-8">
          {!view.hasWarehouse ? (
            <>
              <StateMessage kind="empty" message="Inget eget lager än." />
              <PlaceBar places={[]} totals={{}} selected={null} canEdit={view.canAddPlace} />
            </>
          ) : view.rows.length === 0 ? (
            <StateMessage
              kind="empty"
              message="Inga titlar än."
              action={{ label: "Öppna Datakällor", href: "/datakallor" }}
            />
          ) : (
            <>
              <TodoList items={todos} done={heading.aside} />
              <HomeStock model={view} scope={scope} />
            </>
          )}
        </div>
      </V2Page>
    );
  }

  // Automatkod → butikens namn ("NA-03" → "Kortkammaren") för Senaste händelser.
  const master = await loadMasterData();
  const storeName = new Map(master.stores.map((st) => [st.id, st.name]));
  const machinePlace = new Map(
    master.machines.map((m) => [m.code, (m.storeId ? storeName.get(m.storeId) : null) ?? m.name]),
  );

  const loadByTitle = new Map(route?.load.map((l) => [l.titleId, l]) ?? []);
  return (
    <V2Page
      title="Vårt lager"
      date={date}
      period
      tools={
        view.canEdit ? (
          <>
            <ButtonLink href="/vart-lager?vy=andra">Ändra antal</ButtonLink>
            <Link href="/vart-lager/mystery" className="v2-btn max-[900px]:hidden">
              Mystery packs
            </Link>
          </>
        ) : null
      }
    >
      {!view.hasWarehouse || view.rows.length === 0 ? (
        <StateMessage
          kind="empty"
          message={view.hasWarehouse ? "Inga titlar än." : "Inget eget lager än."}
          action={
            view.canAddPlace
              ? { label: "Lägg till ett lager", href: "/vart-lager?vy=andra" }
              : undefined
          }
        />
      ) : (
        <LagerView
          rows={view.rows}
          home={view.totals.home}
          inMachines={view.totals.inMachines}
          places={view.places.map((pl) => ({
            id: pl.id,
            name: pl.name,
            packs: view.totals.byPlace[pl.id] ?? 0,
            lastCounted: extras.lastCounted[pl.id] ?? null,
          }))}
          onTheWay={view.onTheWay.map((w) => ({
            titleId: w.titleId,
            name: w.name,
            qty: w.qty,
            expectedOn: w.expectedOn,
            late: w.late,
          }))}
          buy={ctx.canSeeEconomy ? buyLines(view.rows, view.buyInfo) : null}
          value={
            ctx.canSeeEconomy
              ? {
                  homeOre: view.totals.valueOre,
                  machinesOre: machineValueOre(view.rows),
                  unpriced: view.totals.unpriced,
                }
              : null
          }
          events={recentEvents(extras.events, (code) => machinePlace.get(code) ?? null)}
          route={
            route
              ? {
                  stops: route.stops.length,
                  packs: route.totalPacks,
                  short: route.short.map((s) => {
                    const l = loadByTitle.get(s.titleId);
                    return {
                      titleName: s.titleName,
                      need: (l?.quantity ?? 0) + s.shortBy,
                      home: l?.home ?? 0,
                    };
                  }),
                }
              : null
          }
          canEdit={view.canEdit}
          packHref={Object.fromEntries(
            view.rows
              .filter((r) => r.action?.kind === "pack")
              .map((r) => [
                r.titleId,
                packActionHref(r.titleId, r.action?.packs ?? null, r.action?.placeId ?? null),
              ]),
          )}
          timeZone={ctx.timeZone}
          now={ctx.now}
        />
      )}
      {/* Det som gick ut ur lagret under vald period (periodvalet överst), per titel och automat. */}
      {view.rows.length > 0 ? (
        <div className="mt-[14px]">
          <Suspense fallback={<SkeletonCard rows={6} />}>
            <Sold sp={sp} />
          </Suspense>
        </div>
      ) : null}
    </V2Page>
  );
}

async function Sold({ sp }: { sp: Record<string, string | string[] | undefined> }) {
  const v = await loadDaySales(sp).catch((error: unknown) => {
    console.error("[vart-lager] Försäljningen för perioden kunde inte läsas:", error);
    return null;
  });
  if (!v) return null;
  return (
    <DaySalesCard
      sales={v.sales}
      title={v.singleDay ? `Sålt ${v.inline}` : `Sålt · ${v.inline}`}
      inline={v.inline}
    />
  );
}

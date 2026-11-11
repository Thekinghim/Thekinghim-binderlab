import type { Metadata } from "next";
import Link from "next/link";
import type { CSSProperties } from "react";

import { Icon } from "@/components/ui/icon";
import { StateMessage } from "@/components/ui/state-message";
import { formatters, messages, type Messages } from "@/i18n";
import { getT } from "@/i18n/server";
import { requireRoute } from "@/server/data/core";

import { currentViewer } from "../../lager/_lib/session";
import { PageHead } from "../_components/page-head";
import { ContentsCard } from "./_components/contents-card";
import { CostNotice } from "./_components/cost-notice";
import { StockLine } from "./_components/stock-line";
import { krAuto } from "./_lib/kr";
import { loadMysteryOverviewFor, type MysteryOverview, type MysteryTitle } from "./_lib/data";
import { averageCost, defaultPlace, maxBatches, packHref, packSentence } from "./_lib/model";

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getT();
  return { title: t.mystery.title };
}

/** "Kan packa 2 omgångar hemma · Delta Reign tar slut först". */
function capacityLine(view: MysteryOverview, title: MysteryTitle, t: Messages): string | null {
  if (!title.recipe) return null;
  const place = defaultPlace(title.recipe, view.places, view.byPlace);
  if (!place) return t.mystery.noOwnStock;
  const cap = maxBatches(title.recipe, view.byPlace[place.id] ?? {});
  if (cap.batches === 0) return t.mystery.cannotPack(place.name, cap.limiting?.name ?? null);
  return t.mystery.canPack(cap.batches, place.name, cap.limiting?.name ?? null);
}

/**
 * Vårt lager → Mystery packs: varje egen produkt med innehållet (som etiketten), hur många
 * som finns i lagren och automaterna, hur många omgångar som går att packa och Packa.
 * Alla roller i appen (påfyllaren packar); belopp bara för ägare, admin och läsare.
 * Enkel vy: ingen redigering av innehållet och inga länkar bort, men kostnaden och notisen
 * "kostar nu X kr, inte Y kr" visas (delägaren köper in och sköter inköpspriserna).
 */
export default async function MysteryPacksPage() {
  const ctx = await requireRoute("mystery");
  const t = messages(ctx.locale);
  // Enkel vy: innehållet, Packa och kostnaden (ingen redigering av innehållet). Inköpspriset
  // sätts av den som får ändra priser (ägare och admin), som i hela appen.
  const simple = ctx.viewMode === "simple";
  const viewer = await currentViewer();
  const loaded = await loadMysteryOverviewFor(viewer, new Date(ctx.now));
  const view: MysteryOverview = simple ? { ...loaded, canEdit: false } : loaded;
  const canSetCost = loaded.canEdit;

  const totalHome = view.titles.reduce(
    (n, t) => n + Object.values(t.inPlaces).reduce((a, b) => a + Math.max(0, b), 0),
    0,
  );
  const missingRecipe = view.titles.filter((t) => !t.recipe).length;
  const aside =
    view.titles.length === 0
      ? undefined
      : missingRecipe > 0
        ? t.mystery.missingRecipe(missingRecipe)
        : t.mystery.pressPack;

  return (
    <div className="mx-auto flex w-full max-w-[1080px] flex-col gap-10 px-4 pt-8 pb-16 md:px-8 md:pt-12">
      <PageHead eyebrow={t.mystery.title} title={t.mystery.headline(totalHome)} aside={aside} />
      {view.titles.length === 0 ? (
        <StateMessage
          kind="empty"
          message={t.mystery.empty}
          detail={simple ? t.mystery.emptySimple : t.mystery.emptyDetail}
          {...(view.canEdit
            ? { action: { label: "Öppna Inköpspriser", href: "/inkopspriser" } }
            : {})}
        />
      ) : (
        <ul className="flex flex-col gap-6">
          {view.titles.map((title, i) => (
            <li key={title.id} className="rise" style={{ "--i": i + 1 } as CSSProperties}>
              <TitleCard view={view} title={title} t={t} canSetCost={canSetCost} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function TitleCard({
  view,
  title: t,
  t: m,
  canSetCost,
}: {
  view: MysteryOverview;
  title: MysteryTitle;
  t: Messages;
  canSetCost: boolean;
}) {
  const f = formatters(m.locale);
  const kr = (ore: number) => krAuto(f, ore);
  const cap = capacityLine(view, t, m);
  const sentence = packSentence(t.toPack, m);
  const cost = t.recipe && view.seesMoney ? averageCost(t.recipe, view.prices) : null;
  const differs =
    cost?.perPackOre !== null &&
    cost?.perPackOre !== undefined &&
    cost.perPackOre !== t.currentCostOre;

  return (
    <section
      aria-labelledby={`mp-${t.id}`}
      className="flex flex-col gap-4 rounded-md border border-line p-4 md:p-6"
    >
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div className="flex min-w-0 flex-col gap-1">
          <h2 id={`mp-${t.id}`} className="text-2xl font-medium text-fg">
            <Link
              href={`/vart-lager/mystery/${t.id}`}
              className="inline-flex min-h-11 items-center hover:underline"
            >
              {t.name}
            </Link>
          </h2>
          <StockLine
            titleId={t.id}
            places={view.places}
            inPlaces={t.inPlaces}
            inMachines={t.inMachines}
            batchSize={t.recipe?.batchSize ?? null}
            canPack={view.canPack}
            canCount={canSetCost}
            t={m}
          />
          {cap ? <p className="text-base text-fg">{cap}</p> : null}
          {sentence ? (
            <p
              className={
                sentence.tone === "act"
                  ? "text-base font-medium text-signal-fg"
                  : "text-base text-muted"
              }
            >
              {sentence.text}
            </p>
          ) : null}
        </div>
        {t.recipe && view.canPack ? (
          <Link
            href={packHref(t.id, t.toPack?.packs)}
            className="flex h-14 shrink-0 items-center justify-center gap-2 rounded-md border border-inverse bg-inverse px-6 text-lg font-medium text-on-inverse active:bg-inverse-hover md:h-12"
          >
            <Icon name="plus" size={18} />
            {m.mystery.pack}
          </Link>
        ) : !t.recipe && view.canEdit ? (
          <Link
            href={`/vart-lager/mystery/${t.id}#innehall`}
            className="flex h-14 shrink-0 items-center justify-center gap-2 rounded-md border border-inverse bg-inverse px-6 text-lg font-medium text-on-inverse md:h-12"
          >
            Lägg in innehållet
          </Link>
        ) : null}
      </div>

      {t.recipe ? (
        <ContentsCard recipe={t.recipe} />
      ) : (
        <p className="text-base text-muted">{m.mystery.noContents}</p>
      )}

      {cost ? (
        <div className="flex flex-col gap-3">
          <p className="tnum text-base text-muted">
            {cost.perPackOre !== null
              ? m.mystery.contentsCost(kr(cost.perPackOre))
              : m.mystery.missingPrice(cost.missing.join(", "))}
            {m.mystery.currentCost(t.currentCostOre !== null ? kr(t.currentCostOre) : null)}
          </p>
          {differs && cost.perPackOre !== null ? (
            <CostNotice
              titleId={t.id}
              name={t.name}
              currentOre={t.currentCostOre}
              calculatedOre={cost.perPackOre}
              canUpdate={canSetCost}
              href={`/vart-lager/mystery/${t.id}#kalkyl`}
            />
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

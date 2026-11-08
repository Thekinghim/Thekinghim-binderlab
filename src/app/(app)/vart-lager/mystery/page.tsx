import type { Metadata } from "next";
import Link from "next/link";
import type { CSSProperties } from "react";

import { inPlace } from "@/components/stock/place-text";
import { Icon } from "@/components/ui/icon";
import { StateMessage } from "@/components/ui/state-message";
import { formatInt, formatKronor, NBSP } from "@/lib/format";
import { requireRoute } from "@/server/data/core";

import { currentViewer } from "../../lager/_lib/session";
import { PageHead } from "../_components/page-head";
import { ContentsCard } from "./_components/contents-card";
import { SetCostButton } from "./_components/mystery-actions";
import { loadMysteryOverviewFor, type MysteryOverview, type MysteryTitle } from "./_lib/data";
import {
  averageCost,
  batchesForPacks,
  batchesText,
  defaultPlace,
  maxBatches,
  packHref,
} from "./_lib/model";

export const metadata: Metadata = { title: "Mystery packs" };

const kr = (ore: number) => formatKronor(ore / 100);

/** "Kan packa 2 omgångar hemma · Delta Reign tar slut först". */
function capacityLine(view: MysteryOverview, t: MysteryTitle): string | null {
  if (!t.recipe) return null;
  const place = defaultPlace(t.recipe, view.places, view.byPlace);
  if (!place) return "Inget eget lager än.";
  const cap = maxBatches(t.recipe, view.byPlace[place.id] ?? {});
  if (cap.batches === 0) {
    return `Kan inte packa ${inPlace(place.name)}: ${cap.limiting?.name ?? "delar"} räcker inte.`;
  }
  const limit = cap.limiting ? ` · ${cap.limiting.name} tar slut först` : "";
  return `Kan packa ${batchesText(cap.batches)} ${inPlace(place.name)}${limit}`;
}

/**
 * Vårt lager → Mystery packs: varje egen produkt med innehållet (som etiketten), hur många
 * som finns i lagren och automaterna, hur många omgångar som går att packa och Packa.
 * Alla roller i appen (påfyllaren packar); belopp bara för ägare, admin och läsare.
 */
export default async function MysteryPacksPage() {
  const ctx = await requireRoute("mystery");
  const viewer = await currentViewer();
  const view = await loadMysteryOverviewFor(viewer, new Date(ctx.now));

  const totalHome = view.titles.reduce(
    (n, t) => n + Object.values(t.inPlaces).reduce((a, b) => a + Math.max(0, b), 0),
    0,
  );
  const missingRecipe = view.titles.filter((t) => !t.recipe).length;
  const aside =
    view.titles.length === 0
      ? undefined
      : missingRecipe > 0
        ? `${formatInt(missingRecipe)} ${missingRecipe === 1 ? "titel" : "titlar"} saknar innehåll.`
        : "Tryck Packa när du har packat en omgång.";

  return (
    <div className="mx-auto flex w-full max-w-[1080px] flex-col gap-10 px-4 pt-8 pb-16 md:px-8 md:pt-12">
      <PageHead
        eyebrow="Mystery packs"
        title={`${formatInt(totalHome)} mystery packs i lagret.`}
        aside={aside}
      />
      {view.titles.length === 0 ? (
        <StateMessage
          kind="empty"
          message="Inga egna produkter än."
          detail="Slå på Egen produkt för titeln under Inköpspriser."
          {...(view.canEdit
            ? { action: { label: "Öppna Inköpspriser", href: "/inkopspriser" } }
            : {})}
        />
      ) : (
        <ul className="flex flex-col gap-6">
          {view.titles.map((t, i) => (
            <li key={t.id} className="rise" style={{ "--i": i + 1 } as CSSProperties}>
              <TitleCard view={view} title={t} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function TitleCard({ view, title: t }: { view: MysteryOverview; title: MysteryTitle }) {
  const cap = capacityLine(view, t);
  const cost = t.recipe && view.seesMoney ? averageCost(t.recipe, view.prices) : null;
  const differs =
    cost?.perPackOre !== null &&
    cost?.perPackOre !== undefined &&
    cost.perPackOre !== t.currentCostOre;
  const stockParts = [
    ...view.places.map((p) => `${p.name} ${formatInt(t.inPlaces[p.id] ?? 0)}`),
    `I automaterna ${formatInt(t.inMachines)}`,
  ];

  return (
    <section
      aria-labelledby={`mp-${t.id}`}
      className="flex flex-col gap-4 rounded-md border border-line p-4 md:p-6"
    >
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div className="flex min-w-0 flex-col gap-1">
          <h2 id={`mp-${t.id}`} className="text-2xl font-medium text-fg">
            <Link href={`/vart-lager/mystery/${t.id}`} className="hover:underline">
              {t.name}
            </Link>
          </h2>
          <p className="tnum text-base text-muted">{stockParts.join(" · ")}</p>
          {cap ? <p className="text-base text-fg">{cap}</p> : null}
          {t.packQty !== null && t.packQty > 0 && t.recipe ? (
            <p className="text-base text-signal-fg">
              Inköp: packa {formatInt(t.packQty)}
              {NBSP}st ({batchesText(batchesForPacks(t.packQty, t.recipe.batchSize))})
            </p>
          ) : null}
        </div>
        {t.recipe && view.canPack ? (
          <Link
            href={packHref(t.id, t.packQty)}
            className="flex h-14 shrink-0 items-center justify-center gap-2 rounded-md border border-inverse bg-inverse px-6 text-lg font-medium text-on-inverse active:bg-inverse-hover md:h-12"
          >
            <Icon name="plus" size={18} />
            Packa
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
        <p className="text-base text-muted">Inget innehåll än.</p>
      )}

      {cost ? (
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <p className="tnum text-base text-muted">
            {cost.perPackOre !== null
              ? `Innehållet kostar ${kr(cost.perPackOre)} per pack`
              : `Saknar inköpspris: ${cost.missing.join(", ")}`}
            {` · inköpspris ${t.currentCostOre !== null ? kr(t.currentCostOre) : "saknas"}`}
          </p>
          {differs && view.canEdit && cost.perPackOre !== null ? (
            <SetCostButton
              titleId={t.id}
              unitCostOre={cost.perPackOre}
              label={`Sätt inköpspris till ${kr(cost.perPackOre)}`}
            />
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

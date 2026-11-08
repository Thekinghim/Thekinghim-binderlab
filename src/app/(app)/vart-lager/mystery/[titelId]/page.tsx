import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { wallClockIn } from "@/components/shell/period-state";
import { inPlace } from "@/components/stock/place-text";
import { formatDate, formatDateTime, formatInt, formatKronor, NBSP } from "@/lib/format";
import { requireRoute } from "@/server/data/core";

import { currentViewer } from "../../../lager/_lib/session";
import { PageHead } from "../../_components/page-head";
import { ContentsSection, SetCostButton, UndoPackButton } from "../_components/mystery-actions";
import { PackFlow } from "../_components/pack-flow";
import { loadMysteryDetailFor } from "../_lib/data";
import {
  averageCost,
  batchesForPacks,
  batchesText,
  defaultPlace,
  maxBatches,
  recipeOdds,
} from "../_lib/model";

export const metadata: Metadata = { title: "Mystery pack" };

const kr = (ore: number) => formatKronor(ore / 100);
const SECTION = "flex flex-col gap-4 scroll-mt-28";

type Params = Promise<{ titelId: string }>;
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function one(v: string | string[] | undefined): string | null {
  return typeof v === "string" ? v : Array.isArray(v) ? (v[0] ?? null) : null;
}

/**
 * En egen produkt: Packa överst (mobil först), innehållet som på etiketten (ägare och admin
 * ändrar det), kostnaden och kvar per pack med "Sätt inköpspris", och senaste packningarna
 * med Ångra. ?packa=28 förväljer omgångarna för 28 mystery packs (Inköps "Packa X st").
 */
export default async function MysteryPackPage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: SearchParams;
}) {
  const ctx = await requireRoute("mystery");
  const [{ titelId }, sp] = await Promise.all([params, searchParams]);
  if (!/^[0-9a-f-]{36}$/i.test(titelId)) notFound();
  const viewer = await currentViewer();
  const now = new Date(ctx.now);
  const detail = await loadMysteryDetailFor(viewer, titelId, now);
  if (!detail) notFound();
  const { overview: view, title: t, recipe } = { ...detail, recipe: detail.title.recipe };

  const place = recipe ? defaultPlace(recipe, view.places, view.byPlace) : null;
  const cap = recipe && place ? maxBatches(recipe, view.byPlace[place.id] ?? {}) : null;
  // ?packa=28 (Inköps "Packa X st") förväljer omgångarna, men aldrig fler än lagret räcker till.
  const wanted = Number(one(sp.packa) ?? "");
  const initialBatches = recipe
    ? Math.min(
        batchesForPacks(Number.isFinite(wanted) && wanted > 0 ? wanted : 1, recipe.batchSize),
        Math.max(1, cap?.batches ?? 1),
      )
    : 1;
  const odds = recipe ? recipeOdds(recipe) : null;
  const cost = recipe && view.seesMoney ? averageCost(recipe, view.prices) : null;
  const differs = cost?.perPackOre != null && cost.perPackOre !== t.currentCostOre;
  const local = (iso: string) => wallClockIn(new Date(iso), ctx.timeZone);
  const nowLocal = wallClockIn(now, ctx.timeZone);

  const aside = recipe
    ? `${formatInt(recipe.batchSize)} per omgång${
        odds && odds.hits > 0 ? ` · ${Math.round(odds.hitBp / 100)}${NBSP}% chans till hit` : ""
      }${cap && place ? ` · räcker till ${batchesText(cap.batches)} ${inPlace(place.name)}` : ""}`
    : "Lägg in innehållet först.";

  return (
    <div className="mx-auto flex w-full max-w-[880px] flex-col gap-10 px-4 pt-8 pb-16 md:px-8 md:pt-12">
      <div className="flex flex-col gap-3">
        <Link href="/vart-lager/mystery" className="meta w-fit text-muted hover:text-fg">
          ← Mystery packs
        </Link>
        <PageHead eyebrow="Mystery packs" title={t.name} aside={aside} />
        <p className="tnum text-base text-muted">
          {[
            ...view.places.map((p) => `${p.name} ${formatInt(t.inPlaces[p.id] ?? 0)}`),
            `I automaterna ${formatInt(t.inMachines)}`,
          ].join(" · ")}
        </p>
      </div>

      {recipe && view.canPack ? (
        <section id="packa" aria-labelledby="packa-rubrik" className={SECTION}>
          <h2 id="packa-rubrik" className="text-xl font-medium text-fg">
            Packa
          </h2>
          {t.packQty !== null && t.packQty > 0 ? (
            <p className="text-base text-muted">
              Inköp säger packa {formatInt(t.packQty)}
              {NBSP}st ({batchesText(batchesForPacks(t.packQty, recipe.batchSize))}).
            </p>
          ) : null}
          <PackFlow
            titleId={t.id}
            name={t.name}
            recipe={recipe}
            places={view.places}
            byPlace={view.byPlace}
            defaultPlaceId={place?.id ?? null}
            initialBatches={initialBatches}
          />
        </section>
      ) : null}

      <section id="innehall" aria-labelledby="innehall-rubrik" className={SECTION}>
        <h2 id="innehall-rubrik" className="text-xl font-medium text-fg">
          Innehåll
        </h2>
        <ContentsSection
          titleId={t.id}
          recipe={recipe}
          choices={detail.choices}
          canEdit={view.canEdit}
        />
        {detail.versions.length > 0 ? (
          <p className="meta text-subtle">
            {detail.versions
              .map(
                (v) =>
                  `Version ${formatInt(v.version)} från ${formatDate(new Date(`${v.validFrom}T12:00:00`), { year: "auto", now: nowLocal })}`,
              )
              .join(" · ")}
          </p>
        ) : null}
      </section>

      {cost ? (
        <section aria-labelledby="kostnad-rubrik" className={SECTION}>
          <h2 id="kostnad-rubrik" className="text-xl font-medium text-fg">
            Kostnad
          </h2>
          <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-2 text-base">
            <dt className="text-muted">Innehållet, snitt per pack</dt>
            <dd className="tnum text-right text-fg">
              {cost.perPackOre !== null ? kr(cost.perPackOre) : "–"}
            </dd>
            <dt className="text-muted">Inköpspris i dag</dt>
            <dd className="tnum text-right text-fg">
              {t.currentCostOre !== null ? kr(t.currentCostOre) : "saknas"}
            </dd>
            <dt className="text-muted">Pris i automaten (senaste köpet)</dt>
            <dd className="tnum text-right text-fg">
              {detail.salePriceOre !== null ? kr(detail.salePriceOre) : "inget köp än"}
            </dd>
            <dt className="text-muted">Kvar per pack före butikens andel</dt>
            <dd className="tnum text-right font-medium text-fg">
              {detail.leftPerPackOre !== null
                ? `${kr(detail.leftPerPackOre)}${
                    detail.salePriceOre
                      ? ` (${Math.round((detail.leftPerPackOre * 100) / detail.salePriceOre)}${NBSP}%)`
                      : ""
                  }`
                : "–"}
            </dd>
          </dl>
          {cost.missing.length > 0 ? (
            <p className="text-base text-signal-fg">
              Saknar inköpspris: {cost.missing.join(", ")}.{" "}
              <Link href="/inkopspriser" className="underline">
                Inköpspriser
              </Link>
            </p>
          ) : null}
          {differs && cost.perPackOre !== null ? (
            <div className="flex flex-col gap-3 rounded-md border border-signal-line bg-signal-soft px-4 py-3">
              <p className="text-base text-fg">
                Sålda mystery packs räknas med inköpspriset{" "}
                {t.currentCostOre !== null ? kr(t.currentCostOre) : "(saknas)"}, men innehållet
                kostar {kr(cost.perPackOre)}.
              </p>
              {view.canEdit ? (
                <SetCostButton
                  titleId={t.id}
                  unitCostOre={cost.perPackOre}
                  label={`Sätt inköpspris till ${kr(cost.perPackOre)}`}
                />
              ) : null}
            </div>
          ) : null}
          <p className="meta text-subtle">
            Kvar per pack räknas som på Inköpspriser (kortavgift, VMB) på{" "}
            {detail.salesOrders > 0
              ? `${formatInt(detail.salesOrders)} köp senaste 30 dagarna`
              : "ett tänkt köp"}{" "}
            med innehållets snitt som inköpspris.
          </p>
        </section>
      ) : null}

      {detail.packings.length > 0 ? (
        <section aria-labelledby="packat-rubrik" className={SECTION}>
          <h2 id="packat-rubrik" className="text-xl font-medium text-fg">
            Senast packat
          </h2>
          <ul className="flex flex-col divide-y divide-line rounded-md border border-line">
            {detail.packings.map((p) => (
              <li key={p.id} className="flex min-h-14 items-center justify-between gap-3 px-4 py-2">
                <span className="flex min-w-0 flex-col">
                  <span
                    className={p.undone ? "text-base text-muted line-through" : "text-base text-fg"}
                  >
                    {batchesText(p.batches)} · {formatInt(p.packs)}
                    {NBSP}st {inPlace(p.placeName)}
                  </span>
                  <span className="meta text-subtle">
                    {formatDateTime(local(p.packedAt), { year: "auto", now: nowLocal })} · version{" "}
                    {formatInt(p.version)}
                    {p.costPerPackOre !== null ? ` · ${kr(p.costPerPackOre)} per pack` : ""}
                    {p.undone ? " · ångrad" : ""}
                  </span>
                </span>
                {p.undoable ? <UndoPackButton packingId={p.id} /> : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

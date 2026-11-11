import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { wallClockIn } from "@/components/shell/period-state";
import { formatters, messages } from "@/i18n";
import { getT } from "@/i18n/server";
import { requireRoute } from "@/server/data/core";

import { currentViewer } from "../../../lager/_lib/session";
import { PageHead } from "../../_components/page-head";
import { Calculator } from "../_components/calculator";
import { CostNotice } from "../_components/cost-notice";
import { ContentsSection, UndoPackButton } from "../_components/mystery-actions";
import { PackFlow } from "../_components/pack-flow";
import { StockLine } from "../_components/stock-line";
import { loadMysteryDetailFor } from "../_lib/data";
import {
  batchesForPacks,
  defaultPlace,
  maxBatches,
  mysteryCalc,
  packSentence,
  recipeOdds,
} from "../_lib/model";

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getT();
  return { title: t.mystery.title };
}

const SECTION = "flex flex-col gap-4 scroll-mt-28";

type Params = Promise<{ titelId: string }>;
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function one(v: string | string[] | undefined): string | null {
  return typeof v === "string" ? v : Array.isArray(v) ? (v[0] ?? null) : null;
}

/**
 * En egen produkt: Packa överst (mobil först), innehållet som på etiketten (ägare och admin
 * ändrar det, med kalkylen live), kalkylen (kostnad per omgång och pack, pris, vinst och
 * marginal) med notisen när inköpspriset har halkat efter, och senaste packningarna
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
  const m = messages(ctx.locale);
  const f = formatters(ctx.locale);
  // Enkel vy: innehållet, Packa, Ångra, kalkylen och notisen (delägaren köper in). Ingen
  // redigering av innehållet och inga versioner.
  const simple = ctx.viewMode === "simple";
  const kr = (ore: number) => f.kronor(ore / 100);
  const [{ titelId }, sp] = await Promise.all([params, searchParams]);
  if (!/^[0-9a-f-]{36}$/i.test(titelId)) notFound();
  const viewer = await currentViewer();
  const now = new Date(ctx.now);
  const detail = await loadMysteryDetailFor(viewer, titelId, now);
  if (!detail) notFound();
  const { title: t, recipe } = { ...detail, recipe: detail.title.recipe };
  const view = simple ? { ...detail.overview, canEdit: false } : detail.overview;
  // Inköpspriset sätts av den som får ändra priser (ägare och admin), även i Enkel vy.
  const canSetCost = detail.overview.canEdit;

  // ?lager=<id> (länken "Packa 1 omgång nu" vid ett minus) förväljer lagret att packa i.
  const wantedPlace = view.places.find((p) => p.id === one(sp.lager)) ?? null;
  const place = recipe ? (wantedPlace ?? defaultPlace(recipe, view.places, view.byPlace)) : null;
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
  const sentence = packSentence(t.toPack, m);
  // Kalkylen: innehållet × dagens inköpspriser, priset i automaten, vinst och marginal.
  const prices = Object.fromEntries(view.prices);
  const calc =
    recipe && view.seesMoney
      ? mysteryCalc(recipe.batchSize, recipe.items, prices, detail.salePriceOre, detail.fees)
      : null;
  // Sålda pack räknas med titelns eget inköpspris: stämmer det inte med kalkylen visas notisen.
  const differs = calc !== null && calc.perPackOre !== null && calc.perPackOre !== t.currentCostOre;
  const local = (iso: string) => wallClockIn(new Date(iso), ctx.timeZone);
  const nowLocal = wallClockIn(now, ctx.timeZone);

  const aside = recipe
    ? m.mystery.detailAside(
        recipe.batchSize,
        odds && odds.hits > 0 ? Math.round(odds.hitBp / 100) : null,
        cap && place ? cap.batches : null,
        cap && place ? place.name : null,
      )
    : m.mystery.addContentsFirst;

  return (
    <div className="mx-auto flex w-full max-w-[880px] flex-col gap-10 px-4 pt-8 pb-16 md:px-8 md:pt-12">
      <div className="flex flex-col gap-3">
        <Link
          href="/vart-lager/mystery"
          className="meta inline-flex min-h-11 w-fit items-center text-muted hover:text-fg"
        >
          {m.mystery.back}
        </Link>
        <PageHead eyebrow={m.mystery.title} title={t.name} aside={aside} count={false} />
        <StockLine
          titleId={t.id}
          places={view.places}
          inPlaces={t.inPlaces}
          inMachines={t.inMachines}
          batchSize={recipe?.batchSize ?? null}
          canPack={view.canPack}
          canCount={canSetCost}
          t={m}
        />
      </div>

      {recipe && view.canPack ? (
        <section id="packa" aria-labelledby="packa-rubrik" className={SECTION}>
          <h2 id="packa-rubrik" className="text-xl font-medium text-fg">
            {m.mystery.pack}
          </h2>
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
          {m.mystery.contents}
        </h2>
        <ContentsSection
          titleId={t.id}
          recipe={recipe}
          choices={detail.choices}
          canEdit={view.canEdit}
          calc={
            view.seesMoney ? { prices, salePriceOre: detail.salePriceOre, fees: detail.fees } : null
          }
        />
        {detail.versions.length > 0 && !simple ? (
          <p className="meta text-subtle">
            {detail.versions
              .map((v) =>
                m.mystery.version(
                  v.version,
                  f.date(new Date(`${v.validFrom}T12:00:00`), { year: "auto", now: nowLocal }),
                ),
              )
              .join(" · ")}
          </p>
        ) : null}
      </section>

      {calc ? (
        <section id="kalkyl" aria-labelledby="kalkyl-rubrik" className={SECTION}>
          <h2 id="kalkyl-rubrik" className="text-xl font-medium text-fg">
            {m.mystery.calcTitle}
          </h2>
          {differs && calc.perPackOre !== null ? (
            <CostNotice
              titleId={t.id}
              name={t.name}
              currentOre={t.currentCostOre}
              calculatedOre={calc.perPackOre}
              canUpdate={canSetCost}
            />
          ) : null}
          <Calculator calc={calc} lowestIn={detail.salePriceMachine} />
          {calc.missing.length > 0 ? (
            <Link
              href="/inkopspriser"
              className="inline-flex min-h-11 w-fit items-center text-base text-fg underline underline-offset-4"
            >
              {m.mystery.pricesLink}
            </Link>
          ) : null}
        </section>
      ) : null}

      {detail.packings.length > 0 ? (
        <section aria-labelledby="packat-rubrik" className={SECTION}>
          <h2 id="packat-rubrik" className="text-xl font-medium text-fg">
            {m.mystery.recent}
          </h2>
          <ul className="flex flex-col divide-y divide-line rounded-md border border-line">
            {detail.packings.map((p) => (
              <li key={p.id} className="flex min-h-14 items-center justify-between gap-3 px-4 py-2">
                <span className="flex min-w-0 flex-col">
                  <span
                    className={p.undone ? "text-base text-muted line-through" : "text-base text-fg"}
                  >
                    {m.mystery.packingLine(p.batches, p.packs, p.placeName)}
                  </span>
                  <span className="meta text-subtle">
                    {m.mystery.packingMeta(
                      f.dateTime(local(p.packedAt), { year: "auto", now: nowLocal }),
                      simple ? null : p.version,
                    )}
                    {p.costPerPackOre !== null && view.seesMoney
                      ? ` · ${m.sales.perPack(kr(p.costPerPackOre))}`
                      : ""}
                    {p.undone ? m.mystery.packingUndone : ""}
                  </span>
                </span>
                {p.undoable ? <UndoPackButton packingId={p.id} /> : null}
              </li>
            ))}
          </ul>
          {detail.packings.some((p) => p.tooLate) ? (
            <p className="text-base text-muted">
              {m.r2.t1.mystery.tooLateToUndo}{" "}
              {canSetCost ? (
                <Link
                  href="/vart-lager/inventering"
                  className="inline-flex min-h-11 items-center text-fg underline underline-offset-4"
                >
                  {m.r2.t1.mystery.countInstead}
                </Link>
              ) : (
                m.r2.t1.mystery.countInsteadText
              )}
            </p>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}

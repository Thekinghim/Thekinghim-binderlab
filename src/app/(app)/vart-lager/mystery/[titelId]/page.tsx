import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { wallClockIn } from "@/components/shell/period-state";
import { ButtonLink } from "@/components/v2/button";
import { Card, CardBody } from "@/components/v2/card";
import { V2Page, headerDate } from "@/components/v2/shell/page";
import { formatters, messages } from "@/i18n";
import { getT } from "@/i18n/server";
import { requireRoute } from "@/server/data/core";

import { currentViewer } from "../../../lager/_lib/session";
import { Calculator } from "../_components/calculator";
import { CostNotice } from "../_components/cost-notice";
import { ContentsSection, UndoPackButton } from "../_components/mystery-actions";
import { PackFlow } from "../_components/pack-flow";
import { SimpleFrame } from "../_components/simple-frame";
import { StockLine } from "../_components/stock-line";
import { loadMysteryDetailFor } from "../_lib/data";
import "../_components/mystery.css";
import {
  batchesForPacks,
  defaultPlace,
  maxBatches,
  mergedPack,
  mysteryCalc,
  packSentence,
  recipeOdds,
} from "../_lib/model";

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getT();
  return { title: t.mystery.title };
}

/** Korten som länkas till (#packa, #innehall, #kalkyl) hamnar under sidhuvudet. */
const CARD = "scroll-mt-4";

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
  // Minus hemma och ett fack som behöver en omgång: ett besked (i rutan), inte två.
  const merged = view.canPack
    ? mergedPack({
        places: view.places,
        inPlaces: t.inPlaces,
        batchSize: recipe?.batchSize ?? null,
        plan: t.toPack,
        t: m,
      })
    : null;
  const sentence = merged ? null : packSentence(t.toPack, m);
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

  const stockLine = (
    <StockLine
      titleId={t.id}
      places={view.places}
      inPlaces={t.inPlaces}
      inMachines={t.inMachines}
      batchSize={recipe?.batchSize ?? null}
      canPack={view.canPack}
      canCount={canSetCost}
      merged={merged}
      t={m}
    />
  );

  const packCard =
    recipe && view.canPack ? (
      <Card id="packa" title={m.mystery.pack} className={CARD}>
        <CardBody className="mys-body">
          {sentence ? (
            <p
              className={
                sentence.tone === "act"
                  ? "text-v2-md font-[550] text-v2-warn-text"
                  : "text-v2-sm text-v2-mute"
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
        </CardBody>
      </Card>
    ) : null;

  const contentsCard = (
    <Card id="innehall" title={m.mystery.contents} className={CARD}>
      <CardBody className="mys-body">
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
          <p className="mys-mute">
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
      </CardBody>
    </Card>
  );

  const calcCard = calc ? (
    <Card id="kalkyl" title={m.mystery.calcTitle} className={CARD}>
      <CardBody className="mys-body">
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
          <Link href="/inkopspriser" className="mys-link">
            {m.mystery.pricesLink}
          </Link>
        ) : null}
      </CardBody>
    </Card>
  ) : null;

  const packedCard =
    detail.packings.length > 0 ? (
      <Card title={m.mystery.recent} count={detail.packings.length}>
        <ul className="mys-packed">
          {detail.packings.map((p) => (
            <li key={p.id}>
              <span className="min-w-0">
                <b className={p.undone ? "undone" : undefined}>
                  {m.mystery.packingLine(p.batches, p.packs, p.placeName)}
                </b>
                <small>
                  {m.mystery.packingMeta(
                    f.dateTime(local(p.packedAt), { year: "auto", now: nowLocal }),
                    simple ? null : p.version,
                  )}
                  {p.costPerPackOre !== null && view.seesMoney
                    ? ` · ${m.sales.perPack(kr(p.costPerPackOre))}`
                    : ""}
                  {p.undone ? m.mystery.packingUndone : ""}
                </small>
              </span>
              {p.undoable ? <UndoPackButton packingId={p.id} /> : null}
            </li>
          ))}
        </ul>
        {detail.packings.some((p) => p.tooLate) ? (
          <p className="border-t border-v2-line2 px-[18px] py-3 text-v2-sm text-v2-mute max-[900px]:px-4">
            {m.r2.t1.mystery.tooLateToUndo}{" "}
            {canSetCost ? (
              <Link href="/vart-lager/inventering" className="mys-link inline-flex">
                {m.r2.t1.mystery.countInstead}
              </Link>
            ) : (
              m.r2.t1.mystery.countInsteadText
            )}
          </p>
        ) : null}
      </Card>
    ) : null;

  const body = (
    <div className="v2-mystery">
      <div className="max-[900px]:px-1">{stockLine}</div>
      {calcCard ? (
        <div className="v2-cols">
          <div className="v2-stack">
            {packCard}
            {contentsCard}
            {packedCard}
          </div>
          <div className="v2-stack">{calcCard}</div>
        </div>
      ) : (
        <div className="v2-stack">
          {packCard}
          {contentsCard}
          {packedCard}
        </div>
      )}
    </div>
  );

  // Enkel vy: skalets eget huvud på personens språk (V2Page är svensk), samma innehåll.
  if (simple) {
    return (
      <SimpleFrame headline={t.name} aside={aside}>
        <Link
          href="/vart-lager/mystery"
          className="-mt-2 inline-flex min-h-11 w-fit items-center px-0.5 text-v2-sm font-[550] text-v2-mute"
        >
          {m.mystery.back}
        </Link>
        {body}
      </SimpleFrame>
    );
  }
  return (
    <V2Page
      title={t.name}
      date={headerDate(now, ctx.timeZone)}
      sub={aside}
      tools={
        <ButtonLink href="/vart-lager/mystery" touch aria-label="Tillbaka till Mystery packs">
          <span aria-hidden="true">←</span>
          <span className="max-[900px]:hidden">Mystery packs</span>
        </ButtonLink>
      }
    >
      {body}
    </V2Page>
  );
}

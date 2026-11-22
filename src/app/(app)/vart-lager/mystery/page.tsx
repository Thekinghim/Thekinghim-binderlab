import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";

import { Icon } from "@/components/ui/icon";
import { ButtonLink } from "@/components/v2/button";
import { Card, CardBody } from "@/components/v2/card";
import { Empty } from "@/components/v2/empty";
import { V2Page, headerDate } from "@/components/v2/shell/page";
import { SubNav } from "@/components/v2/sub-nav";
import { formatters, messages, type Messages } from "@/i18n";
import { getT } from "@/i18n/server";
import { requireRoute } from "@/server/data/core";

import { currentViewer } from "../../lager/_lib/session";
import { ContentsCard } from "./_components/contents-card";
import { CostNotice } from "./_components/cost-notice";
import { SimpleFrame } from "./_components/simple-frame";
import { StockLine } from "./_components/stock-line";
import "./_components/mystery.css";
import { krAuto } from "./_lib/kr";
import { loadMysteryOverviewFor, type MysteryOverview, type MysteryTitle } from "./_lib/data";
import {
  averageCost,
  defaultPlace,
  maxBatches,
  mergedPack,
  packHref,
  packSentence,
} from "./_lib/model";

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

  const body = (
    <div className="v2-mystery">
      {view.titles.length === 0 ? (
        <Empty
          title={t.mystery.empty}
          className="v2-card"
          action={
            // Enkel vy: "Ägaren lägger in mystery packs", så ingen knapp dit.
            view.canEdit && !simple ? (
              <ButtonLink href="/inkopspriser" variant="act" touch>
                {t.mystery.openPrices}
              </ButtonLink>
            ) : null
          }
        >
          <p>{simple ? t.mystery.emptySimple : t.mystery.emptyDetail}</p>
        </Empty>
      ) : (
        <ul className="mys-list">
          {view.titles.map((title) => (
            <li key={title.id} className="min-w-0">
              <TitleCard view={view} title={title} t={t} canSetCost={canSetCost} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
  const headline = t.mystery.headline(totalHome);

  // Enkel vy: skalets eget huvud på personens språk (V2Page är svensk), samma innehåll.
  if (simple) {
    return (
      <SimpleFrame headline={headline} aside={aside}>
        {body}
      </SimpleFrame>
    );
  }
  return (
    <V2Page
      title={t.mystery.title}
      date={headerDate(new Date(ctx.now), ctx.timeZone)}
      sub={
        <>
          <span>{headline}</span>
          {aside ? <span>{aside}</span> : null}
        </>
      }
    >
      <SubNav />
      {body}
    </V2Page>
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
  // Minus hemma och ett fack som behöver en omgång: ett besked (i rutan), inte två.
  const merged = view.canPack
    ? mergedPack({
        places: view.places,
        inPlaces: t.inPlaces,
        batchSize: t.recipe?.batchSize ?? null,
        plan: t.toPack,
        t: m,
      })
    : null;
  const sentence = merged ? null : packSentence(t.toPack, m);
  const cost = t.recipe && view.seesMoney ? averageCost(t.recipe, view.prices) : null;
  const differs =
    cost?.perPackOre !== null &&
    cost?.perPackOre !== undefined &&
    cost.perPackOre !== t.currentCostOre;

  const action: ReactNode =
    t.recipe && view.canPack ? (
      <ButtonLink href={packHref(t.id, t.toPack?.packs)} variant="act" touch>
        <Icon name="plus" size={14} />
        {m.mystery.pack}
      </ButtonLink>
    ) : !t.recipe && view.canEdit ? (
      <ButtonLink href={`/vart-lager/mystery/${t.id}#innehall`} variant="act" touch>
        Lägg in innehållet
      </ButtonLink>
    ) : null;

  return (
    <Card
      title={
        <Link href={`/vart-lager/mystery/${t.id}`} id={`mp-${t.id}`}>
          {t.name}
        </Link>
      }
      actions={action ?? undefined}
    >
      <CardBody className="mys-body">
        <div className="mys-lines">
          <StockLine
            titleId={t.id}
            places={view.places}
            inPlaces={t.inPlaces}
            inMachines={t.inMachines}
            batchSize={t.recipe?.batchSize ?? null}
            canPack={view.canPack}
            canCount={canSetCost}
            merged={merged}
            t={m}
          />
          {cap ? <p>{cap}</p> : null}
          {sentence ? (
            <p className={sentence.tone === "act" ? "act" : "mute"}>{sentence.text}</p>
          ) : null}
        </div>

        {t.recipe ? (
          <ContentsCard recipe={t.recipe} />
        ) : (
          <p className="mys-mute">{m.mystery.noContents}</p>
        )}

        {cost ? (
          <>
            <p className="mys-mute tnum">
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
          </>
        ) : null}
      </CardBody>
    </Card>
  );
}

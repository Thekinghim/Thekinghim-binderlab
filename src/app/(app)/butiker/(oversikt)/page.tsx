import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { MobileFold } from "@/components/ui/mobile-fold";
import { formatInt, NBSP, SPACED_RANGE_DASH } from "@/lib/format";
import { Suspense } from "react";

import { StoreShareToggle } from "@/components/shell/store-share-toggle";
import { ButtonLink } from "@/components/v2/button";
import { Card, CardBody } from "@/components/v2/card";
import { Empty } from "@/components/v2/empty";
import { Notice } from "@/components/v2/notice";
import { PAGE_BODY, PageIntro } from "@/components/v2/page-intro";
import { V2Page, headerDate } from "@/components/v2/shell/page";
import { SubNav } from "@/components/v2/sub-nav";
import { requireRoute, requireViewer } from "@/server/data/core";

import { StoreKpis } from "../_components/kpis";
import { OwnersView } from "../_components/owners-view";
import { SettlementsView } from "../_components/settlements-view";
import { StoreTable } from "../_components/store-table";
import { loadStoreList } from "../_lib/data";
import { loadStoreFaces } from "../_lib/visual-data";
import {
  activeStores,
  dayText,
  plural,
  prospectStores,
  sek,
  startListHeadline,
  storeStartList,
} from "../_lib/model";
import { StoreStartLists } from "./_components/start-list";
import { loadStoreStartDataSafe } from "./_lib/start-facts";
import { ShopsPage } from "./_components/shops-page";

export const metadata: Metadata = { title: "Butiker" };

/** Fliken Butiksägare (?vy=agare). */
const OWNERS_VIEW = "agare";
/** Fliken Utbetalning (?vy=utbetalning). */
const PAYOUT_VIEW = "utbetalning";
/** Den gamla listan med nyckeltal och startlistor (?vy=lista). */
const LIST_VIEW = "lista";
/** Flikens gamla namn (Butiksportal), som gamla länkar och bokmärken har. */
const PORTAL_VIEW_OLD = "portal";

/** Samma adress med ?vy=utbetalning i stället för ?vy=portal. */
function utbetalningHref(sp: Record<string, string | string[] | undefined>): string {
  const out = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) {
    if (k === "vy" || v === undefined) continue;
    for (const x of Array.isArray(v) ? v : [v]) out.append(k, x);
  }
  out.set("vy", PAYOUT_VIEW);
  return `/butiker?${out.toString()}`;
}

/**
 * Butiker (V2, G4): listan per stad med den valda butiken (./_components/shops-page). De
 * gamla vyerna finns kvar: ?vy=lista (nyckeltal och startlistor), ?vy=utbetalning och
 * ?vy=agare.
 *
 * Gamla listan: alla butiker med periodens intäkt, butiksersättning, ersättningsmodell och
 * vad butiken tjänat hittills i månaden. Ägare, admin och läsare (påfyllaren skickas
 * vidare av requireRoute). Ägare och admin lägger till butiker här; avtal, kontakt och
 * rapportmottagare ändras på butikens sida.
 */
export default async function ButikerPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  // Gamla länkar (?vy=portal, fliken hette Butiksportal) går till Utbetalning med samma
  // parametrar i övrigt.
  if (sp.vy === PORTAL_VIEW_OLD) redirect(utbetalningHref(sp));
  // Butiker → Utbetalning: att betala till butikerna, avräkningarna och längst ner
  // butiksportalens inbjudningar (?vy=utbetalning).
  // Butiker → Butiksägare (?vy=agare): bolagen som äger butikerna.
  if (sp.vy === OWNERS_VIEW) {
    const ctx = await requireRoute("butiker");
    return (
      <V2Page title="Butiksägare" date={headerDate(new Date(ctx.now), ctx.timeZone)}>
        <SubNav />
        <OwnersView viewer={await requireViewer()} canEdit={ctx.canEdit} />
      </V2Page>
    );
  }
  if (sp.vy === PAYOUT_VIEW) {
    const ctx = await requireRoute("butiker");
    return (
      <V2Page title="Utbetalning" date={headerDate(new Date(ctx.now), ctx.timeZone)}>
        <SubNav />
        <SettlementsView viewer={await requireViewer()} today={ctx.today} />
      </V2Page>
    );
  }
  // Rollen kontrolleras här, innan något renderas (påfyllaren skickas till sin startsida).
  await requireRoute("butiker");
  // Den gamla listan (nyckeltal, kontrakt, butiker på väg in) finns kvar på ?vy=lista.
  if (sp.vy === LIST_VIEW) return <LegacyStoreList sp={sp} />;
  return <ShopsPage sp={sp} />;
}

/**
 * Butikslistan med nyckeltal (?vy=lista), i V2: nyckeltal, kontrakt och avtal som saknas,
 * alla butiker i en tabell och butikerna på väg in med sina startlistor.
 */
async function LegacyStoreList({ sp }: { sp: Record<string, string | string[] | undefined> }) {
  const [data, faceMap] = await Promise.all([loadStoreList(sp), loadStoreFaces()]);
  const { ctx, rows, period, headline } = data;
  // Visuellt: butikens symbol (typ och stad) i tabellerna.
  const faces = Object.fromEntries(
    [...faceMap].map(([id, f]) => [id, { storeType: f.storeType, city: f.city }]),
  );
  // I drift: automat i dag eller försäljning. Butiker på väg in visas för sig.
  const active = activeStores(rows);
  const prospects = prospectStores(rows);
  const prospectIds = new Set(prospects.map((r) => r.id));
  const listed = rows.filter((r) => !prospectIds.has(r.id));
  // Startlistan per ny butik: vad saknas innan automaten får stå där?
  const startData =
    prospects.length > 0
      ? await loadStoreStartDataSafe(
          { userId: ctx.user.id, email: ctx.user.email },
          ctx.organization.id,
        )
      : null;
  const startLists = startData
    ? prospects.flatMap((store) => {
        const facts = startData.facts.get(store.id);
        return facts
          ? [storeStartList({ store, facts, freeMachineCode: startData.freeMachineCode })]
          : [];
      })
    : [];
  const days = `${formatInt(period.days)}${NBSP}d`;
  const comparison = period.comparisonLabel ? `Jämfört med ${period.comparisonLabel}` : undefined;
  const earned = active.reduce((n, r) => n + r.earnedMonthOre, 0);
  // Butiker med automat utan signerat kontrakt (röd rad, samma regel som Att göra).
  const unsigned = active.filter((r) => r.issue?.id === "no-contract").length;
  // Butiker med automat men utan avtal någon dag i perioden: de räknas som 0 %.
  const noDeal = listed.filter((r) => r.agreementGap !== null);
  const toStores = listed.reduce((n, r) => n + r.toStoreOre, 0);
  const cov = period.coverage;
  const dataRange =
    cov && period.partial
      ? cov.start === cov.end
        ? dayText(cov.start, ctx.today)
        : `${dayText(cov.start, ctx.today)}${SPACED_RANGE_DASH}${dayText(cov.end, ctx.today)}`
      : null;

  const ctxDate = headerDate(new Date(ctx.now), ctx.timeZone);
  const facts = [
    { label: "Period", value: period.rangeLabel },
    ...(data.scopeLabel ? [{ label: "Filter", value: data.scopeLabel }] : []),
    ...(dataRange ? [{ label: "Data", value: dataRange }] : []),
  ];

  return (
    <V2Page
      title="Butiker"
      date={ctxDate}
      period
      filters
      tools={
        ctx.canEdit ? (
          <ButtonLink href="/butiker/ny" size="md" className="max-md:hidden">
            Ny butik
          </ButtonLink>
        ) : undefined
      }
    >
      <SubNav />
      <div className={PAGE_BODY}>
        <PageIntro
          title={headline.title}
          aside={headline.aside}
          facts={facts}
          actions={
            ctx.canEdit ? (
              // Telefon: Ny butik här (sidhuvudets knapp syns bara på datorn).
              <ButtonLink href="/butiker/ny" touch className="md:hidden">
                Ny butik
              </ButtonLink>
            ) : undefined
          }
        >
          {data.ignoredMachine ? (
            <p className="text-v2-sm text-v2-mute">Automatfiltret gäller inte här.</p>
          ) : null}
        </PageIntro>

        {rows.length === 0 ? (
          <Card title="Butiker">
            <Empty
              title="Inga butiker ännu"
              action={
                ctx.canEdit ? (
                  <ButtonLink href="/butiker/ny" variant="act">
                    Lägg till butik
                  </ButtonLink>
                ) : undefined
              }
            >
              Lägg till butiken, villkoren och automaten på en minut.
            </Empty>
          </Card>
        ) : (
          <>
            <StoreKpis items={data.kpis} label={`Nyckeltal · ${days}`} comparison={comparison} />
            {/* Butikernas andel på begäran; med vald butik visas den alltid. */}
            {data.scopeLabel ? null : (
              <Suspense fallback={null}>
                <StoreShareToggle on={data.showStoreShare} />
              </Suspense>
            )}

            {unsigned > 0 ? (
              <Notice
                tone="critical"
                title={
                  unsigned === 1
                    ? "1 butik saknar signerat kontrakt."
                    : `${formatInt(unsigned)} butiker saknar signerat kontrakt.`
                }
                action={
                  <ButtonLink href="/avtal" size="sm" touch>
                    Kontrakt
                  </ButtonLink>
                }
              />
            ) : null}

            {noDeal.length > 0 ? (
              <div data-no-agreement-banner>
                <Notice
                  tone="critical"
                  title={
                    noDeal.length === 1
                      ? `${noDeal[0]!.name}: ${noDeal[0]!.agreementGap!.short.charAt(0).toLocaleLowerCase("sv-SE")}${noDeal[0]!.agreementGap!.short.slice(1)}.`
                      : `${formatInt(noDeal.length)} butiker saknar avtal och räknas som 0${NBSP}%.`
                  }
                  action={
                    <ButtonLink
                      href={
                        noDeal.length === 1
                          ? `${noDeal[0]!.href}${noDeal[0]!.href.includes("?") ? "&" : "?"}vy=avtal`
                          : "#alla-butiker"
                      }
                      size="sm"
                      touch
                    >
                      {noDeal.length === 1 ? "Lägg in avtal" : "Visa"}
                    </ButtonLink>
                  }
                />
              </div>
            ) : null}

            <section aria-labelledby="alla-butiker" className="v2-card scroll-mt-28">
              <div className="v2-card-hd">
                <h2 id="alla-butiker">Per butik · {days}</h2>
              </div>
              <CardBody className="flex flex-col gap-4">
                <p className="text-v2-md font-[550] text-v2-ink">
                  {data.showStoreShare
                    ? `${sek(earned)} intjänat i ${data.monthLabel}.`
                    : `${sek(toStores)} till butikerna.`}{" "}
                  <span className="font-normal text-v2-mute">
                    {`${formatInt(data.signed)} av ${plural(active.length, "butik", "butiker")} har signerat kontrakt.`}
                  </span>
                </p>
                <StoreTable
                  rows={listed}
                  monthLabel={data.monthLabel}
                  caption={`Butiker, intäkt och till butiken ${period.rangeLabel}`}
                  showStoreShare={data.showStoreShare}
                  showTotal
                  faces={faces}
                />
              </CardBody>
            </section>

            {prospects.length > 0 ? (
              <section aria-labelledby="pa-vag-in" className="v2-card">
                <div className="v2-card-hd">
                  <h2 id="pa-vag-in">På väg in</h2>
                </div>
                <CardBody className="flex flex-col gap-4">
                  <p className="text-v2-md font-[550] text-v2-ink">
                    {startLists.length > 0
                      ? startListHeadline(startLists)
                      : `${plural(prospects.length, "butik", "butiker")} utan automat än.`}{" "}
                    <span className="font-normal text-v2-mute">Räknas inte i siffrorna ovan.</span>
                  </p>
                  {startLists.length > 0 ? (
                    // Syns direkt, också på mobilen: listan är det som ska göras.
                    <StoreStartLists lists={startLists} canEdit={ctx.canEdit} />
                  ) : (
                    <MobileFold
                      summary="På väg in"
                      meta={`${plural(prospects.length, "butik", "butiker")} utan automat`}
                    >
                      <StoreTable
                        rows={prospects}
                        monthLabel={data.monthLabel}
                        caption="Butiker utan automat"
                        showStoreShare={data.showStoreShare}
                        faces={faces}
                      />
                    </MobileFold>
                  )}
                </CardBody>
              </section>
            ) : null}
          </>
        )}
      </div>
    </V2Page>
  );
}

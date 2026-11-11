import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { SectionHeader } from "@/components/ui/section-header";
import { MobileFold } from "@/components/ui/mobile-fold";
import { StateMessage } from "@/components/ui/state-message";
import { formatInt, NBSP, SPACED_RANGE_DASH } from "@/lib/format";
import type React from "react";
import { Suspense } from "react";

import { StoreShareToggle } from "@/components/shell/store-share-toggle";
import { requireRoute, requireViewer } from "@/server/data/core";

import { MobileMore } from "../../_mobil/mobile-more";
import { StoreKpis } from "../_components/kpis";
import { PageHead } from "../_components/page-head";
import { SettlementsView } from "../_components/settlements-view";
import { StoreTable } from "../_components/store-table";
import { loadStoreList } from "../_lib/data";
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

export const metadata: Metadata = { title: "Butiker" };

/** Fliken Utbetalning (?vy=utbetalning). */
const PAYOUT_VIEW = "utbetalning";
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
 * Butiker: alla butiker med periodens intäkt, butiksersättning, ersättningsmodell och
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
  if (sp.vy === PAYOUT_VIEW) {
    const ctx = await requireRoute("butiker");
    return <SettlementsView viewer={await requireViewer()} today={ctx.today} />;
  }
  const data = await loadStoreList(sp);
  const { ctx, rows, period, headline } = data;
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

  return (
    <div className="mx-auto flex w-full max-w-[1280px] flex-col gap-10 px-4 pt-8 pb-16 max-md:gap-7 md:gap-12 md:px-8 md:pt-12">
      <PageHead
        eyebrow={data.scopeLabel ? `Butiker · ${data.scopeLabel}` : "Butiker"}
        title={headline.title}
        aside={headline.aside}
        actions={
          ctx.canEdit ? (
            // Guiden: butik, villkor, automat och kontrakt på en minut. Mobil: bakom "⋯".
            <MobileMore
              label="Fler val för butiker"
              className="max-md:absolute max-md:-top-2 max-md:-right-2"
            >
              <Link
                href="/butiker/ny"
                className="inline-flex h-11 items-center gap-2 rounded-sm border border-inverse bg-inverse px-5 text-base font-medium text-on-inverse transition-colors hover:bg-inverse-hover"
              >
                <span aria-hidden>+</span>
                Ny butik
              </Link>
            </MobileMore>
          ) : undefined
        }
      />

      {rows.length === 0 ? (
        <StateMessage kind="empty" message="Inga butiker ännu." />
      ) : (
        <>
          <div className="rise flex flex-col gap-3" style={{ "--i": 1 } as React.CSSProperties}>
            {data.ignoredMachine ? (
              <p className="meta text-subtle">Automatfiltret gäller inte här.</p>
            ) : null}
            {/* Mobil: hopfällt bakom "Fler siffror" (rubriken har intäkten och vinsten). */}
            <MobileFold summary="Fler siffror" meta={formatInt(data.kpis.length)}>
              <div className="flex flex-col gap-3">
                <StoreKpis
                  items={data.kpis}
                  label={`Nyckeltal · ${days}`}
                  comparison={comparison}
                />
                {/* Butikernas andel på begäran; med vald butik visas den alltid. */}
                {data.scopeLabel ? null : (
                  <Suspense fallback={null}>
                    <StoreShareToggle on={data.showStoreShare} />
                  </Suspense>
                )}
                {dataRange ? <p className="meta text-subtle">Data {dataRange}</p> : null}
              </div>
            </MobileFold>
          </div>

          {unsigned > 0 ? (
            <Link
              href="/avtal"
              className="rise lift flex items-center justify-between gap-3 rounded-md border border-signal-line bg-surface px-4 py-3"
              style={{ "--i": 2 } as React.CSSProperties}
            >
              <span className="flex items-center gap-2 text-base text-fg">
                <span aria-hidden className="size-2 rounded-full bg-signal" />
                {unsigned === 1
                  ? "1 butik saknar signerat kontrakt."
                  : `${formatInt(unsigned)} butiker saknar signerat kontrakt.`}
              </span>
              <span className="text-sm font-medium text-fg">Kontrakt{NBSP}→</span>
            </Link>
          ) : null}

          {noDeal.length > 0 ? (
            <Link
              href={
                noDeal.length === 1
                  ? `${noDeal[0]!.href}${noDeal[0]!.href.includes("?") ? "&" : "?"}vy=avtal`
                  : "#alla-butiker"
              }
              className="rise lift flex items-center justify-between gap-3 rounded-md border border-signal-line bg-surface px-4 py-3"
              style={{ "--i": 2 } as React.CSSProperties}
              data-no-agreement-banner
            >
              <span className="flex items-center gap-2 text-base text-fg">
                <span aria-hidden className="size-2 shrink-0 rounded-full bg-signal" />
                {noDeal.length === 1
                  ? `${noDeal[0]!.name}: ${noDeal[0]!.agreementGap!.short.charAt(0).toLocaleLowerCase("sv-SE")}${noDeal[0]!.agreementGap!.short.slice(1)}.`
                  : `${formatInt(noDeal.length)} butiker saknar avtal och räknas som 0${NBSP}%.`}
              </span>
              <span className="shrink-0 text-sm font-medium text-fg">
                {noDeal.length === 1 ? "Lägg in avtal" : "Visa"}
                {NBSP}→
              </span>
            </Link>
          ) : null}

          <section
            aria-labelledby="alla-butiker"
            className="rise flex flex-col gap-6"
            style={{ "--i": 3 } as React.CSSProperties}
          >
            <SectionHeader
              id="alla-butiker"
              // Mobil: den grå meningen döljs.
              className="max-md:[&_h2>span+span]:hidden"
              size="md"
              eyebrow={`Per butik · ${days}`}
              title={
                data.showStoreShare
                  ? `${sek(earned)} intjänat i ${data.monthLabel}.`
                  : `${sek(toStores)} till butikerna.`
              }
              aside={`${formatInt(data.signed)} av ${plural(active.length, "butik", "butiker")} har signerat kontrakt.`}
            />
            <StoreTable
              rows={listed}
              monthLabel={data.monthLabel}
              caption={`Butiker, intäkt och till butiken ${period.rangeLabel}`}
              showStoreShare={data.showStoreShare}
              showTotal
            />
          </section>

          {prospects.length > 0 ? (
            <section
              aria-labelledby="pa-vag-in"
              className="rise flex flex-col gap-6"
              style={{ "--i": 4 } as React.CSSProperties}
            >
              <SectionHeader
                id="pa-vag-in"
                size="md"
                eyebrow="På väg in"
                title={
                  startLists.length > 0
                    ? startListHeadline(startLists)
                    : `${plural(prospects.length, "butik", "butiker")} utan automat än.`
                }
                aside="Räknas inte i siffrorna ovan."
                // Mobil: den grå meningen döljs.
                className="max-md:[&_h2>span+span]:hidden"
              />
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
                  />
                </MobileFold>
              )}
            </section>
          ) : null}
        </>
      )}
    </div>
  );
}

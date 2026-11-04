import type { Metadata } from "next";
import Link from "next/link";

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
import { activeStores, dayText, plural, prospectStores, sek } from "../_lib/model";

export const metadata: Metadata = { title: "Butiker" };

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
  // Butiker → Butiksportal: avräkningar och inbjudningar (?vy=portal).
  if (sp.vy === "portal") {
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
  const days = `${formatInt(period.days)}${NBSP}d`;
  const comparison = period.comparisonLabel ? `Jämfört med ${period.comparisonLabel}` : undefined;
  const earned = active.reduce((n, r) => n + r.earnedMonthOre, 0);
  // Butiker med automat utan signerat kontrakt (röd rad, samma regel som Att göra).
  const unsigned = active.filter((r) => r.issue?.id === "no-contract").length;
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
                    <StoreShareToggle userKey={ctx.user.id} />
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
                  : "Vår vinst per butik."
              }
              aside={`${formatInt(data.signed)} av ${plural(active.length, "butik", "butiker")} har signerat kontrakt.`}
            />
            <StoreTable
              rows={listed}
              monthLabel={data.monthLabel}
              caption={`Butiker, intäkt och vinst ${period.rangeLabel}`}
              showStoreShare={data.showStoreShare}
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
                title={`${plural(prospects.length, "butik", "butiker")} utan automat än.`}
                aside="Räknas inte i siffrorna ovan."
                className="max-md:hidden"
              />
              {/* Mobil: en rad som fäller ut samma tabell. */}
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
            </section>
          ) : null}
        </>
      )}
    </div>
  );
}

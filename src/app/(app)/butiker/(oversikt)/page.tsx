import type { Metadata } from "next";
import Link from "next/link";

import { SectionHeader } from "@/components/ui/section-header";
import { StateMessage } from "@/components/ui/state-message";
import { formatInt, NBSP, SPACED_RANGE_DASH } from "@/lib/format";
import type React from "react";

import { requireRoute, requireViewer } from "@/server/data/core";

import { StoreKpis } from "../_components/kpis";
import { PageHead } from "../_components/page-head";
import { SettlementsView } from "../_components/settlements-view";
import { StoreTable } from "../_components/store-table";
import { loadStoreList } from "../_lib/data";
import { dayText, plural, sek } from "../_lib/model";

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
  const active = rows.filter((r) => !r.archived);
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
    <div className="mx-auto flex w-full max-w-[1280px] flex-col gap-10 px-4 pt-8 pb-16 md:gap-12 md:px-8 md:pt-12">
      <PageHead
        eyebrow={data.scopeLabel ? `Butiker · ${data.scopeLabel}` : "Butiker"}
        title={headline.title}
        aside={headline.aside}
        actions={
          ctx.canEdit ? (
            // Guiden: butik, villkor, automat och kontrakt på en minut.
            <Link
              href="/butiker/ny"
              className="inline-flex h-11 items-center gap-2 rounded-sm border border-inverse bg-inverse px-5 text-base font-medium text-on-inverse transition-colors hover:bg-inverse-hover"
            >
              <span aria-hidden>+</span>
              Ny butik
            </Link>
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
            <StoreKpis items={data.kpis} label={`Nyckeltal · ${days}`} comparison={comparison} />
            {dataRange ? <p className="meta text-subtle">Data {dataRange}</p> : null}
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
              size="md"
              eyebrow={`Per butik · ${days}`}
              title={`${sek(earned)} intjänat i ${data.monthLabel}.`}
              aside={`${formatInt(data.signed)} av ${plural(active.length, "butik", "butiker")} har signerat kontrakt.`}
            />
            <StoreTable
              rows={rows}
              monthLabel={data.monthLabel}
              caption={`Butiker, intäkt och ersättning ${period.rangeLabel}`}
            />
          </section>
        </>
      )}
    </div>
  );
}

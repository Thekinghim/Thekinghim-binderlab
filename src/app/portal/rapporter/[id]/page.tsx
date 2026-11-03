import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { PrintButton } from "@/components/report/print-button";
import { SectionHeader } from "@/components/ui/section-header";
import { StateMessage } from "@/components/ui/state-message";
import { formatInt } from "@/lib/format";
import { assertStoreReportSafe, type StoreReport } from "@/reports";
import { isWholeMonth, periodText } from "@/reports/text";
import { loadPortalReport } from "@/server/portal/load";
import { requirePortalContext } from "@/server/portal/session";

import { CompensationSection, TitlesHeader, WeeksBlock } from "../../_components/sections";
import { dateTimeText, kr, monthText, pct } from "../../_components/text";

export const metadata: Metadata = { title: "Månadsrapport" };

/**
 * Den sparade rapporten som den skickades: innehållet ur ögonblicksbilden
 * (reports.data_snapshot), inte en ny uträkning. Databasen lämnar bara ut den om
 * den är en butiksrapport för just den här butiken utan förbjudna fält, och
 * assertStoreReportSafe kontrollerar den en gång till här.
 */
export default async function PortalReportPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requirePortalContext();
  const { id } = await params;
  const detail = await loadPortalReport(ctx, id);
  if (!detail) notFound();

  const report = asStoreReport(detail.report, ctx.store.storeId);
  const month = detail.periodStart.slice(0, 7);

  return (
    <div className="flex flex-col py-10 md:py-12">
      <nav
        aria-label="Sökväg"
        className="label flex flex-wrap items-center justify-between gap-3 pb-8 text-subtle"
        data-print="hide"
      >
        <span className="flex items-center gap-2">
          <Link href="/portal/rapporter" className="rounded-xs text-muted hover:text-fg">
            Rapporter
          </Link>
          <span aria-hidden className="text-faint">
            /
          </span>
          <span>{monthText(month)}</span>
        </span>
        <span className="flex items-center gap-2">
          {detail.storagePath ? (
            <a
              href={`/portal/rapporter/${detail.reportId}/pdf`}
              download
              className="inline-flex h-7 items-center rounded-sm border border-line-strong bg-surface px-2.5 text-sm text-fg normal-case transition-colors duration-fast ease-instrument hover:bg-hover"
            >
              Ladda ned PDF
            </a>
          ) : null}
          {report ? <PrintButton /> : null}
        </span>
      </nav>

      {!report ? (
        <div className="flex flex-col gap-8">
          <SectionHeader
            as="h1"
            title={`Månadsrapport ${monthText(month)}.`}
            aside={`Skapad ${dateTimeText(detail.generatedAt, ctx.store.timezone)}.`}
            size="xl"
          />
          <StateMessage
            kind="not-configured"
            message="Rapportens innehåll kan inte visas i portalen."
            detail="Rapporten sparades i ett format som portalen inte visar. Be operatören skicka den till er per e-post."
            action={{ label: "Till översikten", href: "/portal" }}
          />
        </div>
      ) : (
        <article className="flex flex-col">
          <section className="flex flex-col gap-10 pb-16">
            <SectionHeader
              as="h1"
              index={1}
              eyebrow={
                isWholeMonth(report.period)
                  ? `Månadsrapport · ${monthText(report.month)}`
                  : `Rapport · ${periodText(report.period)}`
              }
              title={`${kr(report.sales.revenueOre)} i försäljning.`}
              aside={report.conclusion.text}
              size="xl"
              meta={[
                { label: "Sålda pack", value: formatInt(report.sales.orders) },
                {
                  label: "Snittköp",
                  value:
                    report.sales.averageOrderOre === null ? "–" : kr(report.sales.averageOrderOre),
                },
                { label: "Ersättning", value: kr(report.compensation.totalOre) },
                { label: "Skapad", value: dateTimeText(detail.generatedAt, ctx.store.timezone) },
              ]}
            />
            {report.greeting ? (
              <p className="max-w-2xl border-t border-line pt-6 text-md text-muted">
                {report.greeting}
              </p>
            ) : null}
            <p className="max-w-2xl text-base text-muted">{report.comparison.text}</p>
          </section>

          <CompensationSection
            report={report}
            hasAgreement={report.compensation.model !== "none"}
          />

          <section className="grid gap-x-8 gap-y-12 border-t border-line py-16 lg:grid-cols-12">
            <div className="flex min-w-0 flex-col gap-8 lg:col-span-7">
              <TitlesHeader report={report} />
              <table className="w-full text-base">
                <caption className="sr-only">Mest sålda titlar</caption>
                <thead>
                  <tr className="border-b border-line-strong">
                    <th scope="col" className="label h-9 text-left font-normal text-subtle">
                      Titel
                    </th>
                    <th scope="col" className="label h-9 text-right font-normal text-subtle">
                      Pack
                    </th>
                    <th scope="col" className="label h-9 text-right font-normal text-subtle">
                      Andel
                    </th>
                    <th scope="col" className="label h-9 text-right font-normal text-subtle">
                      Försäljning
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {report.topTitles.map((t) => (
                    <tr key={t.titleId} className="h-11 border-b border-line">
                      <th scope="row" className="pr-4 text-left font-normal text-fg">
                        {t.name}
                      </th>
                      <td className="tnum text-right text-muted">{formatInt(t.orders)}</td>
                      <td className="tnum text-right text-muted">{pct(t.shareBp)}</td>
                      <td className="tnum text-right text-fg">{kr(t.revenueOre)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex min-w-0 flex-col gap-8 lg:col-span-5">
              <WeeksBlock report={report} />
            </div>
          </section>
        </article>
      )}
    </div>
  );
}

/** Rapporten om den är en giltig och säker butiksrapport för butiken, annars null. */
function asStoreReport(value: unknown, storeId: string): StoreReport | null {
  if (!value || typeof value !== "object") return null;
  const r = value as Partial<StoreReport>;
  if (
    r.kind !== "store" ||
    r.store?.id !== storeId ||
    !r.sales ||
    !r.comparison ||
    !r.compensation ||
    !Array.isArray(r.weeks) ||
    !Array.isArray(r.topTitles) ||
    !Array.isArray(r.compensation.steps) ||
    !r.conclusion
  ) {
    return null;
  }
  try {
    assertStoreReportSafe(r as StoreReport);
    return r as StoreReport;
  } catch {
    return null;
  }
}

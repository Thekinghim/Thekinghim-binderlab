import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { PrintButton } from "@/components/report/print-button";
import { ButtonLink } from "@/components/v2/button";
import { Card, CardBody } from "@/components/v2/card";
import { Empty } from "@/components/v2/empty";
import { KpiTile } from "@/components/v2/kpi-tile";
import { Notice } from "@/components/v2/notice";
import { formatInt } from "@/lib/format";
import {
  assertStoreReportSafe,
  isLegacyUnsent,
  storeDetailsOf,
  storeSummary,
  TITLES_ON_REQUEST,
  type StoreReport,
} from "@/reports";
import { isWholeMonth, periodText } from "@/reports/text";
import { loadPortalReport } from "@/server/portal/load";
import { requirePortalContext } from "@/server/portal/session";

import {
  BasisSection,
  CompensationSection,
  TitlesHeader,
  WeeksBlock,
} from "../../_components/sections";
import { PortalPage } from "../../_components/page-head";
import { dateTimeText, kr, monthText, pct } from "../../_components/text";

export const metadata: Metadata = { title: "Butiksrapport" };

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
  // Valet som sparades när rapporten skapades. En äldre rapport utan sparat val visas kort,
  // som alla nya (portalen vet inte om den har skickats). Dess sparade PDF är gjord med den
  // gamla mallen och lämnas inte ut: rapporten skrivs ut härifrån i stället.
  const details = report ? storeDetailsOf(report, false) : false;
  const legacy = report ? isLegacyUnsent(report, false) : false;
  const month = detail.periodStart.slice(0, 7);
  // Hela månader heter månadsrapport; ett eget datum heter butiksrapport med sina dagar.
  const range = { start: detail.periodStart, end: detail.periodEnd };
  const whole = isWholeMonth(range);
  const name = whole ? monthText(month) : periodText(range);

  const created = `Skapad ${dateTimeText(detail.generatedAt, ctx.store.timezone)}`;
  const actions = (
    <>
      <ButtonLink href="/portal/rapporter" touch data-print="hide">
        <span aria-hidden>←</span> Rapporter
      </ButtonLink>
      {detail.storagePath && !legacy ? (
        <a
          href={`/portal/rapporter/${detail.reportId}/pdf`}
          className="v2-btn touch"
          data-print="hide"
        >
          Ladda ned PDF
        </a>
      ) : null}
      {report ? (
        <span data-print="hide">
          <PrintButton />
        </span>
      ) : null}
    </>
  );

  if (!report) {
    return (
      <PortalPage
        title={`${whole ? "Månadsrapport" : "Butiksrapport"} ${name}`}
        sub={`${created}.`}
        actions={actions}
      >
        <Notice
          tone="warning"
          title="Rapportens innehåll kan inte visas i portalen."
          action={<ButtonLink href="/portal">Till översikten</ButtonLink>}
        >
          Rapporten sparades i ett format som portalen inte visar. Be operatören skicka den till er
          per e-post.
        </Notice>
      </PortalPage>
    );
  }

  const tiles = [
    { key: "sales", label: "Försäljning", value: kr(report.sales.revenueOre) },
    { key: "orders", label: "Sålda pack", value: formatInt(report.sales.orders) },
    ...(details
      ? [
          {
            key: "avg",
            label: "Snittköp",
            value: report.sales.averageOrderOre === null ? "–" : kr(report.sales.averageOrderOre),
          },
        ]
      : []),
    { key: "comp", label: "Ersättning", value: kr(report.compensation.totalOre) },
  ];

  return (
    <PortalPage
      title={isWholeMonth(report.period) ? "Månadsrapport" : "Butiksrapport"}
      date={isWholeMonth(report.period) ? monthText(report.month) : periodText(report.period)}
      sub={
        <>
          <b>{`${kr(report.sales.revenueOre)} i försäljning.`}</b> {storeSummary(report, details)}{" "}
          {created}.
        </>
      }
      actions={actions}
    >
      <article className="flex flex-col gap-3.5 max-md:gap-3">
        <div className="v2-band-wrap">
          <div
            className="v2-band"
            style={{ "--cols": tiles.length } as React.CSSProperties}
            aria-label="Rapportens siffror"
          >
            {tiles.map((t) => (
              <KpiTile key={t.key} label={t.label} value={t.value} />
            ))}
          </div>
        </div>

        {report.greeting || report.comparison.text ? (
          <Card>
            <CardBody className="flex flex-col gap-2">
              {report.greeting ? <p className="text-v2-md">{report.greeting}</p> : null}
              <p className="pt-note">{report.comparison.text}</p>
            </CardBody>
          </Card>
        ) : null}

        <div className="v2-cols">
          <div className="v2-stack">
            {details ? (
              <Card title="Mest sålda titlar">
                <CardBody>
                  <TitlesHeader report={report} />
                </CardBody>
                {report.topTitles.length === 0 ? (
                  <Empty
                    className="border-t border-v2-line"
                    title="Inga sålda titlar under perioden."
                  />
                ) : (
                  <div className="v2-table-wrap border-t border-v2-line">
                    <table className="v2-table">
                      <caption className="sr-only">Mest sålda titlar</caption>
                      <thead>
                        <tr>
                          <th scope="col">Titel</th>
                          <th scope="col" className="num">
                            Pack
                          </th>
                          <th scope="col" className="num">
                            Andel
                          </th>
                          <th scope="col" className="num">
                            Försäljning
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {report.topTitles.map((t) => (
                          <tr key={t.titleId}>
                            <th scope="row" className="pr-4 text-left font-[450]">
                              {t.name}
                            </th>
                            <td className="num text-v2-mute">{formatInt(t.orders)}</td>
                            <td className="num text-v2-mute">{pct(t.shareBp)}</td>
                            <td className="num">{kr(t.revenueOre)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </Card>
            ) : null}
            <WeeksBlock report={report} />
            {details ? null : (
              <Card>
                <CardBody>
                  <p className="pt-note">{TITLES_ON_REQUEST}</p>
                </CardBody>
              </Card>
            )}
          </div>
          <div className="v2-stack">
            <CompensationSection
              report={report}
              hasAgreement={report.compensation.model !== "none"}
            />
          </div>
        </div>
        <BasisSection report={report} />
      </article>
    </PortalPage>
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

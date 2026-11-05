import type { Metadata } from "next";
import Link from "next/link";

import { PrintButton } from "@/components/report/print-button";
import { ReportDocument, ReportPage } from "@/components/report/report-document";
import {
  ReportKpiRow,
  ReportNote,
  ReportSection,
  ReportTable,
  ReportTitle,
  splitRows,
  type ReportColumn,
} from "@/components/report/report-blocks";
import { monthEnd, monthStart } from "@/domain";
import { requireRoute, requireViewer } from "@/server/data/core";
import { loadValueFor } from "@/server/varde/load";

import { buildValueView, type ValueRow } from "../../(app)/varde/_lib/view";
import { datePeriod } from "../_components/shared";

export const metadata: Metadata = { title: "Månadsrapport · Värde" };

type SearchParams = Record<string, string | string[] | undefined>;

/** Maskinrader per ark (första arket har mindre plats). */
const ROWS_FIRST = 14;
const ROWS_PER_PAGE = 34;

function columns(head: readonly string[]): ReportColumn<ValueRow>[] {
  return head.map((h, i) => ({
    key: String(i),
    header: h,
    numeric: i > 0,
    render: (row: ValueRow) => row.cells[i] ?? "",
  }));
}

/**
 * Månadsrapporten "Vad Binderlab gett dig" som A4 (skriv ut eller spara som PDF): samma
 * siffror som sidan /varde för vald månad (?manad=ÅÅÅÅ-MM). Bara ägare och admin; bara
 * den aktiva organisationens data (RLS).
 */
export default async function ValueReportPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const [, sp] = await Promise.all([requireRoute("varde"), searchParams]);
  const manad = typeof sp.manad === "string" ? sp.manad : null;
  const data = await loadValueFor(await requireViewer(), manad);
  const view = buildValueView(data);
  const period = data.period ?? { start: monthStart(data.month), end: monthEnd(data.month) };
  const kpis = view.cards.map((c) => ({ label: c.label, value: c.value, context: c.sub }));
  const machinePages = splitRows(view.machines.rows, ROWS_PER_PAGE, ROWS_FIRST);

  return (
    <div className="bl-desk min-h-dvh">
      <div data-print="hide" className="sticky top-0 z-10 border-b border-line bg-bg">
        <div className="mx-auto flex min-h-12 max-w-[1280px] flex-wrap items-center justify-between gap-x-3 gap-y-2 px-4 py-2 md:px-8">
          <nav aria-label="Sökväg" className="label flex min-w-0 items-center gap-2 text-subtle">
            <Link
              href={`/varde?manad=${data.month}`}
              className="shrink-0 rounded-xs text-muted transition-colors duration-fast ease-instrument hover:text-fg"
            >
              Värde
            </Link>
            <span aria-hidden className="text-faint">
              /
            </span>
            <span className="truncate">Månadsrapport · {view.monthLabel}</span>
          </nav>
          <PrintButton />
        </div>
      </div>
      <main className="px-4 py-6 md:px-8 md:py-12 print:p-0">
        <ReportDocument
          title={`Vad Binderlab gett dig · ${view.monthLabel}`}
          recipient={`${data.organizationName}, internt`}
          sender={data.organizationName}
          period={datePeriod(period)}
          generatedAt={new Date()}
          timeZone={data.timeZone}
        >
          <ReportPage className="gap-[8mm]">
            <ReportTitle eyebrow={`Månadsrapport · ${view.monthLabel}`} title={view.headline.title}>
              {view.headline.aside}
            </ReportTitle>
            <ReportKpiRow items={kpis.slice(0, 2)} />
            <ReportKpiRow items={kpis.slice(2)} />
            <ReportSection index={1} eyebrow="Åtgärder" title="Bästa åtgärder.">
              {view.actions.length === 0 ? (
                <ReportNote>Inget att föreslå just nu.</ReportNote>
              ) : (
                <ol className="flex flex-col gap-[2.5mm] text-[11px] leading-[15px]">
                  {view.actions.map((a, i) => (
                    <li key={a.key} className="flex gap-[3mm]">
                      <span className="tnum w-[4mm] text-subtle">{i + 1}</span>
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="font-medium text-fg">{a.title}</span>
                        <span className="text-muted">{a.detail}</span>
                      </span>
                      {a.valueText ? <span className="tnum text-fg">{a.valueText}</span> : null}
                    </li>
                  ))}
                </ol>
              )}
            </ReportSection>
            <ReportSection index={2} eyebrow="Tid" title="Tid sparad." aside={view.cards[1]?.value}>
              <ReportTable
                columns={columns(view.time.head)}
                rows={view.time.rows}
                rowKey={(r) => r.key}
                caption="Sparad tid per uppgift"
              />
            </ReportSection>
          </ReportPage>
          <ReportPage className="gap-[8mm]">
            <ReportSection index={3} eyebrow="Utveckling" title="Månad för månad.">
              <ReportTable
                columns={columns(view.trend.head)}
                rows={view.trend.rows}
                rowKey={(r) => r.key}
                caption="Utveckling per månad"
              />
            </ReportSection>
            <ReportSection index={4} eyebrow="Butiker" title="Per butik.">
              <ReportTable
                columns={columns(view.stores.head)}
                rows={view.stores.rows}
                rowKey={(r) => r.key}
                caption="Per butik"
              />
            </ReportSection>
            <ReportSection index={5} eyebrow="Automater" title="Per automat.">
              <ReportTable
                columns={columns(view.machines.head)}
                rows={machinePages[0] ?? []}
                rowKey={(r) => r.key}
                caption="Per automat"
              />
            </ReportSection>
          </ReportPage>
          {machinePages.slice(1).map((rows, i) => (
            <ReportPage key={i} className="gap-[6mm]">
              <ReportTable
                columns={columns(view.machines.head)}
                rows={rows}
                rowKey={(r) => r.key}
                caption="Per automat (forts.)"
                continued
              />
            </ReportPage>
          ))}
          <ReportPage className="gap-[6mm]">
            <ReportSection index={6} eyebrow="Så räknas det" title="Antaganden.">
              <ul className="flex flex-col gap-[2mm] text-[10.5px] leading-[15px] text-muted">
                {view.assumptions.map((a) => (
                  <li key={a}>{a}</li>
                ))}
              </ul>
            </ReportSection>
            <ReportNote>
              Alla belopp utan moms. Bara {data.organizationName}s egna data. Reglerna står i
              Binderlabs beräkningsdokument (avsnitt 27).
            </ReportNote>
          </ReportPage>
        </ReportDocument>
      </main>
    </div>
  );
}

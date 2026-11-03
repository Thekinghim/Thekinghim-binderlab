import type { Metadata } from "next";
import Link from "next/link";

import { SectionHeader } from "@/components/ui/section-header";
import { StateMessage } from "@/components/ui/state-message";
import { formatInt } from "@/lib/format";
import { loadPortalReports } from "@/server/portal/load";
import { requirePortalContext } from "@/server/portal/session";

import { dateTimeText, monthText } from "../_components/text";
import { isWholeMonth, periodText } from "@/reports/text";

/** "Månadsrapport oktober 2026", eller för eget datum "Rapport 15–31 okt. 2026". */
function portalReportTitle(start: string, end: string): string {
  return isWholeMonth({ start, end })
    ? `Månadsrapport ${monthText(start.slice(0, 7))}`
    : `Rapport ${periodText({ start, end })}`;
}

export const metadata: Metadata = { title: "Rapporter" };

/**
 * Butikens månadsrapporter: de butiksrapporter operatören skapat till just den här
 * butiken (portal_reports). Andra rapporter (bokföring, delägare) syns aldrig här.
 */
export default async function PortalReportsPage() {
  const ctx = await requirePortalContext();
  const reports = await loadPortalReports(ctx);
  const latest = reports[0];

  return (
    <div className="flex flex-col gap-10 py-10 md:py-12">
      <SectionHeader
        as="h1"
        index={1}
        eyebrow="Rapporter"
        size="xl"
        title={
          reports.length === 0
            ? "Inga rapporter än."
            : `${formatInt(reports.length)} ${reports.length === 1 ? "månadsrapport" : "månadsrapporter"}.`
        }
        aside={
          latest
            ? `Senaste gäller ${monthText(latest.periodStart.slice(0, 7))} och skapades ${dateTimeText(latest.generatedAt, ctx.store.timezone)}.`
            : `Operatören skickar en rapport efter varje månad. Den visas här när den är klar.`
        }
      />
      {reports.length === 0 ? (
        <StateMessage
          kind="empty"
          message="Ingen månadsrapport har skapats för butiken än."
          detail="Översikten visar försäljningen och ersättningen löpande under tiden."
          action={{ label: "Till översikten", href: "/portal" }}
        />
      ) : (
        <ul className="flex flex-col border-t border-line-strong">
          {reports.map((r) => (
            <li
              key={r.reportId}
              className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2 border-b border-line py-4"
            >
              <div className="flex min-w-0 flex-col gap-1">
                {r.hasReport ? (
                  <Link
                    href={`/portal/rapporter/${r.reportId}`}
                    className="rounded-xs text-md text-fg underline-offset-4 hover:underline"
                  >
                    {portalReportTitle(r.periodStart, r.periodEnd)}
                  </Link>
                ) : (
                  <span className="text-md text-fg">
                    {portalReportTitle(r.periodStart, r.periodEnd)}
                  </span>
                )}
                <span className="meta text-subtle">
                  Skapad {dateTimeText(r.generatedAt, ctx.store.timezone)}
                </span>
              </div>
              <div className="flex items-baseline gap-4">
                {r.hasReport ? (
                  <Link
                    href={`/portal/rapporter/${r.reportId}`}
                    className="text-sm text-muted underline-offset-4 hover:text-fg hover:underline"
                  >
                    Visa rapporten
                  </Link>
                ) : null}
                {r.hasPdf ? (
                  <a
                    href={`/portal/rapporter/${r.reportId}/pdf`}
                    className="text-sm text-muted underline-offset-4 hover:text-fg hover:underline"
                    download
                  >
                    Ladda ned PDF
                  </a>
                ) : null}
                {!r.hasReport && !r.hasPdf ? (
                  <span className="meta text-subtle">Innehållet kan inte visas här</span>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

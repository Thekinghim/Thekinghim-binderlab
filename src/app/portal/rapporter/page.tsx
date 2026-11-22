import type { Metadata } from "next";
import Link from "next/link";

import { ButtonLink } from "@/components/v2/button";
import { Card } from "@/components/v2/card";
import { Empty } from "@/components/v2/empty";
import { formatInt } from "@/lib/format";
import { loadPortalReports } from "@/server/portal/load";
import { requirePortalContext } from "@/server/portal/session";

import { PortalPage } from "../_components/page-head";
import { dateTimeText, monthText } from "../_components/text";
import { isWholeMonth, periodText } from "@/reports/text";

/** "Månadsrapport oktober 2026", eller för eget datum "Butiksrapport 15–31 okt. 2026". */
function portalReportTitle(start: string, end: string): string {
  return isWholeMonth({ start, end })
    ? `Månadsrapport ${monthText(start.slice(0, 7))}`
    : `Butiksrapport ${periodText({ start, end })}`;
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
    <PortalPage
      title="Rapporter"
      sub={
        <>
          <b>
            {reports.length === 0
              ? "Inga rapporter än."
              : `${formatInt(reports.length)} ${reports.length === 1 ? "månadsrapport" : "månadsrapporter"}.`}
          </b>{" "}
          {latest
            ? `Senaste gäller ${monthText(latest.periodStart.slice(0, 7))} och skapades ${dateTimeText(latest.generatedAt, ctx.store.timezone)}.`
            : `Operatören skickar en rapport efter varje månad. Den visas här när den är klar.`}
        </>
      }
    >
      <Card title="Butiksrapporter">
        {reports.length === 0 ? (
          <Empty
            title="Ingen månadsrapport har skapats för butiken än."
            action={<ButtonLink href="/portal">Till översikten</ButtonLink>}
          >
            Översikten visar försäljningen och ersättningen löpande under tiden.
          </Empty>
        ) : (
          <ul className="pt-list">
            {reports.map((r) => (
              <li key={r.reportId} className="pt-item">
                <div className="t">
                  {r.hasReport ? (
                    <Link
                      href={`/portal/rapporter/${r.reportId}`}
                      className="rounded-v2-sm font-[550] underline-offset-4 hover:underline"
                    >
                      {portalReportTitle(r.periodStart, r.periodEnd)}
                    </Link>
                  ) : (
                    <b>{portalReportTitle(r.periodStart, r.periodEnd)}</b>
                  )}
                  <small>Skapad {dateTimeText(r.generatedAt, ctx.store.timezone)}</small>
                </div>
                <div className="a">
                  {r.hasReport ? (
                    <ButtonLink href={`/portal/rapporter/${r.reportId}`} size="sm" touch>
                      Visa rapporten
                    </ButtonLink>
                  ) : null}
                  {r.hasPdf ? (
                    <a href={`/portal/rapporter/${r.reportId}/pdf`} className="v2-btn sm touch">
                      Ladda ned PDF
                    </a>
                  ) : null}
                  {!r.hasReport && !r.hasPdf ? (
                    <span className="text-v2-xs text-v2-mute">Innehållet kan inte visas här</span>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </PortalPage>
  );
}

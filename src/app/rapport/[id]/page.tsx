import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";

import { StateMessage } from "@/components/ui/state-message";
import { DomainError } from "@/domain";
import { TYPE_LABEL } from "@/server/reports/kinds";
import { fileKindsOf } from "@/server/reports/files";
import { STATUS_LABEL, type ReportStatus } from "@/server/reports/status";
import { currentReportViewer } from "@/server/reports/runtime";
import { getReportFor, ReportError, type ReportDetail } from "@/server/reports/service";
import { AuthorizationError } from "@/server/session";

import { ReportChrome } from "../_components/report-chrome";
import { ReportView } from "../_components/report-view";
import { V2PrintButton } from "../_components/v2-print-button";
import { periodLabel } from "../_components/shared";
import { isWholeMonth } from "@/reports/text";

export const metadata: Metadata = { title: "Rapport" };

const FILE_LABEL = { pdf: "PDF", xlsx: "Excel", sie: "SIE 4" } as const;

/** Statusen som V2-märke: utkast väntar (gult), skickad klar (grönt), övrigt grått. */
const BADGE_TONE: Record<ReportStatus, string> = {
  draft: "warning",
  approved: "info",
  sent: "success",
  superseded: "",
};

/**
 * En sparad rapport i utskriftsläget, renderad ur ögonblicksbilden. Samma sida skrivs ut
 * till PDF av servern (headless Chromium med den inloggades cookies). Kräver inloggning
 * och rollen ägare, admin eller läsare (kontrolleras i getReportFor, och RLS).
 */
export default async function ReportPrintPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const viewer = await currentReportViewer().catch((error: unknown) => {
    if (error instanceof AuthorizationError) redirect("/");
    throw error;
  });
  let report: ReportDetail;
  try {
    report = await getReportFor(viewer, id);
  } catch (error) {
    if (error instanceof ReportError) notFound();
    if (error instanceof AuthorizationError) redirect("/");
    // Underlaget går inte att läsa (äldre eller trasigt format): säg det i stället för ett 500-fel.
    if (error instanceof DomainError) return <UnreadableReport />;
    throw error;
  }
  const s = report.snapshot;
  const scope = s.type === "butik" ? s.store.name : periodLabel(s);
  const range = isWholeMonth(s.period) ? "" : `&fran=${s.period.start}&till=${s.period.end}`;
  const back = `/rapporter?manad=${s.month}&typ=${s.type}${s.type === "butik" ? `&butiken=${s.store.id}` : ""}${range}`;

  return (
    <ReportChrome
      back={{ href: back, label: "Rapporter" }}
      crumb={
        <>
          {TYPE_LABEL[s.type]}
          <small>{scope}</small>
        </>
      }
      actions={
        <>
          <span className={`v2-badge ${BADGE_TONE[report.status]}`}>
            {STATUS_LABEL[report.status]}
          </span>
          {fileKindsOf(s).map((kind) => (
            <a key={kind} href={`/rapport/${report.id}/fil/${kind}`} className="v2-btn touch">
              {FILE_LABEL[kind]}
            </a>
          ))}
          <V2PrintButton>Skriv ut</V2PrintButton>
        </>
      }
    >
      <ReportView snapshot={s} />
    </ReportChrome>
  );
}

/** Rapporten finns men underlaget har ett format som appen inte kan rendera. */
function UnreadableReport() {
  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-[1280px] flex-col gap-6 bg-bg px-4 pt-8 pb-16 md:px-8 md:pt-12">
      <h1 className="sr-only">Rapportens underlag kan inte visas.</h1>
      <StateMessage
        kind="loading-failed"
        message="Rapportens underlag kan inte visas."
        detail="Underlaget har ett format som den här versionen av Binderlab inte läser. Skapa en ny version av rapporten under Rapporter."
        action={{ label: "Till Rapporter", href: "/rapporter" }}
        className="rounded-md border border-line bg-surface"
      />
    </div>
  );
}

import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { PrintButton } from "@/components/report/print-button";
import { ReportStatusTag } from "@/app/(app)/rapporter/_components/report-status";
import { TYPE_LABEL } from "@/server/reports/kinds";
import { fileKindsOf } from "@/server/reports/files";
import { currentReportViewer } from "@/server/reports/runtime";
import { getReportFor, ReportError, type ReportDetail } from "@/server/reports/service";
import { AuthorizationError } from "@/server/session";

import { ReportView } from "../_components/report-view";
import { monthLabel } from "../_components/shared";

export const metadata: Metadata = { title: "Rapport" };

const FILE_LABEL = { pdf: "PDF", xlsx: "Excel", sie: "SIE 4" } as const;

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
    throw error;
  }
  const s = report.snapshot;
  const scope = s.type === "butik" ? s.store.name : monthLabel(s.month);
  const back = `/rapporter?manad=${s.month}&typ=${s.type}${s.type === "butik" ? `&butiken=${s.store.id}` : ""}`;

  return (
    <div className="bl-desk min-h-dvh">
      <div data-print="hide" className="sticky top-0 z-10 border-b border-line bg-bg">
        <div className="mx-auto flex min-h-12 max-w-[1280px] flex-wrap items-center justify-between gap-x-3 gap-y-2 px-4 py-2 md:px-8">
          <nav aria-label="Sökväg" className="label flex min-w-0 items-center gap-2 text-subtle">
            <Link
              href={back}
              className="shrink-0 rounded-xs text-muted transition-colors duration-fast ease-instrument hover:text-fg"
            >
              Rapporter
            </Link>
            <span aria-hidden className="text-faint">
              /
            </span>
            <span className="truncate">
              {TYPE_LABEL[s.type]} · {scope}
            </span>
          </nav>
          <div className="flex flex-wrap items-center gap-2">
            <ReportStatusTag status={report.status} />
            {fileKindsOf(s).map((kind) => (
              <a
                key={kind}
                href={`/rapport/${report.id}/fil/${kind}`}
                className="inline-flex h-7 items-center rounded-sm border border-line-strong bg-surface px-2.5 text-sm text-fg transition-colors duration-fast ease-instrument hover:border-line-control hover:bg-hover"
              >
                {FILE_LABEL[kind]}
              </a>
            ))}
            <PrintButton>Skriv ut</PrintButton>
          </div>
        </div>
      </div>
      <main className="px-4 py-6 md:px-8 md:py-12 print:p-0">
        <ReportView snapshot={s} />
      </main>
    </div>
  );
}

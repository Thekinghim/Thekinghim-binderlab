import type { Metadata } from "next";

import { ReportView } from "@/app/rapport/_components/report-view";
import { monthLabel, monthName } from "@/app/rapport/_components/shared";
import { SectionHeader } from "@/components/ui/section-header";
import { StateMessage } from "@/components/ui/state-message";
import { formatInt } from "@/lib/format";
import { requireRoute } from "@/server/data/core";
import { TYPE_LABEL } from "@/server/reports/kinds";
import { loadReportsPage } from "@/server/reports/page-data";
import { currentReportViewer, serviceStatus } from "@/server/reports/runtime";

import { ArchiveTable } from "./_components/archive-table";
import { RecipientsPanel } from "./_components/recipients-panel";
import { ReportBuilder } from "./_components/report-builder";
import { ReviewPanel } from "./_components/review-panel";
import { ServiceLines } from "./_components/service-lines";
import { when } from "./_components/when";

export const metadata: Metadata = { title: "Rapporter" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function one(v: string | string[] | undefined): string | null {
  return (Array.isArray(v) ? v[0] : v) ?? null;
}

/**
 * Rapporter: butiksrapport, bokföringsunderlag och delägarrapport. Välj typ, månad
 * (förra månaden som standard) och butik, förhandsvisa, skapa ett utkast, godkänn och
 * skicka. Arkivet visar alla rapporter med status. Ägare och admin skapar och skickar;
 * läsaren (delägaren) ser förhandsvisning, arkiv och filer. Påfyllaren skickas vidare.
 */
export default async function RapporterPage({ searchParams }: { searchParams: SearchParams }) {
  await requireRoute("rapporter");
  const sp = await searchParams;
  const viewer = await currentReportViewer();
  const data = await loadReportsPage(viewer, {
    typ: one(sp.typ),
    manad: one(sp.manad),
    period: one(sp.period),
    butiken: one(sp.butiken),
    mottagare: one(sp.mottagare),
  });
  const services = serviceStatus();

  const month = monthLabel(data.month);
  const delivered = data.expected.filter((e) => e.delivered).length;
  const monthReports = data.archive.filter((r) => r.month === data.month);
  const drafts = monthReports.filter((r) => r.status === "draft").length;
  const approved = monthReports.filter((r) => r.status === "approved").length;
  const sentReports = monthReports.filter((r) => r.status === "sent").length;

  const title =
    data.expected.length === 0
      ? `Inga mottagare för ${monthName(data.month)}.`
      : delivered === data.expected.length
        ? `Alla ${formatInt(delivered)} utskick för ${monthName(data.month)} är gjorda.`
        : `${formatInt(delivered)} av ${formatInt(data.expected.length)} utskick för ${monthName(data.month)} är gjorda.`;
  const aside =
    data.expected.length === 0
      ? "Lägg till butiker, bokhållare och delägare under Mottagare."
      : drafts > 0
        ? `${formatInt(drafts)} ${drafts === 1 ? "utkast väntar" : "utkast väntar"} på granskning.`
        : approved > 0
          ? `${formatInt(approved)} ${approved === 1 ? "godkänd rapport väntar" : "godkända rapporter väntar"} på utskick.`
          : delivered === data.expected.length
            ? "Inget väntar."
            : "Skapa utkasten nedan.";

  const preview = data.preview;
  const sentAll = data.archive.filter((r) => r.status === "sent").length;
  const draftAll = data.archive.filter((r) => r.status === "draft").length;
  const scope =
    data.type === "butik"
      ? (data.stores.find((x) => x.id === data.storeId)?.name ?? "ingen butik")
      : month;

  return (
    <div className="mx-auto flex w-full max-w-[1280px] flex-col gap-12 px-4 pt-8 pb-16 md:gap-16 md:px-8 md:pt-12">
      <SectionHeader
        as="h1"
        size="xl"
        eyebrow="Rapporter"
        title={title}
        aside={aside}
        meta={[
          { label: "Månad", value: month },
          { label: "Utkast", value: formatInt(drafts) },
          { label: "Skickade", value: formatInt(sentReports) },
        ]}
      />

      <section aria-labelledby="ny-rapport" className="flex flex-col gap-6">
        <SectionHeader
          id="ny-rapport"
          index={1}
          eyebrow="Ny rapport"
          title={`${TYPE_LABEL[data.type]}, ${scope}.`}
          aside={
            data.current
              ? `Senaste versionen skapades ${when(data.current.generatedAt, viewer.organization.timezone)}.`
              : "Inget utkast ännu för valet."
          }
        />
        <ReportBuilder
          key={`${data.type}-${data.month}-${data.storeId ?? ""}`}
          type={data.type}
          month={data.month}
          months={data.months.map((m) => ({ value: m, label: monthLabel(m) }))}
          stores={data.stores}
          storeId={data.storeId}
          canEdit={data.canEdit}
          canCreate={preview !== null}
          currentId={data.current?.id ?? null}
        />
      </section>

      <section aria-labelledby="forhandsvisning" className="flex flex-col gap-6">
        <SectionHeader
          id="forhandsvisning"
          index={2}
          eyebrow="Förhandsvisning"
          title={preview ? `${TYPE_LABEL[data.type]} för ${month}.` : "Ingen förhandsvisning."}
          aside={preview ? preview.report.conclusion.text : (data.previewError ?? undefined)}
        />
        {preview ? (
          <div className="min-w-0 overflow-hidden rounded-md border border-line">
            <div className="bl-desk p-4 md:p-6">
              <ReportView snapshot={preview} layout="spread" level="embedded" />
            </div>
          </div>
        ) : (
          <StateMessage
            kind="empty"
            message={data.previewError ?? "Det finns inget underlag för valet."}
            action={{ label: "Välj en annan månad", href: "#ny-rapport" }}
          />
        )}
      </section>

      <section aria-labelledby="granska" className="flex flex-col gap-6">
        <SectionHeader
          id="granska"
          index={3}
          eyebrow="Granska och skicka"
          title={
            data.current
              ? data.current.status === "sent"
                ? "Rapporten är skickad."
                : data.current.status === "approved"
                  ? "Godkänd, redo att skicka."
                  : "Utkastet väntar på granskning."
              : "Inget utkast att granska."
          }
          aside={
            data.current
              ? `${formatInt(data.eligible.length)} ${data.eligible.length === 1 ? "mottagare kan" : "mottagare kan"} få rapporten.`
              : "Skapa ett utkast först. Inget skickas utan godkännande."
          }
        />
        <ServiceLines status={services} />
        {data.current ? (
          <ReviewPanel
            key={data.current.id}
            report={data.current}
            recipients={data.eligible}
            canEdit={data.canEdit}
            mailConfigured={services.mail.kind === "resend" && services.mail.configured}
            timeZone={viewer.organization.timezone}
          />
        ) : null}
      </section>

      <section aria-labelledby="arkiv" className="flex flex-col gap-6">
        <SectionHeader
          id="arkiv"
          index={4}
          eyebrow="Arkiv"
          title={`${formatInt(data.archive.length)} ${data.archive.length === 1 ? "rapport" : "rapporter"}.`}
          aside={
            data.archive.length === 0
              ? "Skapade rapporter sparas här med underlag och beräkningsversion."
              : `${formatInt(sentAll)} ${sentAll === 1 ? "skickad" : "skickade"}, ${formatInt(draftAll)} utkast.`
          }
        />
        <ArchiveTable rows={data.archive} timeZone={viewer.organization.timezone} />
      </section>

      <section aria-labelledby="mottagare" className="flex flex-col gap-6">
        <SectionHeader
          id="mottagare"
          index={5}
          eyebrow="Mottagare"
          title={`${formatInt(data.recipients.filter((r) => r.active).length)} aktiva mottagare.`}
          aside={
            data.ownersConfigured
              ? "Butiker, bokhållare och delägare."
              : "Ägarandelar saknas, så delägarrapporten visar ingen vinstfördelning."
          }
        />
        <RecipientsPanel
          recipients={data.recipients}
          stores={data.allStores}
          canEdit={data.canEdit}
          expected={data.expected.map((e) => ({
            id: e.recipient.id,
            delivered: e.delivered,
          }))}
        />
      </section>
    </div>
  );
}

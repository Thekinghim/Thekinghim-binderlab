import type { Metadata } from "next";
import Link from "next/link";

import { ReportView } from "@/app/rapport/_components/report-view";
import { monthLabel, monthName } from "@/app/rapport/_components/shared";
import { SectionHeader } from "@/components/ui/section-header";
import { StateMessage } from "@/components/ui/state-message";
import { formatDate, formatInt } from "@/lib/format";
import { loadSyncInfo, requireRoute } from "@/server/data/core";
import { TYPE_LABEL } from "@/server/reports/kinds";
import { loadReportsPage } from "@/server/reports/page-data";
import { currentReportViewer, serviceStatus } from "@/server/reports/runtime";
import { monthEnd, staleImportDay } from "@/server/reports/status";

import { ArchiveTable } from "./_components/archive-table";
import { RecipientsPanel } from "./_components/recipients-panel";
import { ReportBuilder } from "./_components/report-builder";
import { ReviewPanel } from "./_components/review-panel";
import { ServiceLines } from "./_components/service-lines";
import { pickView, ViewTabs } from "./_components/view-tabs";
import { when } from "./_components/when";

export const metadata: Metadata = { title: "Rapporter" };

function dayDate(date: string): Date {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(y, m - 1, d, 12);
}

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
  const sync = await loadSyncInfo();
  const staleDay = staleImportDay(
    monthEnd(data.month),
    sync?.syncedAt,
    viewer.organization.timezone,
  );

  const month = monthLabel(data.month);
  const delivered = data.expected.filter((e) => e.delivered).length;
  const monthReports = data.archive.filter((r) => r.month === data.month);
  const drafts = monthReports.filter((r) => r.status === "draft").length;
  const approved = monthReports.filter((r) => r.status === "approved").length;
  // Utkast för andra månader väntar också: rubriken och sidopanelen räknar dem.
  const otherDrafts = data.archive.filter((r) => r.month !== data.month && r.status === "draft");

  const title =
    data.expected.length === 0
      ? `Inga mottagare för ${monthName(data.month)}.`
      : delivered === data.expected.length
        ? `Alla ${formatInt(delivered)} utskick för ${monthName(data.month)} är gjorda.`
        : `${formatInt(delivered)} av ${formatInt(data.expected.length)} utskick för ${monthName(data.month)} är gjorda.`;
  const aside =
    data.expected.length === 0
      ? "Lägg till mottagare."
      : drafts > 0
        ? `${formatInt(drafts)} utkast väntar på granskning.`
        : approved > 0
          ? `${formatInt(approved)} ${approved === 1 ? "godkänd rapport väntar" : "godkända rapporter väntar"} på utskick.`
          : otherDrafts.length > 0
            ? `${formatInt(otherDrafts.length)} utkast för ${[
                ...new Set(otherDrafts.map((r) => monthName(r.month))),
              ].join(" och ")} väntar på granskning.`
            : delivered === data.expected.length
              ? "Inget väntar."
              : "Skapa utkasten.";

  const preview = data.preview;
  const sentAll = data.archive.filter((r) => r.status === "sent").length;
  const draftAll = data.archive.filter((r) => r.status === "draft").length;
  const scope =
    data.type === "butik"
      ? (data.stores.find((x) => x.id === data.storeId)?.name ?? "ingen butik")
      : month;

  const VIEWS = ["aktuell", "arkiv", "mottagare"] as const;
  const view = pickView(sp.vy, VIEWS);
  const hrefFor = (v: (typeof VIEWS)[number]) => {
    const q = new URLSearchParams();
    for (const [k, val] of Object.entries(sp)) {
      const x = one(val);
      if (x && k !== "vy") q.set(k, x);
    }
    if (v !== "aktuell") q.set("vy", v);
    const qs = q.toString();
    return qs ? `/rapporter?${qs}` : "/rapporter";
  };
  const activeRecipients = data.recipients.filter((r) => r.active).length;

  return (
    <div className="mx-auto flex w-full max-w-[1280px] flex-col gap-10 px-4 pt-8 pb-16 md:gap-12 md:px-8 md:pt-12">
      <div className="rise flex flex-col gap-6" style={{ "--i": 0 } as React.CSSProperties}>
        <SectionHeader
          as="h1"
          size="xl"
          eyebrow="Rapporter"
          title={title}
          aside={aside}
          meta={[
            { label: "Månad", value: month },
            { label: "Utkast", value: formatInt(drafts + otherDrafts.length) },
          ]}
        />
        <ViewTabs
          label="Vy"
          value={view}
          hrefFor={hrefFor}
          tabs={[
            { value: "aktuell", label: "Aktuell" },
            { value: "arkiv", label: "Arkiv", count: data.archive.length },
            { value: "mottagare", label: "Mottagare", count: activeRecipients },
          ]}
        />
      </div>

      {view === "aktuell" ? (
        <>
          <section
            aria-labelledby="ny-rapport"
            className="rise flex flex-col gap-6"
            style={{ "--i": 1 } as React.CSSProperties}
          >
            <SectionHeader
              id="ny-rapport"
              size="md"
              title={`${TYPE_LABEL[data.type]}, ${scope}.`}
              aside={
                data.current
                  ? `Senaste versionen ${when(data.current.generatedAt, viewer.organization.timezone)}.`
                  : "Inget utkast ännu."
              }
            />
            {staleDay ? (
              <p role="status" className="meta text-signal-fg">
                Senaste synk {formatDate(dayDate(staleDay), { year: "auto" })}. Order efter det
                saknas.
                {data.canEdit ? (
                  <Link
                    href="/datakallor"
                    className="ml-2 text-fg underline-offset-4 hover:underline"
                  >
                    Datakällor →
                  </Link>
                ) : null}
              </p>
            ) : null}
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

          {data.current ? (
            <section
              aria-labelledby="granska"
              className="rise flex flex-col gap-6"
              style={{ "--i": 2 } as React.CSSProperties}
            >
              <SectionHeader
                id="granska"
                size="md"
                title={
                  data.current.status === "sent"
                    ? "Rapporten är skickad."
                    : data.current.status === "approved"
                      ? "Godkänd, redo att skicka."
                      : "Utkastet väntar på granskning."
                }
                aside={`${formatInt(data.eligible.length)} mottagare.`}
              />
              <ServiceLines status={services} />
              <ReviewPanel
                key={data.current.id}
                report={data.current}
                recipients={data.eligible}
                canEdit={data.canEdit}
                mailConfigured={services.mail.kind === "resend" && services.mail.configured}
                timeZone={viewer.organization.timezone}
              />
            </section>
          ) : null}

          <section
            aria-labelledby="forhandsvisning"
            className="rise flex flex-col gap-6"
            style={{ "--i": 3 } as React.CSSProperties}
          >
            <SectionHeader
              id="forhandsvisning"
              size="md"
              title={preview ? `Förhandsvisning, ${month}.` : "Ingen förhandsvisning."}
              aside={preview ? preview.report.conclusion.text : undefined}
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
                compact
                message={data.previewError ?? "Inget underlag för valet."}
                action={{ label: "Välj en annan månad", href: "#ny-rapport" }}
              />
            )}
          </section>
        </>
      ) : null}

      {view === "arkiv" ? (
        <section
          aria-labelledby="arkiv"
          className="rise flex flex-col gap-6"
          style={{ "--i": 1 } as React.CSSProperties}
        >
          <SectionHeader
            id="arkiv"
            size="md"
            title={`${formatInt(data.archive.length)} ${data.archive.length === 1 ? "rapport" : "rapporter"}.`}
            aside={
              data.archive.length === 0
                ? undefined
                : `${formatInt(sentAll)} ${sentAll === 1 ? "skickad" : "skickade"}, ${formatInt(draftAll)} utkast.`
            }
          />
          <ArchiveTable rows={data.archive} timeZone={viewer.organization.timezone} />
        </section>
      ) : null}

      {view === "mottagare" ? (
        <section
          aria-labelledby="mottagare"
          className="rise flex flex-col gap-6"
          style={{ "--i": 1 } as React.CSSProperties}
        >
          <SectionHeader
            id="mottagare"
            size="md"
            title={`${formatInt(activeRecipients)} aktiva mottagare.`}
            aside={data.ownersConfigured ? undefined : "Ägarandelar saknas för delägarrapporten."}
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
      ) : null}
    </div>
  );
}

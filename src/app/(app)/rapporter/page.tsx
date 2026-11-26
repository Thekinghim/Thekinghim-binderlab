import type { Metadata } from "next";

import { ReportView } from "@/app/rapport/_components/report-view";
import { monthLabel, monthName, sek } from "@/app/rapport/_components/shared";
import { ButtonLink } from "@/components/v2/button";
import { Empty } from "@/components/v2/empty";
import { Notice } from "@/components/v2/notice";
import { V2Page, headerDate } from "@/components/v2/shell/page";
import { SubNav } from "@/components/v2/sub-nav";
import { formatDate, formatInt } from "@/lib/format";
import { MISSING_PRICES_MESSAGE, periodText } from "@/reports";
import { loadMasterData, loadSyncInfo, requireRoute } from "@/server/data/core";
import { TYPE_LABEL } from "@/server/reports/kinds";
import { loadReportsPage } from "@/server/reports/page-data";
import { currentReportViewer, serviceStatus } from "@/server/reports/runtime";
import { reportShareMode, shareHeadline } from "@/server/reports/share-mode";
import { DONE_DELIVERY, monthEnd, staleImportDay } from "@/server/reports/status";

import { ArchiveTable } from "./_components/archive-table";
import { RecipientsPanel } from "./_components/recipients-panel";
import { ReportBuilder } from "./_components/report-builder";
import { ReviewPanel } from "./_components/review-panel";
import { ServiceLines } from "./_components/service-lines";
import { ShareFlow } from "./_components/share-flow";
import { pickView, ViewTabs } from "./_components/view-tabs";
import { when } from "./_components/when";
import { ownerReportChoices } from "./_lib/owner-choices";
import { bookkeepingOverlap } from "./_lib/overlap";

import "./_components/reports.css";

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
  const ctx = await requireRoute("rapporter");
  const sp = await searchParams;
  const viewer = await currentReportViewer();
  const data = await loadReportsPage(viewer, {
    typ: one(sp.typ),
    manad: one(sp.manad),
    period: one(sp.period),
    butiken: one(sp.butiken),
    mottagare: one(sp.mottagare),
    fran: one(sp.fran),
    till: one(sp.till),
  });
  const services = serviceStatus();
  const [sync, master] = await Promise.all([loadSyncInfo(), loadMasterData()]);
  const staleDay = staleImportDay(
    data.range?.end ?? monthEnd(data.month),
    sync?.demo ? null : sync?.syncedAt,
    viewer.organization.timezone,
  );

  const month = monthLabel(data.month);
  // Det som visas: månaden eller det egna datumet ("15–31 okt. 2026").
  const shown = data.range ? periodText(data.range) : month;
  const delivered = data.expected.filter((e) => e.delivered).length;
  const monthReports = data.archive.filter((r) => r.month === data.month);
  const drafts = monthReports.filter((r) => r.status === "draft").length;
  const approved = monthReports.filter((r) => r.status === "approved").length;
  // Utkast för andra månader väntar också: rubriken och sidopanelen räknar dem.
  const otherDrafts = data.archive.filter((r) => r.month !== data.month && r.status === "draft");

  // Dela-läget: ingen riktig e-post, så ägaren delar rapporten själv (iPhones dela-meny).
  const shareMode = reportShareMode();
  const storeName =
    data.type === "butik" ? (data.stores.find((x) => x.id === data.storeId)?.name ?? null) : null;
  const shared = data.current?.status === "sent";
  const lastDone = data.current?.deliveries.filter((d) => DONE_DELIVERY.has(d.status)).at(-1);
  // Ett gammalt utkast går inte att godkänna, och en äldre rapport (gamla mallen) skickas
  // inte: Dela skapar en ny version i stället.
  const shareable =
    data.current && !data.current.legacy && !(data.current.status === "draft" && data.currentStale)
      ? data.current
      : null;

  const mailTitle =
    data.expected.length === 0
      ? `Inga mottagare för ${monthName(data.month)}.`
      : delivered === data.expected.length
        ? `Alla ${formatInt(delivered)} utskick för ${monthName(data.month)} är gjorda.`
        : `${formatInt(delivered)} av ${formatInt(data.expected.length)} utskick för ${monthName(data.month)} är gjorda.`;
  const mailAside =
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
  const title = !shareMode
    ? mailTitle
    : preview
      ? shareHeadline({
          type: data.type,
          label: data.range ? periodText(data.range) : monthName(data.month),
          custom: data.range !== null,
          storeName,
          shared,
        })
      : `Ingen rapport för ${data.range ? periodText(data.range) : monthName(data.month)}.`;
  const aside = !shareMode
    ? mailAside
    : preview?.type === "butik"
      ? `Ersättning ${sek(preview.report.compensation.totalOre)}.`
      : preview
        ? undefined
        : (data.previewError ?? "Inget underlag för valet.");
  const sentAll = data.archive.filter((r) => r.status === "sent").length;
  const draftAll = data.archive.filter((r) => r.status === "draft").length;
  const scope =
    data.type === "butik"
      ? (data.stores.find((x) => x.id === data.storeId)?.name ?? "ingen butik")
      : shown;

  const VIEWS = ["aktuell", "arkiv", "mottagare"] as const;
  // Dela-läget har inga mottagare: fliken finns inte, och en gammal länk dit visar Aktuell.
  const picked = pickView(sp.vy, VIEWS);
  const view = shareMode && picked === "mottagare" ? "aktuell" : picked;
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

  const builderKey = `${data.type}-${data.month}-${data.range?.start ?? ""}-${data.range?.end ?? ""}-${data.storeId ?? ""}`;

  return (
    <V2Page
      title="Rapporter"
      date={headerDate(new Date(ctx.now), ctx.timeZone)}
      sub={
        <>
          <b>{title}</b>
          {aside ? <span>{aside}</span> : null}
        </>
      }
    >
      <SubNav />
      <div className="v2-reports">
        <div className="rp-bar">
          <ViewTabs
            label="Vy"
            value={view}
            hrefFor={hrefFor}
            tabs={[
              { value: "aktuell", label: "Aktuell" },
              { value: "arkiv", label: "Arkiv", count: data.archive.length },
              ...(shareMode
                ? []
                : [{ value: "mottagare" as const, label: "Mottagare", count: activeRecipients }]),
            ]}
          />
          <p className="rp-meta">
            <span>
              {data.range ? "Period" : "Månad"} <b>{shown}</b>
            </span>
            <span>
              Utkast <b>{formatInt(drafts + otherDrafts.length)}</b>
            </span>
          </p>
        </div>

        {shareMode && view === "aktuell" && preview && data.canEdit ? (
          <ShareFlow
            key={builderKey}
            target={{
              type: data.type,
              month: data.month,
              storeId: data.storeId,
              from: data.range?.start ?? null,
              to: data.range?.end ?? null,
            }}
            reportId={shareable?.id ?? null}
            approved={shareable?.status === "approved" || shareable?.status === "sent"}
            shared={shared}
            sharedText={
              shared && lastDone
                ? `Skickad ${when(lastDone.sentAt ?? lastDone.createdAt, viewer.organization.timezone)}.`
                : null
            }
            title={`${TYPE_LABEL[data.type]} ${shown}${storeName ? `, ${storeName}` : ""}`}
            portal={data.storeHasPortal}
          />
        ) : null}

        {view === "aktuell" ? (
          <>
            <section aria-labelledby="ny-rapport" className="v2-card">
              <div className="v2-card-hd">
                <h2 id="ny-rapport">{`${TYPE_LABEL[data.type]}, ${scope}.`}</h2>
                <span className="rp-hd-note">
                  {[
                    preview?.type === "butik"
                      ? `Ersättning ${sek(preview.report.compensation.totalOre)}.`
                      : null,
                    data.current
                      ? `Senast ${when(data.current.generatedAt, viewer.organization.timezone)}.`
                      : "Inget utkast ännu.",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                </span>
              </div>
              <div className="v2-card-body flex flex-col gap-4">
                {staleDay ? (
                  <div role="status">
                    <Notice
                      tone="warning"
                      title={`Data från Awish senast ${formatDate(dayDate(staleDay), { year: "auto" })}.`}
                      action={
                        data.canEdit ? (
                          <ButtonLink href="/datakallor" size="sm" touch>
                            Datakällor
                          </ButtonLink>
                        ) : null
                      }
                    >
                      Senare order saknas.
                    </Notice>
                  </div>
                ) : null}
                <ReportBuilder
                  key={builderKey}
                  type={data.type}
                  month={data.month}
                  range={data.range}
                  rangeProblem={data.rangeError}
                  today={data.today}
                  months={data.months.map((m) => ({ value: m, label: monthLabel(m) }))}
                  stores={data.stores}
                  storeId={data.storeId}
                  owners={ownerReportChoices(master.owners ?? [], master.stores, data.stores)}
                  canEdit={data.canEdit}
                  canCreate={preview !== null}
                  currentId={data.current?.id ?? null}
                  overlap={bookkeepingOverlap({
                    type: data.type,
                    range: data.range,
                    month: data.month,
                    today: data.today,
                    archive: data.archive,
                  })}
                />
              </div>
            </section>

            {data.current ? (
              <section aria-labelledby="granska" className="v2-card">
                <div className="v2-card-hd">
                  <h2 id="granska">
                    {data.current.status === "sent"
                      ? "Rapporten är skickad."
                      : data.current.legacy
                        ? "Rapporten har den gamla mallen."
                        : data.current.status === "approved"
                          ? shareMode
                            ? "Godkänd, redo att dela."
                            : "Godkänd, redo att skicka."
                          : data.currentStale
                            ? "Utkastet är gammalt."
                            : "Utkastet väntar på granskning."}
                  </h2>
                  {shareMode ? null : (
                    <span className="rp-hd-note">{`${formatInt(data.eligible.length)} mottagare.`}</span>
                  )}
                </div>
                <div className="v2-card-body flex flex-col gap-4">
                  <ServiceLines status={services} hideMail={shareMode} />
                  <ReviewPanel
                    key={data.current.id}
                    report={data.current}
                    stale={data.currentStale}
                    recipients={data.eligible}
                    canEdit={data.canEdit}
                    mailConfigured={services.mail.kind === "resend" && services.mail.configured}
                    shareMode={shareMode}
                    timeZone={viewer.organization.timezone}
                  />
                </div>
              </section>
            ) : null}

            <section aria-labelledby="forhandsvisning" className="v2-card">
              <div className="v2-card-hd">
                <h2 id="forhandsvisning">
                  {preview ? `Förhandsvisning, ${shown}.` : "Ingen förhandsvisning."}
                </h2>
              </div>
              {preview ? (
                <div className="rp-preview">
                  <ReportView snapshot={preview} layout="spread" level="embedded" />
                </div>
              ) : (
                <Empty
                  title={data.previewError ?? "Inget underlag för valet."}
                  action={
                    data.previewError?.startsWith(MISSING_PRICES_MESSAGE) ? (
                      <ButtonLink href="/inkopspriser?saknar=pris" variant="act" touch>
                        Lägg in inköpspriser
                      </ButtonLink>
                    ) : (
                      <ButtonLink href="#ny-rapport" touch>
                        Välj en annan månad
                      </ButtonLink>
                    )
                  }
                />
              )}
            </section>
          </>
        ) : null}

        {view === "arkiv" ? (
          <section aria-labelledby="arkiv" className="v2-card">
            <div className="v2-card-hd">
              <h2 id="arkiv">
                {`${formatInt(data.archive.length)} ${data.archive.length === 1 ? "rapport" : "rapporter"}.`}
              </h2>
              {data.archive.length === 0 ? null : (
                <span className="rp-hd-note">
                  {`${formatInt(sentAll)} ${sentAll === 1 ? "skickad" : "skickade"}, ${formatInt(draftAll)} utkast.`}
                </span>
              )}
            </div>
            <div className="rp-table">
              <ArchiveTable rows={data.archive} timeZone={viewer.organization.timezone} />
            </div>
          </section>
        ) : null}

        {view === "mottagare" ? (
          <section aria-labelledby="mottagare" className="v2-card">
            <div className="v2-card-hd">
              <h2 id="mottagare">{`${formatInt(activeRecipients)} aktiva mottagare.`}</h2>
              {data.ownersConfigured ? null : (
                <span className="rp-hd-note">Ägarandelar saknas för delägarrapporten.</span>
              )}
            </div>
            <div className="v2-card-body">
              <RecipientsPanel
                recipients={data.recipients}
                stores={data.allStores}
                canEdit={data.canEdit}
                expected={data.expected.map((e) => ({
                  id: e.recipient.id,
                  delivered: e.delivered,
                }))}
              />
            </div>
          </section>
        ) : null}
      </div>
    </V2Page>
  );
}

import type { Metadata } from "next";
import Link from "next/link";
import type React from "react";

import type { ContractReminder, ContractStatus, ExpiringCategory } from "@/analytics/contracts";
import { Panel, PanelSection } from "@/components/ui/frame";
import { SectionHeader } from "@/components/ui/section-header";
import { StateMessage } from "@/components/ui/state-message";
import { StatusTag, type Status } from "@/components/ui/status-tag";
import { cn } from "@/lib/cn";
import { formatDate, formatInt, formatPercent } from "@/lib/format";
import {
  currentViewer,
  loadContractsFor,
  type AgreementRecord,
  type ContractRecord,
} from "@/server/accounting";
import {
  contractStatus,
  loadContractSetupFor,
  loadContractSignaturesFor,
  loadContractStatusesFor,
  type ContractStatus as TemplateStatus,
} from "@/server/contracts";
import { loadMasterData, requireRoute } from "@/server/data/core";

import { pickTab, ViewTabs } from "../automater/_components/view-tabs";
import { PageHead } from "../butiker/_components/page-head";
import { EvidenceDetails } from "../ekonomi/_components/evidence";
import { isoToDate, periodText, plural, sek } from "../ekonomi/_lib/view";
import { ContractArchive } from "./_components/contract-archive";
import { ContractDialog } from "./_components/contract-dialog";
import { ContractFileUpload } from "./_components/contract-file";
import { ContractNextStep } from "./_components/contract-status";
import { CreateContract } from "./_components/create-contract";
import { SignOnSite } from "./_components/sign-on-site";
import { buildContractRows, contractHeadline, ROW_STATUS, type ContractRow } from "./_lib/model";
import type { AgreementOption, ContractDraft } from "./_lib/types";

export const metadata: Metadata = { title: "Kontrakt" };

/** Skapa kontrakt skriver ut PDF:en med Chromium i server action. */
export const maxDuration = 60;

const TABS = [
  { value: "lista", label: "Kontrakt" },
  { value: "uppsagning", label: "Uppsägning" },
  { value: "intakt", label: "Intäkt" },
  { value: "arkiv", label: "Arkiv" },
] as const;

const REMINDER: Record<ContractStatus, { status: Status; label: string }> = {
  "not-started": { status: "neutral", label: "Ej påbörjat" },
  "open-ended": { status: "ok", label: "Tills vidare" },
  scheduled: { status: "ok", label: "Gäller" },
  due: { status: "warning", label: "Säg upp eller förläng" },
  "notice-passed": { status: "neutral", label: "Uppsägningstid passerad" },
  terminated: { status: "offline", label: "Uppsagt" },
  expired: { status: "offline", label: "Utgånget" },
};

const CATEGORY: Record<ExpiringCategory, string> = {
  expiring: "Löper ut inom 12 mån",
  secure: "Längre eller tills vidare",
  "no-contract": "Inget kontrakt",
};

const TONE: Record<ContractRow["status"], string> = {
  missing: "border-signal-line text-signal-fg",
  draft: "border-line-control text-fg",
  sent: "border-line-control text-fg",
  due: "border-line-control text-fg",
  terminated: "border-dashed border-line-control text-muted",
  upcoming: "border-up-line text-up",
  signed: "border-up-line text-up",
};

/** Kontraktsdatum skrivs alltid med år (ett kontrakt löper ofta över årsskiftet). */
function day(date: string): string {
  return formatDate(isoToDate(date), { year: "always" });
}

function termsLabel(a: AgreementRecord): string {
  const parts: string[] = [];
  if (a.commissionBp !== null)
    parts.push(
      a.commissionBase === "profit_after_costs"
        ? `vinstdelning ${formatPercent(a.commissionBp / 10_000, 1)}`
        : `provision ${formatPercent(a.commissionBp / 10_000, 1)}`,
    );
  if (a.monthlyRentOre !== null) parts.push(`hyra ${sek(a.monthlyRentOre)}/mån`);
  const text = parts.join(" · ");
  return text.charAt(0).toLocaleUpperCase("sv-SE") + text.slice(1);
}

function agreementPeriod(a: AgreementRecord): string {
  return a.validTo
    ? periodText({ start: a.validFrom, end: a.validTo })
    : `${formatDate(isoToDate(a.validFrom), { year: "always" })} – tills vidare`;
}

function draftOf(c: ContractRecord, agreements: AgreementRecord[]): ContractDraft {
  const str = (v: number | null) => (v === null ? "" : String(v));
  return {
    id: c.id,
    storeId: c.storeId,
    title: c.title ?? "",
    validFrom: c.validFrom,
    validTo: c.validTo ?? "",
    noticePeriodMonths: str(c.noticePeriodMonths),
    noticePeriodDays: str(c.noticePeriodDays),
    renewalMonths: str(c.renewalMonths),
    terminatedOn: c.terminatedOn ?? "",
    terms: c.terms ?? "",
    note: c.note ?? "",
    agreementIds: agreements.filter((a) => a.contractId === c.id).map((a) => a.id),
  };
}

function noticeText(c: ContractRecord): string {
  const parts: string[] = [];
  if (c.noticePeriodMonths) parts.push(plural(c.noticePeriodMonths, "månad", "månader"));
  if (c.noticePeriodDays) parts.push(plural(c.noticePeriodDays, "dag", "dagar"));
  return parts.length > 0 ? parts.join(" och ") : "Ingen";
}

const link =
  "inline-flex h-9 items-center gap-1.5 rounded-sm px-2.5 text-sm text-fg underline-offset-4 hover:underline";

/**
 * Kontrakt: "X av Y butiker har signerat kontrakt", stor knapp Skapa kontrakt och en lista
 * Butik · villkor i klartext · status · PDF. Butik med automat utan signerat kontrakt är
 * röd. Uppsägning, intäkt och arkiv ligger under egna flikar. Ägare, admin och läsare;
 * ägare och admin ändrar.
 */
export default async function KontraktPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const ctx = await requireRoute("avtal");
  const sp = await searchParams;
  const viewer = await currentViewer();
  const canEdit = ctx.canEdit;
  const [data, statuses, setup, signatures, master] = await Promise.all([
    loadContractsFor(viewer, ctx.today),
    loadContractStatusesFor(viewer),
    canEdit ? loadContractSetupFor(viewer) : null,
    loadContractSignaturesFor(viewer),
    loadMasterData(),
  ]);
  const tab = pickTab(TABS, sp.vy);
  // ?skapa=store:{id} | lead:{id} (ett bart id räknas som butik).
  const skapaRaw = typeof sp.skapa === "string" ? sp.skapa : undefined;
  const skapa = skapaRaw && !skapaRaw.includes(":") ? `store:${skapaRaw}` : skapaRaw;
  const firstContract = ![...statuses.values()].some((st) => st.template !== null);
  const statusOf = (id: string): TemplateStatus | null => {
    const st = statuses.get(id);
    return st ? contractStatus(st) : null;
  };
  const o = data.overview;
  const storeName = new Map(data.stores.map((s) => [s.id, s.name]));
  const contractById = new Map(data.contracts.map((c) => [c.id, c]));
  const reminderOf = new Map<string, ContractReminder>(
    data.reminders.reminders.map((r) => [r.contractId, r]),
  );
  const archivedContracts = data.contracts.filter((c) => c.archived);
  const stores = data.stores.filter((s) => !s.archived).map((s) => ({ id: s.id, name: s.name }));
  const agreementOptions: AgreementOption[] = data.agreements.map((a) => ({
    id: a.id,
    storeId: a.storeId,
    contractId: a.contractId,
    label: termsLabel(a),
    period: agreementPeriod(a),
  }));
  const due = data.reminders.due;
  const withMachine = new Set(
    master.machines.filter((m) => !m.archived && m.storeId).map((m) => m.storeId as string),
  );
  const list = buildContractRows({
    stores,
    contracts: data.contracts.map((c) => ({
      id: c.id,
      storeId: c.storeId,
      validFrom: c.validFrom,
      validTo: c.validTo,
      noticeMonths: c.noticePeriodMonths,
      noticeDays: c.noticePeriodDays,
      renewalMonths: c.renewalMonths,
      terminatedOn: c.terminatedOn,
      template: statuses.get(c.id)?.template ?? null,
      sentAt: statuses.get(c.id)?.sentAt ?? null,
      signedAt: statuses.get(c.id)?.signedAt ?? null,
      hasFile: c.hasFile,
      archived: c.archived,
    })),
    agreements: data.agreements,
    reminders: new Map(data.reminders.reminders.map((r) => [r.contractId, r.status])),
    due: new Set(due.map((r) => r.contractId)),
    withMachine,
    today: ctx.today,
  });
  const missing = list.total - list.signed;
  // Andra raden: nästa åtgärd (listan står redan med röda först), inte samma tal igen.
  const firstAlert = missing > 0 ? (list.rows.find((r) => r.alert) ?? null) : null;
  const firstOfStore = new Set<string>();
  const rise = (i: number) => ({ "--i": i }) as React.CSSProperties;

  return (
    <div className="mx-auto flex w-full max-w-[1100px] flex-col gap-8 px-4 pt-8 pb-16 md:gap-10 md:px-8 md:pt-12">
      <PageHead
        eyebrow="Kontrakt"
        title={contractHeadline(list.signed, list.total)}
        tone={list.total === 0 ? undefined : missing === 0 ? "good" : "bad"}
        aside={firstAlert ? `Först: ${firstAlert.storeName}.` : undefined}
        actions={
          canEdit && setup ? (
            <CreateContract
              key={skapa ?? "ny"}
              options={setup.options}
              operator={setup.operator}
              today={ctx.today}
              orgNumberMissing={setup.orgNumberMissing}
              firstContract={firstContract}
              initialTarget={skapa}
              autoOpen={Boolean(skapa)}
              large
            />
          ) : undefined
        }
      />

      <div className="rise" style={rise(1)}>
        <ViewTabs tabs={TABS} value={tab} basePath="/avtal" query="" label="Visa" />
      </div>

      <div key={tab} className="fade-in flex flex-col gap-8">
        {tab === "lista" ? (
          list.rows.length === 0 ? (
            <StateMessage kind="empty" message="Inga butiker än." />
          ) : (
            <ul aria-label="Kontrakt per butik" className="flex flex-col gap-2">
              {list.rows.map((row, i) => {
                const anchor = !firstOfStore.has(row.storeId);
                firstOfStore.add(row.storeId);
                const c = row.contractId ? contractById.get(row.contractId) : undefined;
                return (
                  <ContractItem
                    key={row.key}
                    i={i}
                    row={row}
                    contract={c}
                    anchor={anchor}
                    canEdit={canEdit}
                    template={c ? statusOf(c.id) : null}
                    signedAt={c ? (statuses.get(c.id)?.signedAt ?? null) : null}
                    signature={c ? (signatures.get(c.id) ?? null) : null}
                    reminder={c ? (reminderOf.get(c.id) ?? null) : null}
                    stores={stores}
                    agreementOptions={agreementOptions}
                    agreements={data.agreements}
                  />
                );
              })}
            </ul>
          )
        ) : null}

        {tab === "lista" && canEdit && stores.length > 0 ? (
          <div className="flex flex-wrap items-center gap-2">
            <ContractDialog
              stores={stores}
              agreements={agreementOptions}
              trigger={{ label: "Registrera befintligt", variant: "ghost", size: "sm" }}
            />
          </div>
        ) : null}
        {tab === "lista" && !data.fileStore.configured ? (
          <StateMessage compact kind="not-configured" message={data.fileStore.detail} />
        ) : null}

        {tab === "uppsagning" ? (
          <section aria-labelledby="att-atgarda" className="flex flex-col gap-6">
            <SectionHeader
              id="att-atgarda"
              size="md"
              title={
                due.length === 0
                  ? "Inget att säga upp nu."
                  : `${plural(due.length, "kontrakt", "kontrakt")} behöver beslut.`
              }
              aside={
                due[0]?.term.noticeDeadline
                  ? `Närmast: ${storeName.get(due[0].storeId) ?? "butiken"}, ${day(due[0].term.noticeDeadline)}.`
                  : "Påminnelse 90 dagar innan."
              }
            />
            {due.length > 0 ? (
              <ol className="flex flex-col">
                {due.map((r) => (
                  <li
                    key={r.key}
                    className="flex flex-col gap-2 border-t border-line py-4 first:border-t-0 first:pt-0"
                  >
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <a
                        href={`/avtal#avtal-${r.contractId}`}
                        className="rounded-xs text-base text-fg hover:underline"
                      >
                        {r.title}
                      </a>
                      <StatusTag status={REMINDER[r.status].status}>
                        {REMINDER[r.status].label}
                      </StatusTag>
                    </div>
                    <p className="text-sm text-muted">{r.detail}</p>
                    <EvidenceDetails evidence={r.evidence} />
                  </li>
                ))}
              </ol>
            ) : null}
          </section>
        ) : null}

        {tab === "intakt" ? (
          o ? (
            <section aria-labelledby="intakt-per-butik" className="flex flex-col gap-6">
              <SectionHeader
                id="intakt-per-butik"
                size="md"
                eyebrow={periodText(o.window)}
                title={
                  o.expiringShareBp === null
                    ? "Ingen intäkt de senaste 12 månaderna."
                    : `${formatPercent(o.expiringShareBp / 10_000)} av intäkten löper ut inom 12 mån.`
                }
                aside={`${sek(o.expiringRevenueOre)} av ${sek(o.totalRevenueOre)}.`}
              />
              <Panel>
                <PanelSection label="Butiker" meta={formatInt(o.stores.length)}>
                  <ul className="flex flex-col">
                    {o.stores.map((row) => (
                      <li
                        key={row.storeId}
                        className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1 border-t border-line py-3 first:border-t-0 first:pt-0 sm:grid-cols-[minmax(0,1fr)_10rem_7rem_6rem]"
                      >
                        <span className="min-w-0 truncate text-fg">
                          {storeName.get(row.storeId) ?? "Okänd butik"}
                        </span>
                        <span className="meta text-subtle sm:order-none">
                          {CATEGORY[row.category]}
                          {row.currentEnd ? ` · ${day(row.currentEnd)}` : ""}
                        </span>
                        <span className="tnum text-right text-fg">{sek(row.revenueOre)}</span>
                        <span className="tnum text-right text-muted">
                          {row.shareBp === null ? "–" : formatPercent(row.shareBp / 10_000)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </PanelSection>
                <PanelSection label="Underlag">
                  <EvidenceDetails evidence={o.evidence} />
                </PanelSection>
              </Panel>
            </section>
          ) : (
            <StateMessage
              kind="error"
              message={data.overviewError ?? "Intäkten kunde inte räknas."}
            />
          )
        ) : null}

        {tab === "arkiv" ? (
          archivedContracts.length === 0 ? (
            <StateMessage kind="empty" compact message="Inget arkiv." />
          ) : (
            <ul className="flex flex-col">
              {archivedContracts.map((c) => (
                <li
                  key={c.id}
                  className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-line py-3 first:border-t-0 first:pt-0"
                >
                  <span className="min-w-0 text-sm text-muted">
                    <span className="text-fg">{storeName.get(c.storeId) ?? "Okänd butik"}</span>
                    {" · "}
                    {day(c.validFrom)} – {c.validTo ? day(c.validTo) : "tills vidare"}
                  </span>
                  {canEdit ? (
                    <ContractArchive
                      id={c.id}
                      archived
                      label={`${storeName.get(c.storeId) ?? "Okänd butik"}: ${c.title ?? "Kontrakt"}`}
                    />
                  ) : null}
                </li>
              ))}
            </ul>
          )
        ) : null}
      </div>
    </div>
  );
}

/** En rad: butik, villkor, status, PDF och nästa steg. Resten under "Mer". */
function ContractItem({
  i,
  row,
  contract: c,
  anchor,
  canEdit,
  template,
  signedAt,
  signature,
  reminder: r,
  stores,
  agreementOptions,
  agreements,
}: {
  i: number;
  row: ContractRow;
  contract: ContractRecord | undefined;
  anchor: boolean;
  canEdit: boolean;
  template: TemplateStatus | null;
  signedAt: Date | null;
  signature: { signerName: string; signedAt: Date | string } | null;
  reminder: ContractReminder | null;
  stores: { id: string; name: string }[];
  agreementOptions: AgreementOption[];
  agreements: AgreementRecord[];
}) {
  const st = ROW_STATUS[row.status];
  const id = c ? `avtal-${c.id}` : undefined;
  const pdf = c
    ? signature
      ? { href: `/avtal/${c.id}/signerad`, label: "PDF" }
      : c.hasFile && c.fileName
        ? { href: `/avtal/${c.id}/fil`, label: "PDF" }
        : template
          ? { href: `/avtal/${c.id}/mall`, label: "PDF" }
          : null
    : null;
  const canSign =
    canEdit &&
    c &&
    !signedAt &&
    !c.terminatedOn &&
    (template !== null || c.fileContentType === "application/pdf");
  return (
    <li
      id={id}
      className={cn(
        "rise lift scroll-mt-28 rounded-md border bg-surface p-4",
        row.alert ? "border-signal-line" : "border-line",
      )}
      style={{ "--i": Math.min(i, 12) } as React.CSSProperties}
    >
      {anchor ? <span id={`butik-${row.storeId}`} className="block scroll-mt-28" /> : null}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 flex-col gap-1">
          <Link
            href={`/butiker/${row.storeId}`}
            className="truncate rounded-xs text-md font-medium text-fg hover:underline"
          >
            {row.storeName}
          </Link>
          <span className={cn("text-sm", row.terms ? "text-muted" : "text-subtle")}>
            {row.terms ?? "Inga villkor"}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={cn(
              "label inline-flex h-7 items-center gap-1.5 rounded-xs border px-2",
              TONE[row.status],
            )}
          >
            <span
              aria-hidden
              className={cn(
                "size-1.5 rounded-full",
                st.tone === "ok" ? "bg-up" : st.tone === "critical" ? "bg-signal" : "bg-current",
              )}
            />
            {st.label}
          </span>
          {pdf ? (
            <Link href={pdf.href} prefetch={false} target="_blank" className={link}>
              {pdf.label}
            </Link>
          ) : null}
          {canEdit && row.status === "missing" ? (
            <Link
              href={`/avtal?skapa=${encodeURIComponent(`store:${row.storeId}`)}`}
              scroll={false}
              className="inline-flex h-9 items-center rounded-sm border border-inverse bg-inverse px-3.5 text-sm font-medium text-on-inverse hover:bg-inverse-hover"
            >
              Skapa kontrakt
            </Link>
          ) : null}
          {canSign && c ? <SignOnSite contractId={c.id} storeName={row.storeName} /> : null}
        </div>
      </div>
      {c ? (
        <details className="group mt-3">
          <summary className="label w-fit cursor-pointer list-none text-subtle hover:text-fg">
            <span
              aria-hidden
              className="mr-1 inline-block transition-transform duration-fast group-open:rotate-90"
            >
              ›
            </span>
            Mer
          </summary>
          <div className="fade-in mt-4 flex flex-col gap-4">
            <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-4">
              <div className="flex flex-col gap-0.5">
                <dt className="label text-subtle">Gäller</dt>
                <dd className="text-fg">
                  {day(c.validFrom)} –{" "}
                  {r?.term.currentEnd ? day(r.term.currentEnd) : "tills vidare"}
                </dd>
              </div>
              <div className="flex flex-col gap-0.5">
                <dt className="label text-subtle">Uppsägning</dt>
                <dd className="text-fg">
                  {noticeText(c)}
                  {r?.term.noticeDeadline ? (
                    <span className="meta block text-subtle">
                      Senast {day(r.term.noticeDeadline)}
                    </span>
                  ) : null}
                </dd>
              </div>
              <div className="flex flex-col gap-0.5">
                <dt className="label text-subtle">Förlängning</dt>
                <dd className="text-fg">
                  {c.renewalMonths ? plural(c.renewalMonths, "månad", "månader") : "Ingen"}
                  {c.terminatedOn ? (
                    <span className="meta block text-subtle">Uppsagt {day(c.terminatedOn)}</span>
                  ) : null}
                </dd>
              </div>
              <div className="flex flex-col gap-0.5">
                <dt className="label text-subtle">Status</dt>
                <dd className="text-fg">
                  {r ? REMINDER[r.status].label : "–"}
                  {signature ? (
                    <span className="meta block text-subtle">
                      {signature.signerName} {formatDate(new Date(signature.signedAt))}
                    </span>
                  ) : null}
                </dd>
              </div>
            </dl>
            {canEdit ? (
              <div className="flex flex-wrap items-center gap-2">
                {template && template !== "signed" ? (
                  <ContractNextStep contractId={c.id} status={template} hasFile={c.hasFile} />
                ) : (
                  <ContractFileUpload contractId={c.id} hasFile={c.hasFile} />
                )}
                <ContractDialog
                  stores={stores}
                  agreements={agreementOptions}
                  initial={draftOf(c, agreements)}
                  trigger={{ label: "Ändra", variant: "ghost", size: "sm" }}
                />
                <ContractArchive
                  id={c.id}
                  archived={false}
                  label={`${row.storeName}: ${c.title ?? "Kontrakt"}`}
                />
              </div>
            ) : null}
          </div>
        </details>
      ) : null}
    </li>
  );
}

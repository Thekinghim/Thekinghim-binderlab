import type { Metadata } from "next";
import Link from "next/link";

import type { ContractReminder, ContractStatus, ExpiringCategory } from "@/analytics/contracts";
import { Panel, PanelSection } from "@/components/ui/frame";
import { SectionHeader } from "@/components/ui/section-header";
import { StateMessage } from "@/components/ui/state-message";
import { StatusTag, type Status } from "@/components/ui/status-tag";
import { formatDate, formatInt, formatPercent } from "@/lib/format";
import {
  currentViewer,
  loadContractsFor,
  type AgreementRecord,
  type ContractRecord,
} from "@/server/accounting";
import { requireRoute } from "@/server/data/core";

import { EconomyKpis } from "../ekonomi/_components/bits";
import { EvidenceDetails } from "../ekonomi/_components/evidence";
import { isoToDate, periodText, plural, sek } from "../ekonomi/_lib/view";
import { ContractDialog } from "./_components/contract-dialog";
import { ContractFileUpload } from "./_components/contract-file";
import type { AgreementOption, ContractDraft } from "./_lib/types";

export const metadata: Metadata = { title: "Avtal" };

const SECTION = "flex scroll-mt-28 flex-col gap-10 border-t border-line py-12 md:gap-12 md:py-16";

const STATUS: Record<ContractStatus, { status: Status; label: string }> = {
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
  "no-contract": "Inget gällande avtal",
};

function day(date: string, today: string): string {
  return formatDate(isoToDate(date), { year: "auto", now: isoToDate(today) });
}

function termsLabel(a: AgreementRecord): string {
  const parts: string[] = [];
  if (a.commissionBp !== null) parts.push(`provision ${formatPercent(a.commissionBp / 10_000, 1)}`);
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

/**
 * Avtal: butiksavtal med villkor, ersättning, giltighet, uppsägningstid och avtalsfil.
 * Svarar först på hur mycket av intäkten som ligger på avtal som löper ut inom 12 månader.
 * Ägare, admin och läsare; ägare och admin ändrar.
 */
export default async function AvtalPage() {
  const ctx = await requireRoute("avtal");
  const viewer = await currentViewer();
  const data = await loadContractsFor(viewer, ctx.today);
  const canEdit = ctx.canEdit;
  const o = data.overview;
  const storeName = new Map(data.stores.map((s) => [s.id, s.name]));
  const reminderOf = new Map<string, ContractReminder>(
    data.reminders.reminders.map((r) => [r.contractId, r]),
  );
  const active = data.contracts.filter((c) => !c.archived);
  const stores = data.stores.filter((s) => !s.archived).map((s) => ({ id: s.id, name: s.name }));
  const agreementOptions: AgreementOption[] = data.agreements.map((a) => ({
    id: a.id,
    storeId: a.storeId,
    contractId: a.contractId,
    label: termsLabel(a),
    period: agreementPeriod(a),
  }));
  const due = data.reminders.due;

  const title = o
    ? o.expiringShareBp === null
      ? "Ingen intäkt de senaste 12 månaderna."
      : `${formatPercent(o.expiringShareBp / 10_000)} av intäkten ligger på avtal som löper ut inom 12 månader.`
    : "Avtalen kunde inte vägas mot intäkten.";
  const aside = o
    ? `${sek(o.expiringRevenueOre)} av ${sek(o.totalRevenueOre)} ${periodText(o.window)}${
        o.noContractRevenueOre > 0
          ? `; ${sek(o.noContractRevenueOre)} kommer från butiker utan gällande avtal`
          : ""
      }.`
    : (data.overviewError ?? undefined);

  return (
    <div className="mx-auto flex w-full max-w-[1280px] flex-col px-4 pt-8 md:px-8 md:pt-12">
      <div className="flex flex-col gap-10 pb-12 md:gap-12 md:pb-16">
        <SectionHeader
          as="h1"
          size="xl"
          eyebrow="Avtal · 12 mån"
          title={title}
          aside={aside}
          meta={[
            { label: "Avtal", value: formatInt(active.length) },
            { label: "Att åtgärda", value: formatInt(due.length) },
            { label: "Butiker", value: formatInt(stores.length) },
          ]}
        />
        {o && o.expiringShareBp !== null ? (
          <EconomyKpis
            label={`Intäkt ${periodText(o.window)}`}
            items={[
              {
                id: "share",
                label: "Löper ut inom 12 mån",
                value: o.expiringShareBp,
                unit: "bp",
                primary: true,
              },
              { id: "expiring", label: "Intäkt på dem", value: o.expiringRevenueOre, unit: "ore" },
              { id: "none", label: "Utan avtal", value: o.noContractShareBp, unit: "bp" },
              {
                id: "due",
                label: "Att åtgärda",
                value: due.length,
                unit: "count",
                alert: due.length > 0,
                alertText: due.length > 0 ? "Säg upp eller förläng" : undefined,
              },
            ]}
          />
        ) : null}
      </div>

      {data.overviewError ? <StateMessage kind="error" message={data.overviewError} /> : null}

      {/* 01 Att åtgärda */}
      <section aria-labelledby="att-atgarda" className={SECTION}>
        <SectionHeader
          id="att-atgarda"
          index={1}
          eyebrow="Påminnelser · 90 d före sista uppsägningsdag"
          title={
            due.length === 0
              ? "Inget avtal behöver sägas upp eller förhandlas nu."
              : `${plural(due.length, "avtal", "avtal")} behöver beslut före sista uppsägningsdag.`
          }
          aside={
            due[0]?.term.noticeDeadline
              ? `Närmast: ${storeName.get(due[0].storeId) ?? "butiken"}, sista dag ${day(due[0].term.noticeDeadline, ctx.today)}.`
              : `${plural(active.length, "avtal", "avtal")} bevakas, påminnelse 90 dagar före sista uppsägningsdag.`
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
                    href={`#avtal-${r.contractId}`}
                    className="rounded-xs text-base text-fg hover:underline"
                  >
                    {r.title}
                  </a>
                  <StatusTag status={STATUS[r.status].status}>{STATUS[r.status].label}</StatusTag>
                </div>
                <p className="text-sm text-muted">{r.detail}</p>
                <EvidenceDetails evidence={r.evidence} />
              </li>
            ))}
          </ol>
        ) : null}
      </section>

      {/* 02 Avtalen */}
      <section aria-labelledby="avtalen" className={SECTION}>
        <SectionHeader
          id="avtalen"
          index={2}
          eyebrow="Avtal per butik"
          title={
            active.length === 0
              ? "Inga avtal registrerade."
              : `${plural(active.length, "avtal", "avtal")}, ${plural(
                  active.filter((c) => c.hasFile).length,
                  "med fil",
                  "med fil",
                )}.`
          }
          aside={
            active.length === 0
              ? `${plural(stores.length, "butik", "butiker")} saknar avtal i Binderlab.`
              : `${plural(active.filter((c) => !c.hasFile).length, "saknar", "saknar")} avtalsfil.`
          }
          actions={
            canEdit && stores.length > 0 ? (
              <ContractDialog
                stores={stores}
                agreements={agreementOptions}
                trigger={{ label: "Nytt avtal", variant: "primary" }}
              />
            ) : undefined
          }
        />
        {!data.fileStore.configured ? (
          <StateMessage compact kind="not-configured" message={data.fileStore.detail} />
        ) : null}
        {active.length === 0 ? (
          <StateMessage
            kind="empty"
            message="Inga butiksavtal är registrerade."
            detail="Villkoren för provision och hyra finns per butik; ett avtal samlar dem med giltighet, uppsägningstid och avtalsfilen."
          />
        ) : (
          <ul className="flex flex-col">
            {active.map((c) => {
              const r = reminderOf.get(c.id);
              const terms = data.agreements.filter((a) => a.contractId === c.id);
              const st = r ? STATUS[r.status] : null;
              return (
                <li
                  key={c.id}
                  id={`avtal-${c.id}`}
                  className="grid scroll-mt-28 grid-cols-1 gap-4 border-t border-line py-6 first:border-t-0 first:pt-0 lg:grid-cols-12"
                >
                  <div className="flex flex-col gap-1 lg:col-span-4">
                    <h3 className="text-md text-fg">{storeName.get(c.storeId) ?? "Okänd butik"}</h3>
                    <p className="text-sm text-muted">{c.title ?? "Avtal"}</p>
                    {st ? (
                      <div className="pt-1">
                        <StatusTag status={st.status}>{st.label}</StatusTag>
                      </div>
                    ) : null}
                  </div>
                  <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm lg:col-span-6">
                    <div className="flex flex-col gap-0.5">
                      <dt className="label text-subtle">Gäller</dt>
                      <dd className="text-fg">
                        {day(c.validFrom, ctx.today)} –{" "}
                        {r?.term.currentEnd ? day(r.term.currentEnd, ctx.today) : "tills vidare"}
                      </dd>
                    </div>
                    <div className="flex flex-col gap-0.5">
                      <dt className="label text-subtle">Sista uppsägning</dt>
                      <dd className="text-fg">
                        {r?.term.noticeDeadline ? day(r.term.noticeDeadline, ctx.today) : "–"}
                        <span className="meta block text-subtle">
                          Uppsägningstid {noticeText(c).toLowerCase()}
                        </span>
                      </dd>
                    </div>
                    <div className="flex flex-col gap-0.5">
                      <dt className="label text-subtle">Förlängning</dt>
                      <dd className="text-fg">
                        {c.renewalMonths
                          ? `${plural(c.renewalMonths, "månad", "månader")} i taget`
                          : "Ingen"}
                        {c.terminatedOn ? (
                          <span className="meta block text-subtle">
                            Uppsagt {day(c.terminatedOn, ctx.today)}
                          </span>
                        ) : null}
                      </dd>
                    </div>
                    <div className="flex flex-col gap-0.5">
                      <dt className="label text-subtle">Ersättning</dt>
                      <dd className="text-fg">
                        {terms.length === 0
                          ? "Inga villkor kopplade"
                          : terms.map((a) => (
                              <span key={a.id} className="block">
                                {termsLabel(a)}
                                <span className="meta block text-subtle">{agreementPeriod(a)}</span>
                              </span>
                            ))}
                      </dd>
                    </div>
                    {c.terms ? (
                      <div className="col-span-2 flex flex-col gap-0.5">
                        <dt className="label text-subtle">Villkor</dt>
                        <dd className="whitespace-pre-line text-muted">{c.terms}</dd>
                      </div>
                    ) : null}
                  </dl>
                  <div className="flex flex-wrap items-start gap-2 lg:col-span-2 lg:flex-col lg:items-end">
                    {c.hasFile && c.fileName ? (
                      <Link
                        href={`/avtal/${c.id}/fil`}
                        prefetch={false}
                        className="inline-flex h-7 max-w-full items-center truncate rounded-xs px-2.5 text-sm text-fg underline-offset-4 hover:underline"
                        title={c.fileName}
                      >
                        {c.fileName}
                      </Link>
                    ) : (
                      <span className="meta text-subtle">Ingen fil</span>
                    )}
                    {canEdit ? (
                      <>
                        <ContractFileUpload contractId={c.id} hasFile={c.hasFile} />
                        <ContractDialog
                          stores={stores}
                          agreements={agreementOptions}
                          initial={draftOf(c, data.agreements)}
                          trigger={{ label: "Ändra", variant: "ghost", size: "sm" }}
                        />
                      </>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* 03 Intäkt per butik */}
      {o ? (
        <section aria-labelledby="intakt-per-butik" className={SECTION}>
          <SectionHeader
            id="intakt-per-butik"
            index={3}
            eyebrow={`Intäkt per butik · ${periodText(o.window)}`}
            title={`${sek(o.totalRevenueOre)} i intäkt, ${sek(o.expiringRevenueOre)} på avtal som löper ut.`}
            aside={o.summary}
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
                      {row.currentEnd ? ` · ${day(row.currentEnd, ctx.today)}` : ""}
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
      ) : null}
    </div>
  );
}

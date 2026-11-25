import type { Metadata } from "next";
import Link from "next/link";

import type { ContractReminder, ContractStatus, ExpiringCategory } from "@/analytics/contracts";
import { Badge, type BadgeTone } from "@/components/v2/badge";
import { ButtonLink } from "@/components/v2/button";
import { Card, CardBody } from "@/components/v2/card";
import { Empty } from "@/components/v2/empty";
import { Notice } from "@/components/v2/notice";
import { PAGE_BODY, PageIntro } from "@/components/v2/page-intro";
import { V2Page, headerDate } from "@/components/v2/shell/page";
import { SubNav } from "@/components/v2/sub-nav";
import { Table } from "@/components/v2/table";
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
  loadStoreSalesFor,
  type ContractStatus as TemplateStatus,
} from "@/server/contracts";
import { loadMasterData, requireRoute } from "@/server/data/core";

import { pickTab, ViewTabs } from "../automater/_components/view-tabs";
import { splitNumber } from "../butiker/_lib/head";
import { faceOf, loadStoreFaces, type FaceProps } from "../butiker/_lib/visual-data";
import { StoreFace } from "@/components/v2/store-face";
import { EvidenceDetails } from "../ekonomi/_components/evidence";
import { isoToDate, periodText, plural, sek } from "../ekonomi/_lib/view";
import { ContractArchive } from "./_components/contract-archive";
import { ContractDialog } from "./_components/contract-dialog";
import { ContractFileUpload } from "./_components/contract-file";
import { ContractNextStep } from "./_components/contract-status";
import { CreateContract } from "./_components/create-contract";
import { SignButton, SignScope } from "./_components/sign-on-site";
import {
  buildContractRows,
  contractHeadline,
  planStartMove,
  revenueRiskHeadline,
  ROW_STATUS,
  startFix,
  uncoveredCardText,
  uncoveredSales,
  type ContractRow,
  type StartFix,
} from "./_lib/model";
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

const REMINDER: Record<ContractStatus, { tone: BadgeTone; label: string }> = {
  "not-started": { tone: "neutral", label: "Ej påbörjat" },
  "open-ended": { tone: "success", label: "Tills vidare" },
  scheduled: { tone: "success", label: "Gäller" },
  due: { tone: "warning", label: "Säg upp eller förläng" },
  "notice-passed": { tone: "neutral", label: "Uppsägningstid passerad" },
  terminated: { tone: "plain", label: "Uppsagt" },
  expired: { tone: "plain", label: "Utgånget" },
};

const CATEGORY: Record<ExpiringCategory, string> = {
  expiring: "Löper ut inom 12 mån",
  secure: "Längre eller tills vidare",
  "no-contract": "Utan signerat kontrakt",
};

const TONE: Record<ContractRow["status"], BadgeTone> = {
  missing: "critical",
  draft: "neutral",
  sent: "info",
  due: "warning",
  terminated: "plain",
  upcoming: "success",
  signed: "success",
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
  const tab = pickTab(TABS, sp.vy);
  // Intäktsöversikten (12 månaders order) bara på fliken Intäkt. Status och signering står
  // på kontraktsraderna (ingen egen fråga).
  const [data, setup, signatures, master, sales, faces] = await Promise.all([
    loadContractsFor(viewer, ctx.today, { overview: tab === "intakt" }),
    canEdit ? loadContractSetupFor(viewer, ctx.today) : null,
    loadContractSignaturesFor(viewer),
    loadMasterData(),
    loadStoreSalesFor(viewer),
    // Visuellt: butikens symbol före namnet (typ och stad, bara läsning).
    loadStoreFaces(),
  ]);
  const statuses = new Map(
    data.contracts.map((c) => [
      c.id,
      { template: c.template, sentAt: c.sentAt, signedAt: c.signedAt },
    ]),
  );
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
  const contractInputs = data.contracts.map((c) => ({
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
  }));
  const list = buildContractRows({
    stores,
    contracts: contractInputs,
    agreements: data.agreements,
    reminders: new Map(data.reminders.reminders.map((r) => [r.contractId, r.status])),
    due: new Set(due.map((r) => r.contractId)),
    withMachine,
    today: ctx.today,
  });
  const missing = list.total - list.signed;
  // Försäljning som inget signerat kontrakt täcker (t.ex. sålt sedan 14 okt., kontrakt från 3 nov.).
  const uncovered = uncoveredSales({
    stores,
    sales,
    contracts: contractInputs,
    today: ctx.today,
  });
  // Varningen står på butikens kort (på kontraktet den gäller, annars butikens första rad),
  // med knappen som rättar startdagen när det går med ett tryck.
  const uncoveredByRow = new Map<string, UncoveredCard>();
  for (const u of uncovered) {
    const row =
      list.rows.find((r) => u.unsignedId !== null && r.contractId === u.unsignedId) ??
      list.rows.find((r) => r.storeId === u.storeId);
    if (!row) continue;
    const fix = startFix(u, ctx.today);
    const plan = fix
      ? planStartMove({
          fix,
          storeName: u.storeName,
          agreements: data.agreements,
          today: ctx.today,
        })
      : null;
    uncoveredByRow.set(row.key, {
      text: uncoveredCardText(u, ctx.today),
      fix: fix && plan?.ok ? fix : null,
      termsMove: Boolean(plan?.ok && plan.moveAgreementId),
      blocked: plan && !plan.ok ? plan.reason : null,
      sent: Boolean(fix && statuses.get(fix.contractId)?.sentAt),
      next: fix ? null : u.unsignedId ? "sign" : "create",
    });
  }
  // Andra raden: nästa åtgärd (listan står redan med röda först), inte samma tal igen.
  const firstAlert = missing > 0 ? (list.rows.find((r) => r.alert) ?? null) : null;
  const firstOfStore = new Set<string>();
  const headParts = splitNumber(contractHeadline(list.signed, list.total));

  return (
    <V2Page
      title="Kontrakt"
      date={headerDate(new Date(ctx.now), ctx.timeZone)}
      tools={
        canEdit && setup ? (
          <CreateContract
            key={skapa ?? "ny"}
            options={setup.options}
            operator={setup.operator}
            today={ctx.today}
            orgNumberMissing={setup.orgNumberMissing}
            operatorGaps={setup.operatorGaps}
            firstContract={firstContract}
            initialTarget={skapa}
            autoOpen={Boolean(skapa)}
          />
        ) : undefined
      }
    >
      <SubNav />
      <div className={PAGE_BODY}>
        <PageIntro
          title={
            <>
              {headParts.before}
              {headParts.value !== null ? (
                <span
                  className={cn(
                    "tnum",
                    list.total > 0 && (missing === 0 ? "text-v2-profit-text" : "text-v2-crit-text"),
                  )}
                >
                  {formatInt(headParts.value)}
                </span>
              ) : null}
              {headParts.after}
            </>
          }
          aside={
            firstAlert
              ? firstAlert.status === "missing"
                ? `Nästa: skapa kontrakt med ${firstAlert.storeName}.`
                : `Nästa: få ${firstAlert.storeName} att signera.`
              : undefined
          }
        />

        <div>
          <ViewTabs tabs={TABS} value={tab} basePath="/avtal" query="" label="Visa" />
        </div>

        <div key={tab} className="v2-enter v2-stack">
          {tab === "lista" ? (
            // Inget antal i rubriken: raderna (en per kontrakt, även butiker utan automat)
            // räknas inte som rubriken ovanför ("Alla 6 butiker …") och såg ut att säga emot den.
            <Card title="Kontrakt per butik">
              {list.rows.length === 0 ? (
                <Empty title="Inga butiker än." />
              ) : (
                <ul aria-label="Kontrakt per butik" className="flex flex-col">
                  {list.rows.map((row) => {
                    const anchor = !firstOfStore.has(row.storeId);
                    firstOfStore.add(row.storeId);
                    const c = row.contractId ? contractById.get(row.contractId) : undefined;
                    return (
                      <ContractItem
                        key={row.key}
                        row={row}
                        contract={c}
                        anchor={anchor}
                        uncovered={uncoveredByRow.get(row.key) ?? null}
                        canEdit={canEdit}
                        template={c ? statusOf(c.id) : null}
                        signedAt={c ? (statuses.get(c.id)?.signedAt ?? null) : null}
                        signature={c ? (signatures.get(c.id) ?? null) : null}
                        reminder={c ? (reminderOf.get(c.id) ?? null) : null}
                        stores={stores}
                        agreementOptions={agreementOptions}
                        agreements={data.agreements}
                        face={faceOf(faces, row.storeId)}
                      />
                    );
                  })}
                </ul>
              )}
              {canEdit && stores.length > 0 ? (
                <div className="border-t border-v2-line2 px-[18px] py-2.5 max-[900px]:px-4">
                  <ContractDialog
                    stores={stores}
                    agreements={agreementOptions}
                    trigger={{
                      label: "Lägg in ett kontrakt ni redan har",
                      variant: "ghost",
                      size: "sm",
                    }}
                  />
                </div>
              ) : null}
            </Card>
          ) : null}
          {tab === "lista" && !data.fileStore.configured ? (
            <Notice tone="info">{data.fileStore.detail}</Notice>
          ) : null}

          {tab === "uppsagning" ? (
            <Card as="section" title="Uppsägning" count={due.length > 0 ? due.length : null}>
              <CardBody className="flex flex-col gap-4">
                <div className="flex min-w-0 flex-col gap-0.5">
                  <h2 id="att-atgarda" className="text-v2-md font-[550] text-v2-ink">
                    {due.length === 0
                      ? "Inget att säga upp nu."
                      : `${plural(due.length, "kontrakt", "kontrakt")} behöver beslut.`}
                  </h2>
                  <p className="text-v2-sm text-v2-mute">
                    {due[0]?.term.noticeDeadline
                      ? `Närmast: ${storeName.get(due[0].storeId) ?? "butiken"}, ${day(due[0].term.noticeDeadline)}.`
                      : "Påminnelse 90 dagar innan."}
                  </p>
                </div>
                {due.length > 0 ? (
                  <ol className="flex flex-col">
                    {due.map((r) => (
                      <li
                        key={r.key}
                        className="flex flex-col gap-2 border-t border-v2-line2 py-3 first:border-t-0 first:pt-0"
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <a
                            href={`/avtal#avtal-${r.contractId}`}
                            className="rounded-v2-sm text-v2-md font-[550] text-v2-ink hover:underline max-[900px]:inline-flex max-[900px]:min-h-11 max-[900px]:items-center"
                          >
                            {r.title}
                          </a>
                          <Badge tone={REMINDER[r.status].tone} dot>
                            {REMINDER[r.status].label}
                          </Badge>
                        </div>
                        <p className="text-v2-sm text-v2-mute">{r.detail}</p>
                        <EvidenceDetails evidence={r.evidence} />
                      </li>
                    ))}
                  </ol>
                ) : null}
              </CardBody>
            </Card>
          ) : null}

          {tab === "intakt" ? (
            o ? (
              <div className="v2-cols">
                <div className="v2-stack">
                  <Card as="section" title={`Intäkt per butik · ${periodText(o.window)}`}>
                    <CardBody className="flex flex-col gap-4">
                      <div className="flex min-w-0 flex-col gap-0.5">
                        <h2 id="intakt-per-butik" className="text-v2-md font-[550] text-v2-ink">
                          {revenueRiskHeadline(o)}
                        </h2>
                        <p className="text-v2-sm text-v2-mute">
                          {o.noContractRevenueOre > 0
                            ? `${sek(o.noContractRevenueOre)} av ${sek(o.totalRevenueOre)}. Signera kontrakten först.`
                            : `${sek(o.expiringRevenueOre)} av ${sek(o.totalRevenueOre)}.`}
                        </p>
                      </div>
                    </CardBody>
                    <Table
                      caption="Intäkt per butik och kontraktets läge"
                      rows={o.stores}
                      rowKey={(row) => row.storeId}
                      columns={[
                        {
                          key: "butik",
                          header: "Butik",
                          cell: (row) => (
                            <span className="flex min-w-0 items-center gap-3">
                              <StoreFace
                                name={storeName.get(row.storeId)}
                                {...faceOf(faces, row.storeId)}
                                size="sm"
                              />
                              <span className="flex min-w-0 flex-col">
                                <span className="[overflow-wrap:anywhere] text-v2-ink">
                                  {storeName.get(row.storeId) ?? "Okänd butik"}
                                </span>
                                <span className="text-v2-xs text-v2-mute">
                                  {CATEGORY[row.category]}
                                  {row.currentEnd ? ` · ${day(row.currentEnd)}` : ""}
                                </span>
                              </span>
                            </span>
                          ),
                        },
                        {
                          key: "intakt",
                          header: "Intäkt",
                          align: "right",
                          cell: (row) => sek(row.revenueOre),
                        },
                        {
                          key: "andel",
                          header: "Andel",
                          align: "right",
                          cell: (row) =>
                            row.shareBp === null ? "–" : formatPercent(row.shareBp / 10_000),
                        },
                      ]}
                    />
                  </Card>
                </div>
                <div className="v2-stack">
                  <Card as="section" title="Så räknas det">
                    <CardBody>
                      <EvidenceDetails evidence={o.evidence} />
                    </CardBody>
                  </Card>
                </div>
              </div>
            ) : (
              <Notice tone="critical" title="Intäkten kunde inte räknas.">
                {data.overviewError ?? undefined}
              </Notice>
            )
          ) : null}

          {tab === "arkiv" ? (
            <Card
              title="Arkiv"
              count={archivedContracts.length > 0 ? archivedContracts.length : null}
            >
              {archivedContracts.length === 0 ? (
                <Empty title="Inget arkiv." />
              ) : (
                <ul className="flex flex-col">
                  {archivedContracts.map((c) => (
                    <li
                      key={c.id}
                      className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-v2-line2 px-[18px] py-3 first:border-t-0"
                    >
                      <span className="flex min-w-0 items-center gap-3 text-v2-sm text-v2-mute">
                        <StoreFace
                          name={storeName.get(c.storeId)}
                          {...faceOf(faces, c.storeId)}
                          size="sm"
                        />
                        <span className="min-w-0">
                          <span className="text-v2-md text-v2-ink">
                            {storeName.get(c.storeId) ?? "Okänd butik"}
                          </span>
                          {" · "}
                          {day(c.validFrom)} – {c.validTo ? day(c.validTo) : "tills vidare"}
                        </span>
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
              )}
            </Card>
          ) : null}
        </div>
      </div>
    </V2Page>
  );
}

/** Varningen överst på kortet: försäljning som inget signerat kontrakt täcker. */
interface UncoveredCard {
  /** "Sålt sedan 14 okt. utan signerat kontrakt." */
  readonly text: string;
  /** Knappen "Ändra start till 14 okt.", eller null när den inte kan rätta det. */
  readonly fix: StartFix | null;
  /** Villkoren får också den nya startdagen. */
  readonly termsMove: boolean;
  /** Varför knappen inte finns (villkor i vägen eller saknas). */
  readonly blocked: string | null;
  /** En signeringslänk är redan skickad. */
  readonly sent: boolean;
  /** Utan knapp: signera kontraktet som finns, eller skapa ett för den tiden. */
  readonly next: "sign" | "create" | null;
}

/** En rad: butik, villkor, status, PDF och nästa steg. Resten under "Mer". */
function ContractItem({
  row,
  contract: c,
  anchor,
  uncovered,
  canEdit,
  template,
  signedAt,
  signature,
  reminder: r,
  stores,
  agreementOptions,
  agreements,
  face,
}: {
  row: ContractRow;
  contract: ContractRecord | undefined;
  anchor: boolean;
  uncovered: UncoveredCard | null;
  canEdit: boolean;
  template: TemplateStatus | null;
  signedAt: Date | null;
  signature: { signerName: string; signedAt: Date | string } | null;
  reminder: ContractReminder | null;
  stores: { id: string; name: string }[];
  agreementOptions: AgreementOption[];
  agreements: AgreementRecord[];
  face: FaceProps;
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
      className="scroll-mt-28 border-t border-v2-line2 px-[18px] py-3.5 first:border-t-0 max-[900px]:px-4"
    >
      {/* Rutan med QR-koden ligger här och inte i knappen: knappen "Ändra start" försvinner
          när kortet laddas om efter flytten, men rutan ska stå kvar. */}
      <SignScope contractId={c?.id ?? ""} storeName={row.storeName}>
        {anchor ? <span id={`butik-${row.storeId}`} className="block scroll-mt-28" /> : null}
        {uncovered ? (
          <div role="status" data-uncovered className="mb-3">
            <Notice
              tone="critical"
              title={uncovered.text}
              action={
                uncovered.fix && canEdit && c && !signedAt && !c.terminatedOn ? (
                  <SignButton fixStart={{ label: uncovered.fix.label }} large />
                ) : undefined
              }
            >
              {uncovered.fix ? (
                <>
                  {uncovered.fix.now}
                  {uncovered.termsMove ? " Villkoren får samma dag." : ""}
                  {uncovered.sent ? " Butiken ser den nya dagen innan de signerar." : ""}
                </>
              ) : uncovered.blocked ? (
                <>
                  {uncovered.blocked}{" "}
                  <Link
                    href={`/butiker/${row.storeId}?vy=avtal`}
                    className="font-[550] whitespace-nowrap text-v2-ink underline underline-offset-4"
                  >
                    Öppna villkoren{" →"}
                  </Link>
                </>
              ) : uncovered.next === "sign" ? (
                "Signera kontraktet."
              ) : (
                <>
                  Skapa ett kontrakt för den tiden.
                  {canEdit ? (
                    <>
                      {" "}
                      <Link
                        href={`/avtal?skapa=${encodeURIComponent(`store:${row.storeId}`)}`}
                        scroll={false}
                        className="font-[550] whitespace-nowrap text-v2-ink underline underline-offset-4"
                      >
                        Skapa kontrakt{" →"}
                      </Link>
                    </>
                  ) : null}
                </>
              )}
            </Notice>
          </div>
        ) : null}
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-center gap-3">
            <StoreFace name={row.storeName} storeType={face.storeType} city={face.city} size="md" />
            <div className="flex min-w-0 flex-col">
              <Link
                href={`/butiker/${row.storeId}`}
                className="max-w-full min-w-0 truncate rounded-v2-sm text-v2-md font-[550] text-v2-ink hover:underline max-[900px]:inline-flex max-[900px]:min-h-11 max-[900px]:items-center"
              >
                {/* Telefon: länken är flex (44 px hög), där kapar bara ett eget block med "…". */}
                <span className="min-w-0 truncate">{row.storeName}</span>
              </Link>
              <span className={cn("text-v2-sm", row.terms ? "text-v2-mute" : "text-v2-faint")}>
                {row.terms ?? "Inga villkor"}
              </span>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={TONE[row.status]} dot={row.alert || row.status === "due"}>
              {st.label}
              {/* "Löper ut" säger när: annars ser det ut som att avtalet redan har gått ut. */}
              {row.status === "due" && (c?.terminatedOn ?? c?.validTo)
                ? ` ${day((c?.terminatedOn ?? c?.validTo)!)}`
                : ""}
            </Badge>
            {pdf ? (
              <ButtonLink
                href={pdf.href}
                prefetch={false}
                target="_blank"
                size="sm"
                variant="quiet"
                touch
              >
                {pdf.label}
              </ButtonLink>
            ) : null}
            {canEdit && row.status === "missing" ? (
              <ButtonLink
                href={`/avtal?skapa=${encodeURIComponent(`store:${row.storeId}`)}`}
                scroll={false}
                // Vit knapp per rad: den mörka knappen i sidhuvudet är sidans huvudåtgärd.
                size="sm"
                touch
              >
                Skapa kontrakt
              </ButtonLink>
            ) : null}
            {canSign && c ? <SignButton quiet={Boolean(uncovered?.fix)} /> : null}
          </div>
        </div>
        {c ? (
          <details className="group mt-2">
            <summary className="inline-flex min-h-7 w-fit cursor-pointer list-none items-center gap-1 rounded-v2-sm text-v2-sm font-[550] text-v2-mute hover:text-v2-ink max-[900px]:min-h-11 [&::-webkit-details-marker]:hidden">
              <span
                aria-hidden="true"
                className="inline-block transition-transform duration-150 group-open:rotate-90"
              >
                ›
              </span>
              Mer
            </summary>
            <div className="v2-enter mt-3 flex flex-col gap-4 rounded-v2 bg-v2-hover p-3.5">
              <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-v2-sm sm:grid-cols-4">
                <div className="flex flex-col gap-0.5">
                  <dt className="text-v2-xs text-v2-mute">Gäller</dt>
                  <dd className="tnum text-v2-ink">
                    {day(c.validFrom)} –{" "}
                    {r?.term.currentEnd ? day(r.term.currentEnd) : "tills vidare"}
                  </dd>
                </div>
                <div className="flex flex-col gap-0.5">
                  <dt className="text-v2-xs text-v2-mute">Uppsägning</dt>
                  <dd className="text-v2-ink">
                    {noticeText(c)}
                    {r?.term.noticeDeadline ? (
                      <span className="block text-v2-xs text-v2-mute">
                        Senast {day(r.term.noticeDeadline)}
                      </span>
                    ) : null}
                  </dd>
                </div>
                <div className="flex flex-col gap-0.5">
                  <dt className="text-v2-xs text-v2-mute">Förlängning</dt>
                  <dd className="text-v2-ink">
                    {c.renewalMonths ? plural(c.renewalMonths, "månad", "månader") : "Ingen"}
                    {c.terminatedOn ? (
                      <span className="block text-v2-xs text-v2-mute">
                        Uppsagt {day(c.terminatedOn)}
                      </span>
                    ) : null}
                  </dd>
                </div>
                <div className="flex flex-col gap-0.5">
                  <dt className="text-v2-xs text-v2-mute">Status</dt>
                  <dd className="text-v2-ink">
                    {r ? REMINDER[r.status].label : "–"}
                    {signature ? (
                      <span className="block text-v2-xs text-v2-mute">
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
      </SignScope>
    </li>
  );
}

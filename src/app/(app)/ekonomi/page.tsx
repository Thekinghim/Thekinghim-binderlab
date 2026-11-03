import type { Metadata } from "next";
import { Suspense } from "react";

import { Panel, PanelSection } from "@/components/ui/frame";
import { Skeleton, TableSkeleton } from "@/components/ui/skeleton";
import { SectionHeader } from "@/components/ui/section-header";
import { StateMessage } from "@/components/ui/state-message";
import { addMonths, eachMonth } from "@/domain";
import { formatDate, formatDateTime, formatInt, NBSP } from "@/lib/format";
import {
  currentViewer,
  loadBookkeepingFor,
  loadCashflowFor,
  loadFixedCostsFor,
  loadReconciliationFor,
  PAYOUT_FILE_COLUMNS,
  type BookkeepingView,
} from "@/server/accounting";
import { bookkeepingAdapter } from "@/server/accounting/bookkeeping";
import { loadPeriod, requireRoute } from "@/server/data/core";

import { EconomyKpis, type EconomyKpi } from "./_components/bits";
import { DeliverButton, MonthPicker } from "./_components/bookkeeping-controls";
import { EvidenceDetails } from "./_components/evidence";
import { FixedCosts, type FixedCostRow } from "./_components/fixed-costs";
import { PayoutUpload } from "./_components/payout-upload";
import { ReconciliationList } from "./_components/reconciliation";
import { AccountTable, CashflowTable, VerificationTable } from "./_components/tables";
import { pickView, ViewTabs } from "../rapporter/_components/view-tabs";
import { economyHeadline } from "./_lib/headline";
import {
  isoToDate,
  kr,
  monthText,
  periodShort,
  plural,
  sek,
  sentence,
  signedSek,
} from "./_lib/view";

export const metadata: Metadata = { title: "Ekonomi" };

type SearchParams = Record<string, string | string[] | undefined>;

const PROVIDER_LABEL: Record<"local" | "fortnox" | "visma_enet" | "bokio", string> = {
  local: "lokala utkorgen",
  fortnox: "Fortnox",
  visma_enet: "Visma eEkonomi",
  bokio: "Bokio",
};

const SECTION = "rise flex scroll-mt-28 flex-col gap-8 pb-12 md:gap-10 md:pb-16";
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

/**
 * Ekonomi: varje krona från automat till bankkonto. Avstämning av leverantörens
 * utbetalningar mot försäljningen, förslag på verifikationer med SIE-export, kassaflöde per
 * månad och fasta kostnader. Ägare, admin och läsare (requireRoute skickar påfyllaren till
 * sin startsida, och varje laddare kontrollerar rollen igen mot databasen).
 */
export default async function EkonomiPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const ctx = await requireRoute("ekonomi");
  const sp = await searchParams;
  const p = await loadPeriod(sp);
  const viewer = await currentViewer();

  const thisMonth = ctx.today.slice(0, 7);
  const firstMonth = p.dataStart ? p.dataStart.slice(0, 7) : thisMonth;
  const months = eachMonth(`${firstMonth}-01`, ctx.today).reverse();
  const lastFull = addMonths(thisMonth, -1);
  const rawMonth = typeof sp.manad === "string" ? sp.manad : "";
  const month =
    MONTH.test(rawMonth) && months.includes(rawMonth)
      ? rawMonth
      : months.includes(lastFull)
        ? lastFull
        : thisMonth;
  if (!months.includes(month)) months.unshift(month);

  // Bokföringen (verifikationer för räkenskapsårets månader) är den tyngsta delen och
  // behövs inte för rubriken: den startas här och strömmar in i sin sektion (Suspense).
  const VIEWS = ["avstamning", "kassaflode", "fasta", "bokforing"] as const;
  const view = pickView(sp.vy, VIEWS);
  const hrefFor = (v: (typeof VIEWS)[number]) => {
    const q = new URLSearchParams();
    for (const [k, val] of Object.entries(sp)) {
      const x = Array.isArray(val) ? val[0] : val;
      if (x && k !== "vy") q.set(k, x);
    }
    if (v !== "avstamning") q.set("vy", v);
    const qs = q.toString();
    return qs ? `/ekonomi?${qs}` : "/ekonomi";
  };
  const books = view === "bokforing" ? loadBookkeepingFor(viewer, month, ctx.today) : null;
  // Avvisas löftet innan sektionen väntar på det ska det inte räknas som ohanterat;
  // sektionen får felet ändå (sidans error.tsx).
  books?.catch(() => undefined);
  const [rec, cash, fixed] = await Promise.all([
    loadReconciliationFor(viewer, p.period),
    loadCashflowFor(viewer, ctx.today, p.dataStart),
    loadFixedCostsFor(viewer, p.period, ctx.today),
  ]);

  const result = rec.result;
  const headline = economyHeadline(result, cash.result, p.period, ctx.today);
  const when = periodShort(p.period, ctx.today);
  const canEdit = ctx.canEdit;

  const kpis: EconomyKpi[] = result
    ? [
        {
          id: "diff",
          label: "Skillnad",
          value: result.totals.differenceOre,
          unit: "signed-ore",
          primary: true,
        },
        { id: "expected", label: "Väntat", value: result.totals.expectedOre, unit: "ore" },
        { id: "actual", label: "Utbetalt", value: result.totals.actualOre, unit: "ore" },
        {
          id: "open",
          label: "Att utreda",
          value: result.totals.openDeviations,
          unit: "count",
          alert: result.totals.openDeviations > 0,
          alertText: result.totals.openDeviations > 0 ? "Utred avvikelserna" : undefined,
        },
      ]
    : [];

  const scoped = Boolean(p.scope.storeId || p.scope.machineId);
  const bookkeepingStatus = bookkeepingAdapter().status();
  const payoutIds = Object.fromEntries(rec.payouts.map((x) => [x.reference, x.id]));

  // Loggen visar avvikelsens rubrik, inte den interna nyckeln
  const deviationTitle = new Map<string, string>(
    result
      ? [...result.payouts.flatMap((x) => x.deviations), ...result.uncovered].map((d) => [
          d.key,
          d.title,
        ])
      : [],
  );

  // Kassaflöde
  const cashRows =
    cash.result?.buckets.map((b) => ({
      key: b.key,
      phase: b.phase,
      partial: b.partial,
      payoutsOre: b.total.payoutsOre,
      purchasesOre: b.total.purchasesOre,
      storeCompensationOre: b.total.storeCompensationOre,
      fixedCostsOre: b.total.fixedCostsOre,
      netOre: b.total.netOre,
      summary: b.summary,
      note: cashNote(b, rec.payouts, ctx.today),
    })) ?? [];

  const rep = cash.replenishment;
  const added = rep ? rep.months.reduce((sum, m) => sum + m.addedOre, 0) : 0;
  const replenishmentNote = rep
    ? `Inköp framåt: samma takt som ${periodShort(rep.window, ctx.today)} ger ${sek(added)} i påfyllnad utöver lagda inköpsorder.${
        rep.coverageBp !== null && rep.coverageBp < 10_000
          ? ` ${Math.round(rep.coverageBp / 100)} % av orderna har inköpspris.`
          : ""
      }`
    : null;

  // Fasta kostnader
  const accrued = new Map(
    fixed.allocation?.accrual.byCost.map((c) => [c.costId, c.accruedOre]) ?? [],
  );
  const machineCode = new Map(fixed.machines.map((m) => [m.id, m.code]));
  const fixedRows: FixedCostRow[] = fixed.costs.map((c) => ({
    id: c.id,
    name: c.name,
    category: c.category,
    amountOre: c.amountOre,
    interval: c.interval,
    startsOn: c.startsOn,
    endsOn: c.endsOn,
    machineId: c.machineId,
    machineCode: c.machineId ? (machineCode.get(c.machineId) ?? null) : null,
    note: c.note,
    archived: c.archived,
    accruedOre: accrued.get(c.id) ?? 0,
  }));
  const at = fixed.allocation?.totals;

  return (
    <div className="mx-auto flex w-full max-w-[1280px] flex-col px-4 pt-8 md:px-8 md:pt-12">
      <div
        className="rise flex flex-col gap-6 pb-10 md:pb-12"
        style={{ "--i": 0 } as React.CSSProperties}
      >
        <SectionHeader
          as="h1"
          size="xl"
          eyebrow={`Ekonomi · ${p.days}${NBSP}d`}
          title={headline.title}
          aside={headline.aside}
          meta={[
            { label: "Period", value: when },
            {
              label: "Bokföring",
              value: bookkeepingStatus.configured ? bookkeepingStatus.label : "Ej kopplad",
            },
          ]}
        />
        {scoped ? (
          <p className="meta text-subtle">Hela organisationen · filtret gäller inte här</p>
        ) : null}
        <ViewTabs
          label="Vy"
          value={view}
          hrefFor={hrefFor}
          tabs={[
            { value: "avstamning", label: "Avstämning" },
            { value: "kassaflode", label: "Kassaflöde" },
            { value: "fasta", label: "Fasta kostnader" },
            { value: "bokforing", label: "Bokföring" },
          ]}
        />
      </div>

      {view === "avstamning" ? (
        <section
          aria-labelledby="avstamning"
          className={SECTION}
          style={{ "--i": 1 } as React.CSSProperties}
        >
          {result ? (
            <EconomyKpis items={kpis} label={`Avstämning · ${when}`} headingLevel={2} />
          ) : null}
          <SectionHeader
            id="avstamning"
            size="md"
            title="Utbetalningar mot försäljningen."
            aside={result ? reconciliationFact(result) : undefined}
          />
          <div className="grid grid-cols-1 gap-x-8 gap-y-8 lg:grid-cols-12">
            <div className="min-w-0 lg:col-span-8">
              {result ? (
                <ReconciliationList
                  result={result}
                  today={ctx.today}
                  canEdit={canEdit}
                  period={p.period}
                  payoutIds={payoutIds}
                />
              ) : (
                <StateMessage
                  kind="empty"
                  message={sentence(`Ingen utbetalning med period i ${when}`)}
                  action={
                    canEdit
                      ? { label: "Ladda upp utbetalningar", href: "#ladda-upp-utbetalningar" }
                      : undefined
                  }
                />
              )}
              {rec.ordersWithoutTitle > 0 ? (
                <StateMessage
                  compact
                  kind="no-results"
                  code={`${formatInt(rec.ordersWithoutTitle)} order`}
                  message="Order utan titel ingår inte i avstämningen."
                />
              ) : null}
            </div>
            <div className="flex min-w-0 flex-col gap-8 lg:col-span-4">
              {canEdit ? (
                <Panel>
                  <PanelSection label="Ladda upp utbetalningar">
                    <div id="ladda-upp-utbetalningar" className="scroll-mt-28">
                      <PayoutUpload
                        columns={{
                          payouts: PAYOUT_FILE_COLUMNS.payouts.join(", "),
                          lines: PAYOUT_FILE_COLUMNS.lines.join(", "),
                        }}
                      />
                    </div>
                  </PanelSection>
                </Panel>
              ) : null}
              <details className="group rounded-md border border-line bg-surface">
                <summary className="label flex h-10 cursor-pointer list-none items-center justify-between px-4 text-muted hover:text-fg">
                  <span>Logg och filer</span>
                  <span className="tnum text-subtle">
                    {formatInt(rec.reviews.length)} · {formatInt(rec.imports.length)}
                  </span>
                </summary>
                <Panel className="border-0 border-t">
                  <PanelSection label="Logg" meta={formatInt(rec.reviews.length)}>
                    {rec.reviews.length === 0 ? (
                      <p className="text-sm text-muted">Inget utrett ännu.</p>
                    ) : (
                      <ol className="flex flex-col gap-3">
                        {rec.reviews.slice(0, 12).map((r) => (
                          <li key={r.id} className="flex flex-col gap-0.5 text-sm">
                            <span className="meta text-subtle">
                              {formatDateTime(new Date(r.createdAt))} · {r.actor ?? "System"}
                            </span>
                            <span className="text-fg">
                              {r.action === "investigated" ? "Utredd" : "Öppnad igen"}:{" "}
                              <span className="text-muted">
                                {deviationTitle.get(r.deviationKey) ??
                                  deviationFallback(r.deviationKey)}
                              </span>
                            </span>
                            {r.note ? <span className="text-muted">{r.note}</span> : null}
                          </li>
                        ))}
                      </ol>
                    )}
                  </PanelSection>
                  <PanelSection label="Uppladdade filer" meta={formatInt(rec.imports.length)}>
                    {rec.imports.length === 0 ? (
                      <p className="text-sm text-muted">Ingen fil ännu.</p>
                    ) : (
                      <ol className="flex flex-col gap-3">
                        {rec.imports.slice(0, 6).map((i) => (
                          <li key={i.id} className="flex flex-col gap-0.5 text-sm">
                            <span className="truncate text-fg">{i.fileName}</span>
                            <span className="meta text-subtle">
                              {formatDateTime(new Date(i.createdAt))} · {formatInt(i.rowsNew)} nya ·{" "}
                              {i.rowsDuplicate === 1
                                ? "1 dubblett"
                                : `${formatInt(i.rowsDuplicate)} dubbletter`}{" "}
                              · {formatInt(i.rowsConflict + i.rowsError)} fel
                            </span>
                          </li>
                        ))}
                      </ol>
                    )}
                  </PanelSection>
                </Panel>
              </details>
            </div>
          </div>
        </section>
      ) : null}

      {books ? (
        <Suspense fallback={<BookkeepingSkeleton month={month} />}>
          <BookkeepingSection books={books} month={month} months={months} canEdit={canEdit} />
        </Suspense>
      ) : null}

      {view === "kassaflode" ? (
        <section
          aria-labelledby="kassaflode"
          className={SECTION}
          style={{ "--i": 1 } as React.CSSProperties}
        >
          <SectionHeader
            id="kassaflode"
            size="md"
            title={
              cash.result
                ? sentence(
                    `Netto ${signedSek(cash.result.totals.total.netOre)} för ${periodShort(cash.result.range, ctx.today)}`,
                  )
                : "Kassaflöde per månad."
            }
            aside={
              cash.result
                ? cash.result.totals.forecast.netOre !== 0
                  ? `Varav prognos efter i dag: ${signedSek(cash.result.totals.forecast.netOre)}.`
                  : `In ${sek(cash.result.totals.total.inOre)}, ut ${sek(cash.result.totals.total.outOre)}.`
                : (cash.error ?? undefined)
            }
          />
          {cash.result ? (
            <div className="grid grid-cols-1 gap-x-8 gap-y-8 lg:grid-cols-12">
              <div className="min-w-0 lg:col-span-8">
                <CashflowTable rows={cashRows} />
              </div>
              <details className="rounded-md border border-line bg-surface p-4 lg:col-span-4 lg:self-start">
                <summary className="label cursor-pointer text-muted hover:text-fg">
                  Så räknas prognosen
                </summary>
                <ul className="mt-3 flex list-none flex-col gap-2 text-sm text-muted">
                  <li>{cash.payoutCycleNote}</li>
                  {replenishmentNote ? <li>{replenishmentNote}</li> : null}
                  {cash.result.assumptions.map((a) => (
                    <li key={a}>{a}</li>
                  ))}
                </ul>
              </details>
            </div>
          ) : (
            <StateMessage
              kind="error"
              message={cash.error ?? "Kassaflödet kunde inte räknas fram."}
            />
          )}
        </section>
      ) : null}

      {view === "fasta" ? (
        <section
          aria-labelledby="fasta-kostnader"
          className={SECTION}
          style={{ "--i": 1 } as React.CSSProperties}
        >
          <SectionHeader
            id="fasta-kostnader"
            size="md"
            title={
              at && at.fixedCostOre > 0
                ? `Vinst ${sek(at.profitAfterFixedOre)} efter fasta kostnader på ${sek(at.fixedCostOre)}.`
                : at
                  ? `Vinst ${sek(at.profitOre)}, inga fasta kostnader i perioden.`
                  : "Fasta kostnader."
            }
            aside={
              at && at.fixedCostOre > 0
                ? allocationFact(fixed.allocation!, machineCode)
                : (fixed.error ?? undefined)
            }
          />
          {at && at.fixedCostOre > 0 ? (
            <EconomyKpis
              label={`Lönsamhet · ${when}`}
              items={[
                {
                  id: "after",
                  label: "Vinst efter fasta",
                  value: at.profitAfterFixedOre,
                  unit: "ore",
                  primary: true,
                },
                { id: "before", label: "Vinst före fasta", value: at.profitOre, unit: "ore" },
                { id: "fixed", label: "Fasta kostnader", value: at.fixedCostOre, unit: "ore" },
                {
                  id: "margin",
                  label: "Marginal efter fasta",
                  value: at.marginAfterFixedBp,
                  unit: "bp",
                },
              ]}
            />
          ) : null}
          <FixedCosts
            rows={fixedRows}
            machines={fixed.machines
              .filter((m) => !m.archived)
              .map((m) => ({ id: m.id, code: m.code, name: m.name }))}
            canEdit={canEdit}
            today={ctx.today}
            periodLabel={when}
          />
          {fixedRows.length === 0 ? (
            <StateMessage
              kind="empty"
              compact
              message="Inga fasta kostnader. Dras från vinsten per dag."
            />
          ) : null}
        </section>
      ) : null}
    </div>
  );
}

/** Bokföringen: verifikationer för månaden, SIE-fil och leverans. Strömmar in (Suspense). */
async function BookkeepingSection({
  books: booksPromise,
  month,
  months,
  canEdit,
}: {
  books: Promise<BookkeepingView>;
  month: string;
  months: string[];
  canEdit: boolean;
}) {
  const books = await booksPromise;
  const verificationRows = books.verifications.map((v) => {
    const debit = v.transactions
      .filter((t) => t.amountOre > 0)
      .reduce((s, t) => s + t.amountOre, 0);
    return {
      key: `${v.series}-${v.number}`,
      number: v.number,
      date: v.date,
      text: v.text,
      amountOre: debit,
      rows: v.transactions
        .map((t) => `${t.account} ${t.amountOre >= 0 ? "D" : "K"} ${kr(Math.abs(t.amountOre))}`)
        .join(" · "),
    };
  });
  const accountTotals = books.accountTotals.reduce(
    (s, a) => ({ debitOre: s.debitOre + a.debitOre, creditOre: s.creditOre + a.creditOre }),
    { debitOre: 0, creditOre: 0 },
  );
  const sieHref = `/ekonomi/sie?manad=${month}`;
  const closedMonth = books.state === "closed";
  const canDownload = closedMonth && !books.error && books.verifications.length > 0;
  const canDeliver =
    canEdit &&
    canDownload &&
    books.status.configured &&
    books.delivery === null &&
    books.laterDelivery === null;
  const firstNo = books.verifications[0]?.number;
  const lastNo = books.verifications[books.verifications.length - 1]?.number;

  return (
    <section
      id="bokforing"
      aria-labelledby="bokforing-rubrik"
      className={SECTION}
      style={{ "--i": 1 } as React.CSSProperties}
    >
      <SectionHeader
        id="bokforing-rubrik"
        size="md"
        title={`Verifikationer för ${monthText(month)}.`}
        aside={
          books.error
            ? books.error
            : books.verifications.length === 0
              ? "Inget att bokföra."
              : `${plural(books.verifications.length, "verifikation", "verifikationer")} (BL ${firstNo}–${lastNo}), debet ${kr(
                  accountTotals.debitOre,
                )} = kredit ${kr(accountTotals.creditOre)}.`
        }
      />
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <MonthPicker months={months} value={month} />
        <div className="flex flex-wrap gap-2">
          {canDownload ? (
            <a
              href={sieHref}
              download
              className="inline-flex h-9 items-center gap-2 rounded-sm border border-line-strong bg-surface px-3.5 text-base text-fg transition-colors hover:border-line-control hover:bg-hover"
            >
              Ladda ned SIE-fil
            </a>
          ) : null}
          {canDeliver ? <DeliverButton month={month} label={books.status.label} /> : null}
        </div>
      </div>
      {!closedMonth ? (
        <StateMessage
          compact
          kind="no-results"
          code="Pågår"
          message={sentence(
            `${monthText(month)} pågår, så verifikationerna är ett preliminärt förslag`,
          )}
          detail="SIE-filen öppnas när månaden är slut."
        />
      ) : null}
      {books.delivery ? (
        <StateMessage
          compact
          kind={books.changedSinceDelivery ? "error" : "no-results"}
          code={`BL ${books.delivery.firstNumber}–${books.delivery.lastNumber}`}
          message={`Skickad till ${PROVIDER_LABEL[books.delivery.provider]} ${formatDateTime(
            new Date(books.delivery.createdAt),
          )}${books.delivery.actor ? ` av ${books.delivery.actor}` : ""}.`}
          detail={
            books.changedSinceDelivery
              ? "Ändrad sedan den skickades. Bokför skillnaden för hand."
              : undefined
          }
        />
      ) : books.laterDelivery && closedMonth && books.verifications.length > 0 ? (
        <StateMessage
          compact
          kind="no-results"
          code="Ej skickad"
          message={sentence(
            `${monthText(books.laterDelivery.month)} är redan skickad, och månaderna skickas i ordning`,
          )}
          detail="Bokför den här månaden med SIE-filen eller för hand."
        />
      ) : null}
      {books.bankFallback ? (
        <StateMessage
          compact
          kind="not-configured"
          code="1930"
          message="Kontoplanen saknar bankkonto (nyckeln bank), så utbetalningarna bokförs på BAS 1930."
          action={{ label: "Öppna inställningar", href: "/installningar" }}
        />
      ) : null}
      {!books.status.configured ? (
        <StateMessage
          compact
          kind="not-configured"
          message={books.status.detail}
          action={canDownload ? { label: "Ladda ned SIE-fil", href: sieHref } : undefined}
        />
      ) : null}
      {books.error ? (
        <StateMessage
          kind="error"
          message={books.error}
          action={{ label: "Öppna inställningar", href: "/installningar" }}
        />
      ) : books.verifications.length > 0 ? (
        <div className="grid grid-cols-1 gap-x-8 gap-y-10 lg:grid-cols-12">
          <div className="min-w-0 lg:col-span-7">
            <VerificationTable rows={verificationRows} month={month} />
          </div>
          <div className="flex min-w-0 flex-col gap-4 lg:col-span-5">
            <AccountTable rows={books.accountTotals} month={month} totals={accountTotals} />
            <p className="text-sm text-muted">
              {books.payoutsBooked > 0
                ? `${plural(books.payoutsBooked, "utbetalning", "utbetalningar")} bokförda på betalningsdagen.`
                : "Ingen utbetalning i månaden."}
            </p>
            {books.totals ? (
              <p className="text-sm text-muted">
                Försäljning {kr(books.totals.grossOre)} (
                {plural(books.totals.orders, "order", "order")}), butiksersättning{" "}
                {kr(books.totals.compensationOre)}, inköpsvärde sålda pack{" "}
                {kr(books.totals.costOre)}
                {books.totals.unpricedOrders > 0
                  ? `; ${plural(books.totals.unpricedOrders, "order", "order")} saknar inköpspris och har inget inköpsvärde`
                  : ""}
                .
              </p>
            ) : null}
            {books.totals ? (
              <EvidenceDetails evidence={{ ...toFinanceEvidence(books.totals.evidence) }} />
            ) : null}
          </div>
        </div>
      ) : null}
    </section>
  );
}

/** Platshållaren medan bokföringen räknas. */
function BookkeepingSkeleton({ month }: { month: string }) {
  return (
    <section
      aria-busy="true"
      aria-label={`Laddar bokföringen för ${monthText(month)}`}
      className={SECTION}
    >
      <div className="flex flex-col gap-3">
        <Skeleton className="h-3 w-40" />
        <Skeleton className="h-8 w-full max-w-xl" />
      </div>
      <Skeleton className="h-9 w-56" />
      <div className="grid grid-cols-1 gap-x-8 gap-y-10 lg:grid-cols-12">
        <div className="lg:col-span-7">
          <TableSkeleton rows={6} />
        </div>
        <div className="lg:col-span-5">
          <TableSkeleton rows={4} />
        </div>
      </div>
    </section>
  );
}

/** Rapportens underlag (@/reports) i samma form som ekonomins underlag, för visningen. */
function toFinanceEvidence(e: {
  rule: string;
  scope: { period: { start: string; end: string } };
  orderCount: number;
  figures: readonly { label: string; value: number; unit: "ore" | "bp" | "count" | "days" }[];
}) {
  return {
    rule: e.rule,
    period: e.scope.period,
    orderIds: [] as string[],
    dates: [] as string[],
    titleIds: [] as string[],
    machineIds: [] as string[],
    storeIds: [] as string[],
    recipientIds: [] as string[],
    payoutReferences: [] as string[],
    contractIds: [] as string[],
    fixedCostIds: [] as string[],
    purchaseIds: [] as string[],
    figures: e.figures.map((f, i) => ({
      key: `f${i}`,
      label: f.label,
      value: f.value,
      unit: f.unit,
    })),
  };
}

/** En mening om utbetalningarna som rubriken inte redan säger. */
function reconciliationFact(result: {
  payouts: readonly { reference: string; paidOn: string; expected: { orders: number } }[];
}): string {
  const orders = result.payouts.reduce((s, x) => s + x.expected.orders, 0);
  const last = [...result.payouts].sort((a, b) => (a.paidOn < b.paidOn ? 1 : -1))[0];
  return `${plural(result.payouts.length, "utbetalning", "utbetalningar")} täcker ${plural(
    orders,
    "order",
    "order",
  )}${last ? `; senast ${last.reference}` : ""}.`;
}

/** Fördelningen av gemensamma kostnader i en mening. */
function allocationFact(
  allocation: {
    method: "revenue" | "equal";
    rows: readonly { key: string; kind: string; sharedFixedOre: number; shareBp: number | null }[];
  },
  codes: ReadonlyMap<string, string>,
): string {
  const how =
    allocation.method === "revenue"
      ? "Gemensamma kostnader fördelas efter nettointäkt"
      : "Gemensamma kostnader fördelas lika per automat";
  const top = allocation.rows
    .filter((r) => r.kind === "machine" && r.sharedFixedOre > 0)
    .sort((a, b) => b.sharedFixedOre - a.sharedFixedOre)[0];
  if (!top) return `${how}.`;
  const share = top.shareBp === null ? "" : ` (${Math.round(top.shareBp / 100)}${NBSP}%)`;
  return `${how}: ${codes.get(top.key) ?? "en automat"} bär mest, ${sek(top.sharedFixedOre)}${share}.`;
}

/** Den interna nyckeln ('AW-2026-10:missing-in-payout') som läsbar text, om rubriken saknas. */
function deviationFallback(key: string): string {
  const ref = key.split(":")[0];
  return ref ? `en avvikelse i ${ref}` : "en avvikelse";
}

/**
 * Förklaring på en månad i kassaflödet där inget kom in: utbetalningen för
 * månadens försäljning kommer först efter månadens slut.
 */
function cashNote(
  b: { key: string; range: { end: string }; total: { payoutsOre: number } },
  payouts: readonly { reference: string; periodEnd: string; paidOn: string | null }[],
  today: string,
): string | null {
  if (b.total.payoutsOre !== 0) return null;
  const later = payouts.find(
    (x) => x.periodEnd.slice(0, 7) === b.key && x.paidOn !== null && x.paidOn > b.range.end,
  );
  if (!later || later.paidOn === null) return null;
  const day = formatDate(isoToDate(later.paidOn), { year: "auto", now: isoToDate(today) });
  return sentence(
    `Utbetalningen för månaden (${later.reference}) ${later.paidOn > today ? "kommer" : "kom"} ${day}`,
  );
}

import type { Metadata } from "next";

import { Panel, PanelSection } from "@/components/ui/frame";
import { SectionHeader } from "@/components/ui/section-header";
import { StateMessage } from "@/components/ui/state-message";
import { addMonths, eachMonth } from "@/domain";
import { formatDateTime, formatInt, NBSP } from "@/lib/format";
import {
  currentViewer,
  loadBookkeepingFor,
  loadCashflowFor,
  loadFixedCostsFor,
  loadReconciliationFor,
  PAYOUT_FILE_COLUMNS,
} from "@/server/accounting";
import { loadPeriod, requireRoute } from "@/server/data/core";

import { EconomyKpis, type EconomyKpi } from "./_components/bits";
import { DeliverButton, MonthPicker } from "./_components/bookkeeping-controls";
import { EvidenceDetails } from "./_components/evidence";
import { FixedCosts, type FixedCostRow } from "./_components/fixed-costs";
import { PayoutUpload } from "./_components/payout-upload";
import { ReconciliationList } from "./_components/reconciliation";
import { AccountTable, CashflowTable, VerificationTable } from "./_components/tables";
import { economyHeadline } from "./_lib/headline";
import { kr, monthText, periodShort, plural, sek, signedKr } from "./_lib/view";

export const metadata: Metadata = { title: "Ekonomi" };

type SearchParams = Record<string, string | string[] | undefined>;

const SECTION = "flex scroll-mt-28 flex-col gap-10 border-t border-line py-12 md:gap-12 md:py-16";
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

  const [rec, books, cash, fixed] = await Promise.all([
    loadReconciliationFor(viewer, p.period),
    loadBookkeepingFor(viewer, month),
    loadCashflowFor(viewer, ctx.today),
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

  // Bokföring
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
    })) ?? [];

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
      <div className="flex flex-col gap-10 pb-12 md:gap-12 md:pb-16">
        <SectionHeader
          as="h1"
          size="xl"
          eyebrow={`Ekonomi · ${p.days}${NBSP}d`}
          title={headline.title}
          aside={headline.aside}
          meta={[
            { label: "Period", value: when },
            { label: "Utbetalningar", value: formatInt(rec.payouts.length) },
            { label: "Att utreda", value: formatInt(result?.totals.openDeviations ?? 0) },
            {
              label: "Bokföring",
              value: books.status.configured ? books.status.label : "Ej kopplad",
            },
          ]}
        />
        {result ? <EconomyKpis items={kpis} label={`Avstämning · ${when}`} /> : null}
      </div>

      {/* 01 Avstämning */}
      <section aria-labelledby="avstamning" className={SECTION}>
        <SectionHeader
          id="avstamning"
          index={1}
          eyebrow={`Avstämning · ${when}`}
          title="Utbetalningar mot försäljningen."
          aside={
            result
              ? result.summary
              : `Ingen utbetalning med period i ${when}. Väntad utbetalning = försäljning − avgifter − återbetalningar.`
          }
        />
        <div className="grid grid-cols-1 gap-x-8 gap-y-8 lg:grid-cols-12">
          <div className="min-w-0 lg:col-span-8">
            {result ? (
              <ReconciliationList result={result} canEdit={canEdit} period={p.period} />
            ) : (
              <StateMessage
                kind="empty"
                message={`Ingen utbetalning från Awish med period i ${when}.`}
                detail={
                  rec.imports[0]
                    ? `Senaste uppladdningen: ${rec.imports[0].fileName}, ${formatDateTime(
                        new Date(rec.imports[0].createdAt),
                      )}.`
                    : "Ingen utbetalningsfil är uppladdad ännu."
                }
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
                code={`${rec.ordersWithoutTitle} order`}
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
                  <p className="mt-3 text-xs text-subtle">{rec.source.detail}</p>
                </PanelSection>
              </Panel>
            ) : null}
            <Panel>
              <PanelSection label="Logg" meta={formatInt(rec.reviews.length)}>
                {rec.reviews.length === 0 ? (
                  <p className="text-sm text-muted">Ingen avvikelse har utretts ännu.</p>
                ) : (
                  <ol className="flex flex-col gap-3">
                    {rec.reviews.slice(0, 12).map((r) => (
                      <li key={r.id} className="flex flex-col gap-0.5 text-sm">
                        <span className="meta text-subtle">
                          {formatDateTime(new Date(r.createdAt))} · {r.actor ?? "System"}
                        </span>
                        <span className="text-fg">
                          {r.action === "investigated" ? "Utredd" : "Öppnad igen"}:{" "}
                          <span className="font-mono text-xs text-muted">{r.deviationKey}</span>
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
                          {formatInt(i.rowsDuplicate)} dubbletter ·{" "}
                          {formatInt(i.rowsConflict + i.rowsError)} fel
                        </span>
                      </li>
                    ))}
                  </ol>
                )}
              </PanelSection>
            </Panel>
          </div>
        </div>
      </section>

      {/* 02 Bokföring */}
      <section id="bokforing" aria-labelledby="bokforing-rubrik" className={SECTION}>
        <SectionHeader
          id="bokforing-rubrik"
          index={2}
          eyebrow={`Bokföring · ${monthText(month)}`}
          title={`Verifikationer för ${monthText(month)}.`}
          aside={
            books.error
              ? books.error
              : books.verifications.length === 0
                ? "Ingen försäljning, butiksersättning eller inköp att bokföra."
                : `${plural(books.verifications.length, "verifikation", "verifikationer")}, debet ${kr(
                    accountTotals.debitOre,
                  )} = kredit ${kr(accountTotals.creditOre)}.`
          }
        />
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <MonthPicker months={months} value={month} />
          <div className="flex flex-wrap gap-2">
            {books.verifications.length > 0 ? (
              <a
                href={sieHref}
                download
                className="inline-flex h-9 items-center gap-2 rounded-sm border border-line-strong bg-surface px-3.5 text-base text-fg transition-colors hover:border-line-control hover:bg-hover"
              >
                Ladda ned SIE-fil
              </a>
            ) : null}
            {canEdit && books.status.configured && books.verifications.length > 0 ? (
              <DeliverButton month={month} label={books.status.label} />
            ) : null}
          </div>
        </div>
        {!books.status.configured ? (
          <StateMessage
            compact
            kind="not-configured"
            message={books.status.detail}
            action={
              books.verifications.length > 0
                ? { label: "Ladda ned SIE-fil", href: sieHref }
                : undefined
            }
          />
        ) : null}
        {books.error ? (
          <StateMessage
            kind="error"
            message={books.error}
            detail="Kontoplanen finns under Inställningar."
            action={{ label: "Öppna inställningar", href: "/installningar" }}
          />
        ) : books.verifications.length > 0 ? (
          <div className="grid grid-cols-1 gap-x-8 gap-y-10 lg:grid-cols-12">
            <div className="min-w-0 lg:col-span-7">
              <VerificationTable rows={verificationRows} month={month} />
            </div>
            <div className="flex min-w-0 flex-col gap-4 lg:col-span-5">
              <AccountTable rows={books.accountTotals} month={month} totals={accountTotals} />
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

      {/* 03 Kassaflöde */}
      <section aria-labelledby="kassaflode" className={SECTION}>
        <SectionHeader
          id="kassaflode"
          index={3}
          eyebrow="Kassaflöde · per månad"
          title={
            cash.result
              ? `Netto ${signedKr(cash.result.totals.actual.netOre)} hittills, ${signedKr(
                  cash.result.totals.forecast.netOre,
                )} i prognos.`
              : "Kassaflöde per månad."
          }
          aside={cash.result ? cash.result.summary : (cash.error ?? undefined)}
        />
        {cash.result ? (
          <div className="grid grid-cols-1 gap-x-8 gap-y-8 lg:grid-cols-12">
            <div className="min-w-0 lg:col-span-8">
              <CashflowTable rows={cashRows} />
            </div>
            <Panel className="lg:col-span-4">
              <PanelSection label="Så räknas prognosen">
                <ul className="flex list-none flex-col gap-2 text-sm text-muted">
                  {cash.result.assumptions.map((a) => (
                    <li key={a}>{a}</li>
                  ))}
                </ul>
              </PanelSection>
            </Panel>
          </div>
        ) : (
          <StateMessage
            kind="error"
            message={cash.error ?? "Kassaflödet kunde inte räknas fram."}
          />
        )}
      </section>

      {/* 04 Fasta kostnader */}
      <section aria-labelledby="fasta-kostnader" className={SECTION}>
        <SectionHeader
          id="fasta-kostnader"
          index={4}
          eyebrow={`Fasta kostnader · ${when}`}
          title={
            at && at.fixedCostOre > 0
              ? `Vinst ${sek(at.profitAfterFixedOre)} efter fasta kostnader på ${sek(at.fixedCostOre)}.`
              : "Inga fasta kostnader i perioden."
          }
          aside={fixed.allocation ? fixed.allocation.summary : (fixed.error ?? undefined)}
        />
        {at ? (
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
            message="Inga fasta kostnader är registrerade."
            detail="Försäkring, programvara och transport dras från vinsten per dag de gäller."
          />
        ) : null}
      </section>
    </div>
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

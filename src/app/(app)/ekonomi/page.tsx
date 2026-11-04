import type { Metadata } from "next";
import { AiPageLine } from "@/components/assistant/panel-context";
import { Suspense } from "react";

import { Panel, PanelSection } from "@/components/ui/frame";
import { Skeleton, TableSkeleton } from "@/components/ui/skeleton";
import { MobileFold } from "@/components/ui/mobile-fold";
import { MobileMore } from "../_mobil/mobile-more";
import { SectionHeader } from "@/components/ui/section-header";
import { StateMessage } from "@/components/ui/state-message";
import { formatDate, formatDateTime, formatInt, NBSP } from "@/lib/format";
import {
  currentViewer,
  loadCashflowFor,
  loadFixedCostsFor,
  loadReconciliationFor,
  PAYOUT_FILE_COLUMNS,
} from "@/server/accounting";
import { loadPeriod, requireRoute } from "@/server/data/core";

import { EconomyKpis, type EconomyKpi } from "./_components/bits";
import { BokforingSection } from "./_components/bokforing-section";
import { FixedCosts, type FixedCostRow } from "./_components/fixed-costs";
import { PayoutUpload } from "./_components/payout-upload";
import { ReconciliationList } from "./_components/reconciliation";
import { CashflowTable } from "./_components/tables";
import { pickView, ViewTabs } from "../rapporter/_components/view-tabs";
import { cashflowHeadline, cashPhase, economyHeadline } from "./_lib/headline";
import { isoToDate, periodShort, plural, sek, sentence } from "./_lib/view";

export const metadata: Metadata = { title: "Ekonomi" };

type SearchParams = Record<string, string | string[] | undefined>;

const SECTION =
  "rise flex scroll-mt-28 flex-col gap-8 pb-12 max-md:gap-5 max-md:pb-8 md:gap-10 md:pb-16";

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

  // Bokföringen (en rad per månad med månadspaketet) strömmar in i sin sektion (Suspense).
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
  const [rec, cash, fixed] = await Promise.all([
    loadReconciliationFor(viewer, p.period),
    loadCashflowFor(viewer, ctx.today, p.dataStart),
    loadFixedCostsFor(viewer, p.period, ctx.today),
  ]);

  const result = rec.result;
  // Varje flik har sin egen rubrik (Avstämningens "Inga utbetalningar inlästa." passar inte
  // på Kassaflöde eller Fasta kostnader).
  const headline =
    view === "kassaflode"
      ? cashflowHeadline(cash.result, ctx.today, cash.payoutsTracked)
      : view === "fasta"
        ? {
            title: "Fasta kostnader.",
            aside: "Hyra, el, försäkring och annat som kommer varje månad.",
          }
        : economyHeadline(result, cash.result, p.period, ctx.today, cash.payoutsTracked);
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
      phase: cashPhase(b.phase, cash.payoutsTracked),
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

  // Bokföring är en egen underflik i menyn: egen rubrik, inga Ekonomi-flikar ovanför.
  const bookkeeping = view === "bokforing";

  return (
    <div className="mx-auto flex w-full max-w-[1280px] flex-col px-4 pt-8 md:px-8 md:pt-12">
      {bookkeeping ? null : (
        <div
          className="rise flex flex-col gap-6 pb-10 max-md:relative max-md:gap-4 max-md:pb-6 md:pb-12"
          style={{ "--i": 0 } as React.CSSProperties}
        >
          <SectionHeader
            as="h1"
            size="xl"
            eyebrow={`Ekonomi · ${p.days}${NBSP}d`}
            title={headline.title}
            aside={headline.aside}
            meta={[{ label: "Period", value: when }]}
            // Mobil: perioden står i raden överst.
            className="max-md:pr-10 max-md:[&_dl]:hidden"
          />
          {/* Mobil: AI-frågan bakom "⋯" uppe till höger; från md som förut. */}
          <MobileMore
            label="Fler val för ekonomin"
            className="max-md:absolute max-md:-top-2 max-md:-right-2"
          >
            <AiPageLine
              metric="ekonomin för perioden"
              route="ekonomi"
              className="md:mt-4"
              menuItem
            />
          </MobileMore>
          {scoped ? (
            <p className="meta text-subtle">Alla butiker · filtret gäller inte här</p>
          ) : null}
          <ViewTabs
            label="Vy"
            value={view}
            hrefFor={hrefFor}
            tabs={[
              { value: "avstamning", label: "Avstämning" },
              { value: "kassaflode", label: "Kassaflöde" },
              { value: "fasta", label: "Fasta kostnader" },
            ]}
          />
        </div>
      )}

      {view === "avstamning" ? (
        <section
          aria-labelledby="avstamning"
          className={SECTION}
          style={{ "--i": 1 } as React.CSSProperties}
        >
          {result ? (
            <MobileFold summary="Fler siffror" meta={formatInt(kpis.length)}>
              <EconomyKpis items={kpis} label={`Avstämning · ${when}`} headingLevel={2} />
            </MobileFold>
          ) : null}
          <SectionHeader
            id="avstamning"
            size="md"
            title="Utbetalningar."
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
                // Mobil: uppladdningen står direkt under, så knappen hit behövs inte.
                <div className="max-md:[&_a]:hidden">
                  <StateMessage
                    kind="empty"
                    message="Ingen utbetalning i perioden."
                    action={
                      canEdit
                        ? { label: "Ladda upp utbetalningar", href: "#ladda-upp-utbetalningar" }
                        : undefined
                    }
                  />
                </div>
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
                // Mobil: med utbetalningar i perioden är uppladdningen hopfälld; utan står
                // den öppen som sidans enda knapp.
                <MobileFold summary="Ladda upp fil" defaultOpen={!result}>
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
                </MobileFold>
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

      {view === "bokforing" ? (
        <Suspense fallback={<BookkeepingSkeleton />}>
          <BokforingSection viewer={viewer} today={ctx.today} canEdit={canEdit} asPage />
        </Suspense>
      ) : null}

      {view === "kassaflode" ? (
        <section
          aria-labelledby="kassaflode"
          className={SECTION}
          style={{ "--i": 1 } as React.CSSProperties}
        >
          <SectionHeader id="kassaflode" size="md" title="Per månad." />
          {cash.result ? (
            // Tabellen får hela bredden (Netto syns utan att scrolla); förklaringen under.
            <div className="flex flex-col gap-6">
              <div className="min-w-0">
                <CashflowTable rows={cashRows} />
              </div>
              <details className="rounded-md border border-line bg-surface p-4 lg:max-w-[720px]">
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
            <StateMessage kind="empty" compact message="Inga fasta kostnader." />
          ) : null}
        </section>
      ) : null}
    </div>
  );
}

/** Platshållaren medan bokföringen räknas. */
function BookkeepingSkeleton() {
  return (
    <section aria-busy="true" aria-label="Laddar bokföringen" className={SECTION}>
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

/** En mening om utbetalningarna som rubriken inte redan säger. */
function reconciliationFact(result: {
  payouts: readonly { reference: string; paidOn: string; expected: { orders: number } }[];
}): string {
  const orders = result.payouts.reduce((s, x) => s + x.expected.orders, 0);
  const last = [...result.payouts].sort((a, b) => (a.paidOn < b.paidOn ? 1 : -1))[0];
  return `${plural(result.payouts.length, "utbetalning", "utbetalningar")} · ${plural(
    orders,
    "order",
    "order",
  )}${last ? ` · senast ${last.reference}` : ""}.`;
}

/** Fördelningen av gemensamma kostnader i en mening. */
function allocationFact(
  allocation: {
    method: "revenue" | "equal";
    rows: readonly { key: string; kind: string; sharedFixedOre: number; shareBp: number | null }[];
  },
  codes: ReadonlyMap<string, string>,
): string {
  const how = allocation.method === "revenue" ? "Delas efter intäkt" : "Delas lika per automat";
  const top = allocation.rows
    .filter((r) => r.kind === "machine" && r.sharedFixedOre > 0)
    .sort((a, b) => b.sharedFixedOre - a.sharedFixedOre)[0];
  if (!top) return `${how}.`;
  const share = top.shareBp === null ? "" : ` (${Math.round(top.shareBp / 100)}${NBSP}%)`;
  return `${how}. Mest: ${codes.get(top.key) ?? "en automat"}, ${sek(top.sharedFixedOre)}${share}.`;
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

import type { Metadata } from "next";
import { AiPageLine } from "@/components/assistant/panel-context";
import { Suspense } from "react";

import { MobileFold } from "@/components/ui/mobile-fold";
import { MobileMore } from "../_mobil/mobile-more";
import { StateMessage } from "@/components/ui/state-message";
import { ButtonLink } from "@/components/v2/button";
import { Card, CardBody } from "@/components/v2/card";
import { PAGE_BODY, PageIntro } from "@/components/v2/page-intro";
import { V2Page, headerDate } from "@/components/v2/shell/page";
import { SubNav } from "@/components/v2/sub-nav";
import { SkeletonCard } from "@/components/v2/skeleton";
import { Section } from "@/components/v2/section";
import { formatDate, formatDateTime, formatInt, NBSP } from "@/lib/format";
import {
  currentViewer,
  loadCashflowFor,
  loadFixedCostsFor,
  loadPayoutQuestionFor,
  loadReconciliationFor,
  PAYOUT_FILE_COLUMNS,
} from "@/server/accounting";
import { loadPeriod, requestStoreShareView, requireRoute } from "@/server/data/core";

import { EconomyKpis, type EconomyKpi } from "./_components/bits";
import { BokforingSection } from "./_components/bokforing-section";
import { FixedCosts, type FixedCostRow } from "./_components/fixed-costs";
import { PayoutQuestion } from "./_components/payout-question";
import { PayoutUpload } from "./_components/payout-upload";
import { ReconciliationList } from "./_components/reconciliation";
import { CashflowTable } from "./_components/tables";
import { pickView, ViewTabs } from "../rapporter/_components/view-tabs";
import { cashflowHeadline, cashPhase, economyHeadline, payoutQuestionText } from "./_lib/headline";
import { economyTabs, hasFixedCosts, showAddFixedLink } from "./_lib/tabs";
import { isoToDate, periodShort, plural, sek, sentence } from "./_lib/view";

export const metadata: Metadata = { title: "Ekonomi" };

type SearchParams = Record<string, string | string[] | undefined>;

const SECTION = "flex scroll-mt-28 flex-col gap-[14px] max-[900px]:gap-3";

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
  const storeShare = await requestStoreShareView();
  const [rec, cash, fixed, question] = await Promise.all([
    loadReconciliationFor(viewer, p.period),
    loadCashflowFor(viewer, ctx.today, p.dataStart),
    // Vinsten före butikernas andel, efter den med vyknappen (som övriga sidor).
    loadFixedCostsFor(viewer, p.period, ctx.today, { storeShare }),
    // "Vad betalade Nayax?": nästa period utan utbetalning (bara den som får svara).
    view === "avstamning" && ctx.canEdit ? loadPayoutQuestionFor(viewer, ctx.today) : null,
  ]);

  const result = rec.result;
  // Utan utbetalning i perioden är frågan sidans rubrik; annars står den i en ruta.
  const askFirst = question !== null && !result;
  // Fliken Fasta kostnader bara när organisationen har någon (src/lib/cost-lines.ts).
  const fixedActive = hasFixedCosts(fixed.costs);
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
        : askFirst
          ? payoutQuestionText(question.period, question.expected.payoutOre, ctx.today)
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
  // Nayax-rapportens egna rader (avdrag, automater) per referens.
  const statements = Object.fromEntries(
    rec.payouts.flatMap((x) => (x.statement ? [[x.reference, x.statement] as const] : [])),
  );

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
    <V2Page
      title={bookkeeping ? "Bokföring" : "Ekonomi"}
      date={headerDate(new Date(ctx.now), ctx.timeZone)}
      period={!bookkeeping}
    >
      <SubNav />
      <div className={PAGE_BODY}>
        {bookkeeping ? null : (
          <div className="flex flex-col gap-3">
            <PageIntro
              title={headline.title}
              aside={headline.aside}
              facts={[{ label: "Period", value: when }]}
              actions={
                // Mobil: AI-frågan bakom "⋯"; från md som förut.
                <MobileMore label="Fler val för ekonomin">
                  <AiPageLine metric="ekonomin för perioden" route="ekonomi" menuItem />
                </MobileMore>
              }
            />
            {scoped ? (
              <p className="text-v2-sm text-v2-mute">Alla butiker · filtret gäller inte här</p>
            ) : null}
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <ViewTabs
                label="Vy"
                value={view}
                hrefFor={hrefFor}
                tabs={economyTabs(fixedActive, view)}
              />
              {showAddFixedLink(fixedActive, view, ctx.canEdit) ? (
                <ButtonLink href={hrefFor("fasta")} size="sm" touch>
                  + Lägg till fast kostnad
                </ButtonLink>
              ) : null}
            </div>
          </div>
        )}

        {view === "avstamning" ? (
          <section aria-labelledby="avstamning" className={SECTION}>
            {result ? (
              <EconomyKpis items={kpis} label={`Avstämning · ${when}`} headingLevel={2} />
            ) : null}
            {question ? (
              <div className="min-w-0">
                <PayoutQuestion
                  key={`${question.period.start}-${question.period.end}`}
                  period={question.period}
                  expectedOre={question.expected.payoutOre}
                  today={ctx.today}
                  lead={!askFirst}
                />
              </div>
            ) : null}
            <div className="v2-cols">
              <div className="v2-card">
                <div className="v2-card-hd flex-wrap gap-y-1">
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <h2 id="avstamning">Utbetalningar</h2>
                    {result || askFirst ? (
                      <p className="text-v2-sm text-v2-mute">
                        {result
                          ? reconciliationFact(result)
                          : "Inga ännu. Ladda upp rapporten från Nayax, eller skriv in beloppet ovan."}
                      </p>
                    ) : null}
                  </div>
                </div>
                <div className="v2-card-body flex flex-col gap-4">
                  {result ? (
                    <ReconciliationList
                      result={result}
                      today={ctx.today}
                      canEdit={canEdit}
                      period={p.period}
                      payoutIds={payoutIds}
                      statements={statements}
                      cardFeeBp={rec.cardFeeBp}
                      cardFeeFrom={rec.cardFeeDefaultFrom}
                    />
                  ) : askFirst ? null : (
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
              </div>
              <div className="v2-stack">
                {canEdit ? (
                  // Mobil: med utbetalningar i perioden är uppladdningen hopfälld; utan står
                  // den öppen (rapporten från Nayax är det vanliga sättet).
                  <Card
                    title="Ladda upp utbetalningar"
                    id="ladda-upp-utbetalningar"
                    className="scroll-mt-28"
                  >
                    <CardBody>
                      <MobileFold summary="Ladda upp rapport" defaultOpen={!result}>
                        <div>
                          <PayoutUpload
                            today={ctx.today}
                            cardFeeFrom={rec.cardFeeDefaultFrom}
                            shownPayoutIds={result ? rec.payouts.map((x) => x.id) : []}
                            columns={{
                              payouts: PAYOUT_FILE_COLUMNS.payouts.join(", "),
                              lines: PAYOUT_FILE_COLUMNS.lines.join(", "),
                            }}
                          />
                        </div>
                      </MobileFold>
                    </CardBody>
                  </Card>
                ) : null}
                <details className="group v2-card">
                  <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-3 px-[18px] text-v2-md font-[650] text-v2-ink hover:bg-v2-hover [&::-webkit-details-marker]:hidden">
                    <span>Logg och filer</span>
                    <span className="tnum text-v2-sm font-[450] text-v2-mute">
                      {formatInt(rec.reviews.length)} · {formatInt(rec.imports.length)}
                    </span>
                  </summary>
                  <div className="flex flex-col gap-5 border-t border-v2-line px-[18px] py-4">
                    <div className="flex flex-col gap-2">
                      <h3 className="text-v2-sm font-[550] text-v2-ink">
                        Logg <span className="text-v2-mute">· {formatInt(rec.reviews.length)}</span>
                      </h3>
                      {rec.reviews.length === 0 ? (
                        <p className="text-v2-sm text-v2-mute">Inget utrett ännu.</p>
                      ) : (
                        <ol className="flex flex-col gap-3">
                          {rec.reviews.slice(0, 12).map((r) => (
                            <li
                              key={r.id}
                              className="flex flex-col gap-0.5 text-v2-sm max-md:min-h-11 max-md:justify-center"
                            >
                              <span className="text-v2-xs text-v2-mute">
                                {formatDateTime(new Date(r.createdAt))} · {r.actor ?? "System"}
                              </span>
                              <span className="text-v2-ink">
                                {r.action === "investigated" ? "Utredd" : "Öppnad igen"}:{" "}
                                <span className="text-v2-mute">
                                  {deviationTitle.get(r.deviationKey) ??
                                    deviationFallback(r.deviationKey)}
                                </span>
                              </span>
                              {r.note ? <span className="text-v2-mute">{r.note}</span> : null}
                            </li>
                          ))}
                        </ol>
                      )}
                    </div>
                    <div className="flex flex-col gap-2">
                      <h3 className="text-v2-sm font-[550] text-v2-ink">
                        Uppladdade filer{" "}
                        <span className="text-v2-mute">· {formatInt(rec.imports.length)}</span>
                      </h3>
                      {rec.imports.length === 0 ? (
                        <p className="text-v2-sm text-v2-mute">Ingen fil ännu.</p>
                      ) : (
                        <ol className="flex flex-col gap-3">
                          {rec.imports.slice(0, 6).map((i) => (
                            <li
                              key={i.id}
                              className="flex flex-col gap-0.5 text-v2-sm max-md:min-h-11 max-md:justify-center"
                            >
                              <span className="truncate text-v2-ink">{i.fileName}</span>
                              <span className="text-v2-xs text-v2-mute">
                                {formatDateTime(new Date(i.createdAt))} · {formatInt(i.rowsNew)} nya
                                ·{" "}
                                {i.rowsDuplicate === 1
                                  ? "1 dubblett"
                                  : `${formatInt(i.rowsDuplicate)} dubbletter`}{" "}
                                · {formatInt(i.rowsConflict + i.rowsError)} fel
                              </span>
                            </li>
                          ))}
                        </ol>
                      )}
                    </div>
                  </div>
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
          <section aria-labelledby="kassaflode" className={SECTION}>
            {cash.result ? (
              // Tabellen får hela bredden (Netto syns utan att scrolla); förklaringen under.
              <>
                <div className="v2-card">
                  <div className="v2-card-hd">
                    <h2 id="kassaflode">Per månad</h2>
                  </div>
                  <div className="v2-card-body min-w-0">
                    <CashflowTable rows={cashRows} />
                  </div>
                </div>
                <details className="group v2-card">
                  <summary className="flex min-h-12 cursor-pointer list-none items-center px-[18px] text-v2-md font-[650] text-v2-ink hover:bg-v2-hover [&::-webkit-details-marker]:hidden">
                    Så räknas prognosen
                  </summary>
                  <ul className="flex list-none flex-col gap-2 border-t border-v2-line px-[18px] py-4 text-v2-sm text-v2-mute">
                    <li>{cash.payoutCycleNote}</li>
                    {replenishmentNote ? <li>{replenishmentNote}</li> : null}
                    {cash.result.assumptions.map((a) => (
                      <li key={a}>{a}</li>
                    ))}
                  </ul>
                </details>
              </>
            ) : (
              <Card title="Per månad">
                <CardBody>
                  <StateMessage
                    kind="error"
                    message={cash.error ?? "Kassaflödet kunde inte räknas fram."}
                  />
                </CardBody>
              </Card>
            )}
          </section>
        ) : null}

        {view === "fasta" ? (
          <section aria-labelledby="fasta-kostnader" className={SECTION}>
            <Section
              id="fasta-kostnader"
              title={
                at && at.fixedCostOre > 0
                  ? `Vinst ${sek(at.profitAfterFixedOre)} efter fasta kostnader på ${sek(at.fixedCostOre)}.`
                  : at
                    ? `Vinst ${sek(at.profitOre)}, inga fasta kostnader i perioden.`
                    : "Fasta kostnader."
              }
              sub={
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
                  {
                    id: "before",
                    label: storeShare ? "Vår del före fasta" : "Vinst före fasta",
                    value: at.profitOre,
                    unit: "ore",
                  },
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
            <div className="v2-card px-[18px] py-3">
              <FixedCosts
                rows={fixedRows}
                machines={fixed.machines
                  .filter((m) => !m.archived)
                  .map((m) => ({ id: m.id, code: m.code, name: m.name }))}
                canEdit={canEdit}
                today={ctx.today}
                periodLabel={when}
              />
            </div>
            {fixedRows.length === 0 ? (
              <p className="v2-card v2-empty">Inga fasta kostnader.</p>
            ) : null}
          </section>
        ) : null}
      </div>
    </V2Page>
  );
}

/** Platshållaren medan bokföringen räknas. */
function BookkeepingSkeleton() {
  return (
    <section aria-busy="true" aria-label="Laddar bokföringen" className={SECTION}>
      <SkeletonCard rows={3} />
      <SkeletonCard rows={6} />
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

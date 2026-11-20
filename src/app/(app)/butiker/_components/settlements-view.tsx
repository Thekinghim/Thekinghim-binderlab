import Link from "next/link";
import type { CSSProperties } from "react";

import { StatusTag } from "@/components/ui/status-tag";
import { formatSek } from "@/lib/format";
import type { Viewer } from "@/server/data/core/loaders";
import { CLOSE_TRIGGER_TEXT } from "@/server/periods/model";
import { loadPeriodOverviewFor } from "@/server/periods/service";
import {
  correctionStep,
  correctionsTotal,
  paidCompareLine,
  paidDifferenceLine,
  payoutDueDate,
  STATE_LABEL,
} from "@/server/settlements/model";
import { dayRangeText, leftLine } from "@/server/settlements/advance";
import { loadPaymentListFor, type PaymentListItem } from "@/server/settlements/payments";
import { loadSettlementPageFor, type SettlementRow } from "@/server/settlements/service";

import {
  CarryDifferenceButton,
  CreateSettlementsButton,
  InviteStoreButton,
  MarkPaidButton,
  RecomputeButton,
  RemoveCorrectionButton,
  UndoPaidButton,
} from "./settlement-actions";
import { DeletePaymentButton, RegisterPaymentButton } from "./payment-actions";
import { CloseMonthButton, ReopenMonthButton } from "../../_manad/period-controls";
import { MoneyCount } from "./money-count";
import {
  exactKr,
  missingLines,
  noAgreementLine,
  settlementIdleHeadline,
} from "../_lib/settlement-headline";

const kr = (ore: number) => formatSek(ore / 100);
const rise = (i: number) => ({ "--i": i }) as CSSProperties;

const MONTHS = [
  "januari",
  "februari",
  "mars",
  "april",
  "maj",
  "juni",
  "juli",
  "augusti",
  "september",
  "oktober",
  "november",
  "december",
];
const monthLabel = (m: string) => `${MONTHS[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;
const dayLabel = (d: string) =>
  `${Number(d.slice(8, 10))} ${MONTHS[Number(d.slice(5, 7)) - 1]!.slice(0, 3)}.`;

/**
 * Butiker → Utbetalning: överst summan att betala till butikerna, sedan avräkningarna
 * (betala med en knapp) och sist butikernas tillgång till butiksportalen (bjud in med en
 * knapp). Butiker utan avtal förra månaden (räknas som 0 %) varnas före "Skapa".
 */
export async function SettlementsView({ viewer, today }: { viewer: Viewer; today: string }) {
  const [page, periods, payments] = await Promise.all([
    loadSettlementPageFor(viewer),
    loadPeriodOverviewFor(viewer),
    loadPaymentListFor(viewer),
  ]);
  const closedBy = new Map(periods.closed.map((c) => [c.month as string, c]));
  const reopenedBy = new Map(periods.reopened.map((r) => [r.month as string, r]));
  // Obetalda har beloppet räknat nu. En som inte kan räknas (t.ex. saknat inköpspris)
  // räknas inte in i summan och kan inte betalas.
  // Det som redan betalats i förskott för månaden dras av (Kvar att betala).
  const unpaid = page.rows.filter((r) => r.state === "unpaid" && !r.blocked && r.leftOre > 0);
  const blocked = page.rows.filter((r) => r.blocked);
  const toPay = unpaid.reduce((n, r) => n + r.leftOre, 0);
  const unpaidStores = new Set(unpaid.map((r) => r.storeId)).size;
  const firstDue = unpaid.length ? unpaid.map((r) => payoutDueDate(r.month)).sort()[0]! : null;
  const late = firstDue !== null && firstDue < today;
  const idle = settlementIdleHeadline({
    blocked: blocked.length,
    failed: page.failed.length,
    missing: page.missing.length,
    monthLabel: monthLabel(page.month),
  });
  const noDeal = new Map(page.noAgreement.map((g) => [g.storeId, g]));
  const byMonth = new Map<string, SettlementRow[]>();
  for (const r of page.rows) {
    const list = byMonth.get(r.month);
    if (list) list.push(r);
    else byMonth.set(r.month, [r]);
  }

  return (
    <div className="mx-auto flex w-full max-w-[960px] flex-col gap-10 px-4 pt-8 pb-16 md:px-8 md:pt-12">
      <header className="rise flex flex-col gap-3" style={rise(0)}>
        <p className="label text-subtle">Att betala till butikerna</p>
        <h1 className="text-3xl font-medium md:text-4xl">
          {unpaid.length === 0 ? idle.title : <MoneyCount ore={toPay} id="avrakning-att-betala" />}
        </h1>
        <p className={`text-base ${late ? "text-signal-fg" : "text-muted"}`}>
          {unpaid.length === 0
            ? idle.aside
            : `${unpaidStores === 1 ? "1 butik" : `${unpaidStores} butiker`} · ${late ? "försenad, skulle betalats" : "senast"} ${dayLabel(firstDue!)}`}
        </p>
      </header>

      {page.failed.length > 0 ? (
        <section className="rise flex flex-col gap-2" style={rise(1)} aria-label="Kan inte räknas">
          {page.failed.map((f) => (
            <p
              key={`${f.storeId}-${f.month}`}
              className="rounded-md border border-signal-line px-4 py-3 text-base text-fg"
            >
              {f.storeName}
              {f.month === page.month ? "" : `, ${monthLabel(f.month)}`}: kan inte räknas.{" "}
              {f.message}{" "}
              <Link href="/inkopspriser" className="underline underline-offset-4">
                Inköpspriser →
              </Link>
            </p>
          ))}
        </section>
      ) : null}

      {page.missing.length > 0 ? (
        <section
          className={`rise flex flex-col gap-3 rounded-md border px-4 py-3 ${
            page.missing.some((m) => noDeal.has(m.storeId)) ? "border-signal-line" : "border-line"
          }`}
          style={rise(1)}
          aria-label="Saknas"
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-col gap-1 text-base text-fg">
              {missingLines(page.missing, page.month).map((line) => (
                <p key={line} data-missing-line>
                  {line}
                </p>
              ))}
            </div>
            {page.canEdit ? (
              <CreateSettlementsButton
                count={page.missing.length}
                monthLabel={
                  page.missing.every((m) => m.month === page.month)
                    ? MONTHS[Number(page.month.slice(5, 7)) - 1]!
                    : null
                }
              />
            ) : null}
          </div>
          <NoAgreementLines
            gaps={page.missing.flatMap((m) =>
              m.month === page.month ? (noDeal.get(m.storeId) ?? []) : [],
            )}
            canEdit={page.canEdit}
          />
        </section>
      ) : null}

      <section className="rise flex flex-col gap-6" style={rise(2)} aria-label="Avräkningar">
        {page.rows.length === 0 ? (
          page.missing.length > 0 ? null : (
            <p className="text-base text-muted">Ingen avräkning än.</p>
          )
        ) : (
          [...byMonth.entries()].map(([month, rows]) => (
            <div key={month} className="flex flex-col gap-2" id={`avrakning-${month}`}>
              <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
                <h2 className="label text-subtle">{monthLabel(month)}</h2>
                {closedBy.has(month) ? (
                  <div className="flex flex-wrap items-center gap-3" data-month-closed={month}>
                    <span className="text-sm text-muted">
                      Stängd: {CLOSE_TRIGGER_TEXT[closedBy.get(month)!.trigger]}. Inget ändras här.
                    </span>
                    {periods.canReopen ? (
                      <ReopenMonthButton month={month} monthLabel={monthLabel(month)} />
                    ) : null}
                  </div>
                ) : reopenedBy.has(month) ? (
                  <div className="flex flex-wrap items-center gap-3" data-month-reopened={month}>
                    <span className="text-sm text-signal-fg">
                      Öppnad igen
                      {reopenedBy.get(month)!.reason ? `: ${reopenedBy.get(month)!.reason}` : ""}
                    </span>
                    {periods.canClose ? (
                      <CloseMonthButton month={month} monthLabel={monthLabel(month)} />
                    ) : null}
                  </div>
                ) : null}
              </div>
              <ul className="flex flex-col border-t border-line">
                {rows.map((r) => (
                  <li
                    key={r.id}
                    className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 border-b border-line py-3"
                  >
                    <div className="flex min-w-0 flex-col gap-0.5">
                      <span className="truncate text-md text-fg">{r.storeName}</span>
                      {r.month === page.month && noDeal.has(r.storeId) && !r.paidOn ? (
                        <span className="text-sm text-signal-fg" data-no-agreement>
                          {noAgreementLine(noDeal.get(r.storeId)!).replace(`${r.storeName}: `, "")}{" "}
                          <Link
                            href={`/butiker/${r.storeId}?vy=avtal`}
                            className="underline underline-offset-4"
                          >
                            Lägg in avtal →
                          </Link>
                        </span>
                      ) : null}
                      <span className="meta truncate text-subtle">
                        {r.state === "paid" && r.paidOn
                          ? `Betald ${dayLabel(r.paidOn)}${r.paidFromPayments ? " med betalningar" : ""}`
                          : (r.statement?.modelText ?? "")}
                      </span>
                      {r.advanceText ? (
                        <span className="text-sm text-fg" data-advance={r.id}>
                          {r.advanceText}.
                          {!r.paidOn && !r.blocked ? (
                            <>
                              {" "}
                              Avräkningen {exactKr(r.amountOre)}.{" "}
                              <span className={r.leftOre < 0 ? "text-signal-fg" : ""}>
                                {leftLine(r.leftOre)}.
                              </span>
                            </>
                          ) : null}
                        </span>
                      ) : null}
                      {r.blocked ? (
                        <span className="text-sm text-signal-fg">
                          Kan inte räknas: {r.blocked}{" "}
                          <Link href="/inkopspriser" className="underline underline-offset-4">
                            Inköpspriser →
                          </Link>
                        </span>
                      ) : !r.paidOn && r.storedAmountOre !== r.amountOre ? (
                        <span className="meta text-subtle">
                          Nytt belopp, var {kr(Math.abs(r.storedAmountOre))}
                        </span>
                      ) : null}
                      <PaidCompare row={r} canEdit={page.canEdit} />
                      {!r.paidOn
                        ? r.corrections.map((c) => (
                            <span
                              key={c.sourceId}
                              className="flex flex-wrap items-center gap-x-3 text-sm text-fg"
                              data-correction
                            >
                              {correctionStep(c).label}: {c.amountOre < 0 ? "−" : "+"}
                              {exactKr(Math.abs(c.amountOre))}
                              {page.canEdit ? (
                                <RemoveCorrectionButton
                                  targetId={r.id}
                                  sourceId={c.sourceId}
                                  label={correctionStep(c).label}
                                />
                              ) : null}
                            </span>
                          ))
                        : null}
                      {r.statement && r.statement.steps.length > 0 ? (
                        <details className="group text-sm">
                          <summary className="cursor-pointer list-none text-muted hover:text-fg [&::-webkit-details-marker]:hidden">
                            Så räknas det
                          </summary>
                          <dl className="fade-in mt-2 flex flex-col gap-1">
                            {r.statement.steps.map((s, i) => (
                              <div key={i} className="flex justify-between gap-4">
                                <dt className="min-w-0 text-muted">{s.label}</dt>
                                <dd className="tnum shrink-0 text-fg">{kr(s.amountOre)}</dd>
                              </div>
                            ))}
                          </dl>
                        </details>
                      ) : null}
                    </div>
                    <div className="flex flex-wrap items-center gap-3">
                      <span className="tnum text-lg text-fg">
                        {r.blocked
                          ? "–"
                          : kr(
                              Math.abs(
                                r.paidOn ? r.paidOre : r.advanceOre > 0 ? r.leftOre : r.amountOre,
                              ),
                            )}
                      </span>
                      <StatusTag
                        status={
                          r.blocked
                            ? "critical"
                            : r.state === "unpaid" || r.state === "owed"
                              ? "warning"
                              : "ok"
                        }
                      >
                        {r.blocked ? "Inte klar" : STATE_LABEL[r.state]}
                      </StatusTag>
                      <a
                        href={`/butiker/avrakning/${r.id}`}
                        className="text-sm text-muted underline-offset-4 hover:text-fg hover:underline"
                      >
                        PDF
                      </a>
                      {page.canEdit && !r.blocked && r.storedAmountOre !== r.amountOre ? (
                        <RecomputeButton id={r.id} />
                      ) : null}
                      {page.canEdit &&
                      !r.blocked &&
                      (r.state === "unpaid" || r.state === "owed") ? (
                        <>
                          <MarkPaidButton
                            id={r.id}
                            storeName={r.storeName}
                            amountOre={r.amountOre}
                            advanceOre={r.advanceOre}
                            reportOre={
                              r.reportOre === null || r.reportOre === 0
                                ? null
                                : r.reportOre + correctionsTotal(r.corrections)
                            }
                            monthLabel={monthLabel(r.month)}
                            today={today}
                          />
                        </>
                      ) : null}
                      {page.canEdit && r.state === "paid" && !r.paidFromPayments ? (
                        <UndoPaidButton id={r.id} storeName={r.storeName} />
                      ) : null}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          ))
        )}
      </section>

      <PaymentsSection
        payments={payments}
        canEdit={page.canEdit}
        stores={page.stores}
        today={today}
      />

      {page.portal ? (
        <section className="rise flex flex-col gap-3" style={rise(3)} aria-labelledby="portal">
          <h2 id="portal" className="label text-subtle">
            Butiksportal
          </h2>
          <ul className="flex flex-col border-t border-line">
            {page.portal.map((p) => (
              <li
                key={p.storeId}
                className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 border-b border-line py-3"
              >
                <span className="min-w-0 truncate text-fg">{p.storeName}</span>
                <div className="flex items-center gap-3">
                  {p.users > 0 ? (
                    <StatusTag status="ok">Inne</StatusTag>
                  ) : p.pending > 0 ? (
                    <StatusTag status="neutral">Inbjuden</StatusTag>
                  ) : (
                    <StatusTag status="warning">Inte inbjuden</StatusTag>
                  )}
                  {p.users === 0 ? (
                    <InviteStoreButton
                      storeId={p.storeId}
                      storeName={p.storeName}
                      email={p.email}
                      again={p.pending > 0}
                    />
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

/** Butikerna utan avtal förra månaden, med länk till "Lägg in avtal" på butikens sida. */
function NoAgreementLines({
  gaps,
  canEdit,
}: {
  gaps: readonly { storeId: string; storeName: string; days: number; whole: boolean }[];
  canEdit: boolean;
}) {
  if (gaps.length === 0) return null;
  return (
    <ul className="flex flex-col gap-1" data-no-agreement>
      {gaps.map((g) => (
        <li key={g.storeId} className="flex flex-wrap items-center gap-x-3 text-sm text-signal-fg">
          <span>{noAgreementLine(g)}</span>
          {canEdit ? (
            <Link
              href={`/butiker/${g.storeId}?vy=avtal`}
              className="inline-flex min-h-11 items-center text-fg underline underline-offset-4"
            >
              Lägg in avtal →
            </Link>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

/**
 * Under en betald avräkning när beloppen skiljer sig: betalt, rapporten butiken fick och
 * dagens uträkning, skillnaden och knappen som lägger den på nästa avräkning. Inget när
 * allt stämmer.
 */
function PaidCompare({ row, canEdit }: { row: SettlementRow; canEdit: boolean }) {
  if (!row.paidOn) return null;
  const line = paidCompareLine({
    paidOre: row.paidOre,
    reportOre: row.reportOre,
    liveOre: row.liveOre,
    correctedOre: row.correctedOre,
    correctionsOre: correctionsTotal(row.corrections),
  });
  if (!line && row.correctedOre === 0) return null;
  return (
    <div className="flex flex-col gap-1 text-sm" data-paid-compare={row.id}>
      {line ? <span className="text-signal-fg">{line}</span> : null}
      {row.correctedOre !== 0 ? (
        <span className="text-muted">
          Rättelse {row.correctedOre < 0 ? "−" : "+"}
          {exactKr(Math.abs(row.correctedOre))} ligger på en senare avräkning.
        </span>
      ) : null}
      {row.differenceOre !== 0 ? (
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-fg">
          {paidDifferenceLine(row.differenceOre)}
          {canEdit && row.carryTarget ? (
            <CarryDifferenceButton
              id={row.id}
              storeName={row.storeName}
              differenceOre={row.differenceOre}
              monthLabel={monthLabel(row.month)}
              targetMonthLabel={monthLabel(row.carryTarget.month)}
            />
          ) : (
            <span className="text-muted">
              Kan läggas på nästa avräkning när den finns (skapas den 1:a).
            </span>
          )}
        </span>
      ) : line && row.reportOre !== null && row.liveOre !== null ? (
        <Link href="/rapporter" className="text-muted underline underline-offset-4">
          Skapa en ny rapport till butiken →
        </Link>
      ) : null}
    </div>
  );
}

/**
 * Betalningar till butikerna för egna perioder (t.ex. 14 okt.–14 nov.): "Registrera
 * betalning" och listan, med vad varje del gör med månadens avräkning och "Ta bort".
 */
function PaymentsSection({
  payments,
  canEdit,
  stores,
  today,
}: {
  payments: readonly PaymentListItem[];
  canEdit: boolean;
  stores: readonly { id: string; name: string }[];
  today: string;
}) {
  if (payments.length === 0 && !canEdit) return null;
  return (
    <section className="rise flex flex-col gap-3" style={rise(3)} aria-labelledby="betalningar">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="betalningar" className="label text-subtle">
          Betalningar
        </h2>
        {canEdit && stores.length > 0 ? (
          <RegisterPaymentButton stores={stores} today={today} />
        ) : null}
      </div>
      {payments.length === 0 ? (
        <p className="text-base text-muted">
          Har du betalat en butik för andra dagar än en hel månad, till exempel 14 okt.–14 nov.?
          Registrera betalningen här, så dras den av på rätt avräkning.
        </p>
      ) : (
        <ul className="flex flex-col border-t border-line">
          {payments.map((p) => {
            const period = dayRangeText({ start: p.periodStart, end: p.periodEnd });
            return (
              <li
                key={p.id}
                className="flex flex-wrap items-start justify-between gap-x-6 gap-y-2 border-b border-line py-3"
                data-payment={p.id}
              >
                <div className="flex min-w-0 flex-col gap-0.5">
                  <span className="truncate text-md text-fg">
                    {p.storeName} · {period}
                  </span>
                  <span className="meta text-subtle">
                    Betald {dayLabel(p.paidOn)}
                    {p.note ? ` · ${p.note}` : ""}
                  </span>
                  <ul className="mt-1 flex flex-col gap-0.5 text-sm">
                    {p.parts.map((part) => (
                      <li key={part.month} className="flex flex-wrap gap-x-2">
                        <span className="text-fg">
                          {dayRangeText(part)}: {exactKr(part.amountOre)}
                        </span>
                        <span className="text-muted">{part.effect}</span>
                      </li>
                    ))}
                  </ul>
                </div>
                <div className="flex items-center gap-3">
                  <span className="tnum text-lg text-fg">{exactKr(p.amountOre)}</span>
                  {canEdit ? (
                    <DeletePaymentButton
                      id={p.id}
                      storeName={p.storeName}
                      amountOre={p.amountOre}
                      periodLabel={period}
                      blocked={p.deleteBlocked}
                    />
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

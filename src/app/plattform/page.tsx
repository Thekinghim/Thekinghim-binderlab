import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";

import type { CustomerState } from "@/analytics/subscriptions/billing";
import { StatusTag, type Status } from "@/components/ui/status-tag";
import { formatInt, formatPercent } from "@/lib/format";
import {
  STATE_LABEL,
  dayLabel,
  formatMoney,
  formatMoneyList,
  monthLabel,
  monthShort,
  plural,
} from "@/server/subscriptions/model";
import { loadPlatformFor, type PlatformRow } from "@/server/subscriptions/service";

import { MrrChart } from "./_components/mrr-chart";
import { PlanForm } from "./_components/plan-form";
import { requirePlatform } from "./_lib/context";

export const metadata: Metadata = { title: "Kunder" };

const STATE_STATUS: Record<CustomerState, Status> = {
  active: "ok",
  trial: "neutral",
  paused: "warning",
  ended: "offline",
  none: "offline",
};

const STATE_ORDER: Record<CustomerState, number> = {
  active: 0,
  trial: 1,
  paused: 2,
  none: 3,
  ended: 4,
};

const sv = dayLabel;

function Kpi({ label, value, note }: { label: string; value: ReactNode; note?: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 border-t border-line pt-3">
      <p className="label text-subtle">{label}</p>
      <p className="tnum text-2xl text-fg md:text-3xl">{value}</p>
      {note ? <p className="text-sm text-muted">{note}</p> : null}
    </div>
  );
}

function sortRows(rows: readonly PlatformRow[]): PlatformRow[] {
  return [...rows].sort(
    (a, b) =>
      STATE_ORDER[a.summary.state] - STATE_ORDER[b.summary.state] ||
      (b.summary.mrr?.amountOre ?? 0) - (a.summary.mrr?.amountOre ?? 0) ||
      a.customer.name.localeCompare(b.customer.name, "sv"),
  );
}

/**
 * Plattformen: alla kundorganisationer med plan, automater, MRR och ARR, totaler, churn och
 * MRR per månad. Ändra en kunds plan i raden. Bara plattformsoperatörer.
 */
export default async function PlatformPage() {
  const { user, today } = await requirePlatform();
  const data = await loadPlatformFor(user, today, 12);
  const { totals, history } = data;
  const rows = sortRows(data.rows);
  const lastFull = history.at(-2);
  const churned12 = history.reduce((n, h) => n + h.churned, 0);
  const sekHistory = history.map((h) => ({
    label: monthShort(h.month),
    value: (h.mrr.find((m) => m.currency === "SEK")?.amountOre ?? 0) / 100,
    note: h.partial ? "hittills" : undefined,
  }));
  const otherCurrencies = totals.mrr.filter((m) => m.currency !== "SEK");
  const mrrSek = totals.mrr.find((m) => m.currency === "SEK")?.amountOre ?? 0;

  return (
    <div className="flex flex-col gap-10 md:gap-12">
      <header className="flex flex-col gap-2">
        <p className="label text-subtle">Plattform · {sv(today)}</p>
        <h1 className="text-3xl text-fg md:text-4xl">
          MRR <span className="tnum">{formatMoney(mrrSek, "SEK")}</span>
          {otherCurrencies.length > 0 ? (
            <span className="text-muted"> + {formatMoneyList(otherCurrencies)}</span>
          ) : null}
        </h1>
        <p className="text-muted">
          {plural(totals.payingCustomers, "betalande kund", "betalande kunder")} ·{" "}
          {plural(totals.billableMachines, "automat", "automater")} debiteras. Inget dras
          automatiskt: fakturera från underlaget.
        </p>
      </header>

      <section aria-label="Nyckeltal" className="grid grid-cols-2 gap-x-6 gap-y-6 lg:grid-cols-4">
        <Kpi label="ARR" value={formatMoneyList(totals.arr)} note="12 × MRR i dag" />
        <Kpi
          label="Kunder"
          value={formatInt(totals.payingCustomers)}
          note={`${formatInt(totals.trialCustomers)} i provperiod · ${plural(totals.customers, "organisation", "organisationer")}`}
        />
        <Kpi
          label="Automater"
          value={formatInt(totals.billableMachines)}
          note={`debiteras · ${formatInt(totals.machines)} aktiva totalt`}
        />
        <Kpi
          label="Churn"
          value={
            lastFull?.churnBp === null || lastFull === undefined
              ? "–"
              : formatPercent(lastFull.churnBp / 10_000)
          }
          note={`${lastFull ? monthLabel(lastFull.month) : ""} · ${plural(churned12, "kund", "kunder")} på 12 mån`}
        />
      </section>

      <section aria-labelledby="historik" className="flex flex-col gap-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="historik" className="text-xl text-fg">
            MRR per månad.
          </h2>
          <p className="text-sm text-muted">
            SEK. Månadens sista dag, i dag för {monthLabel(history.at(-1)!.month)}.
          </p>
        </div>
        <MrrChart
          data={sekHistory}
          summary={`MRR i kronor de senaste ${history.length} månaderna, från ${monthLabel(history[0]!.month)} till ${monthLabel(history.at(-1)!.month)}.`}
        />
        <details className="rounded-md border border-line bg-surface p-4">
          <summary className="cursor-pointer text-sm text-muted">Visa som tabell</summary>
          <div className="-mx-4 mt-4 overflow-x-auto px-4">
            <table className="w-full border-collapse text-sm">
              <caption className="sr-only">MRR, fakturerat och churn per månad</caption>
              <thead>
                <tr className="border-b border-line-strong text-left">
                  <th scope="col" className="label py-2 pr-3 font-normal text-subtle">
                    Månad
                  </th>
                  <th scope="col" className="label px-3 py-2 text-right font-normal text-subtle">
                    MRR
                  </th>
                  <th scope="col" className="label px-3 py-2 text-right font-normal text-subtle">
                    Fakturerat
                  </th>
                  <th scope="col" className="label px-3 py-2 text-right font-normal text-subtle">
                    Betalande
                  </th>
                  <th scope="col" className="label py-2 pl-3 text-right font-normal text-subtle">
                    Churn
                  </th>
                </tr>
              </thead>
              <tbody>
                {[...history].reverse().map((h) => (
                  <tr key={h.month} className="border-b border-line">
                    <td className="py-2 pr-3 text-fg">
                      {monthLabel(h.month)}
                      {h.partial ? <span className="text-subtle"> (hittills)</span> : null}
                    </td>
                    <td className="tnum px-3 py-2 text-right">{formatMoneyList(h.mrr)}</td>
                    <td className="tnum px-3 py-2 text-right">{formatMoneyList(h.invoiced)}</td>
                    <td className="tnum px-3 py-2 text-right">{formatInt(h.payingCustomers)}</td>
                    <td className="tnum py-2 pl-3 text-right">
                      {h.churnBp === null
                        ? "–"
                        : `${formatInt(h.churned)} (${formatPercent(h.churnBp / 10_000)})`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      </section>

      <section aria-labelledby="kunder" className="flex flex-col gap-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="kunder" className="text-xl text-fg">
            Kunder.
          </h2>
          <Link href="/plattform/underlag" className="text-sm text-muted underline hover:text-fg">
            Fakturaunderlag för {monthLabel(today.slice(0, 7))} →
          </Link>
        </div>
        {rows.length === 0 ? (
          <p className="text-muted">Inga kundorganisationer ännu.</p>
        ) : (
          <ul className="flex flex-col">
            {rows.map(({ customer: c, summary: s }) => {
              const plan = s.plan;
              const currency = plan?.currency ?? "SEK";
              return (
                <li
                  key={c.id}
                  className="border-t border-line py-4 last:border-b"
                  data-kund={c.slug}
                >
                  <div className="grid grid-cols-[1fr_auto] items-start gap-x-4 gap-y-1 md:grid-cols-[minmax(0,2fr)_repeat(3,minmax(0,1fr))]">
                    <div className="flex min-w-0 flex-col gap-1">
                      <p className="flex flex-wrap items-center gap-2 text-lg text-fg">
                        <span className="min-w-0 break-words">{c.name}</span>
                        {c.operator ? <span className="label text-subtle">Plattform</span> : null}
                      </p>
                      <div>
                        <StatusTag status={STATE_STATUS[s.state]}>{STATE_LABEL[s.state]}</StatusTag>
                      </div>
                    </div>
                    <p className="tnum text-right text-lg text-fg md:order-last">
                      {s.mrr ? formatMoney(s.mrr.amountOre, s.mrr.currency) : "–"}
                      <span className="block text-sm text-subtle">MRR</span>
                    </p>
                    <p className="tnum col-span-2 text-sm text-muted md:col-span-1 md:text-base md:text-fg">
                      {plural(s.machinesNow, "automat", "automater")}
                      <span className="text-subtle md:block md:text-sm">
                        {" "}
                        · {formatInt(s.activeMachinesThisMonth)} i månaden
                      </span>
                    </p>
                    <p className="tnum col-span-2 text-sm text-muted md:col-span-1 md:text-base md:text-fg">
                      {plan
                        ? `${formatMoney(plan.pricePerMachineOre, currency)}/automat`
                        : "Ingen plan"}
                      <span className="text-subtle md:block md:text-sm">
                        {" "}
                        · ARR {s.arr ? formatMoney(s.arr.amountOre, s.arr.currency) : "–"}
                      </span>
                    </p>
                  </div>
                  <details className="mt-2">
                    <summary className="flex min-h-11 cursor-pointer items-center text-sm text-muted hover:text-fg md:min-h-0">
                      Mer och ändra plan
                    </summary>
                    <div className="mt-3 flex flex-col gap-5 rounded-md border border-line bg-surface p-4 md:p-5">
                      <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm md:grid-cols-4">
                        {[
                          ["Kund sedan", sv(s.startedOn)],
                          ["Provperiod till", sv(s.trialEndsOn)],
                          ["Senaste försäljning", sv(c.lastSaleOn)],
                          ["Användare", formatInt(c.members)],
                          ["Land", c.customer.countryCode ?? "SE"],
                          ["Momsnummer", c.customer.vatNumber ?? "–"],
                          [
                            "Denna månad",
                            formatMoneyList(
                              s.thisMonth.totals.map((t) => ({
                                currency: t.currency,
                                amountOre: t.netOre,
                              })),
                            ),
                          ],
                          ["Organisation skapad", sv(c.createdAt.slice(0, 10))],
                        ].map(([k, v]) => (
                          <div key={k} className="flex min-w-0 flex-col">
                            <dt className="label text-subtle">{k}</dt>
                            <dd className="tnum break-words text-fg">{v}</dd>
                          </div>
                        ))}
                      </dl>
                      {c.notes.length > 0 ? (
                        <p className="text-sm text-muted">Anteckning: {c.notes.at(-1)!.note}</p>
                      ) : null}
                      {c.periods.length > 0 ? (
                        <ol className="flex flex-col text-sm">
                          {[...c.periods].reverse().map((p) => (
                            <li
                              key={p.validFrom}
                              className="tnum flex flex-wrap justify-between gap-2 border-t border-line py-2"
                            >
                              <span className="text-muted">
                                {sv(p.validFrom)} – {p.validTo ? sv(p.validTo) : "tills vidare"}
                              </span>
                              <span className="text-fg">
                                {p.status === "active"
                                  ? "Aktiv"
                                  : p.status === "paused"
                                    ? "Pausad"
                                    : "Avslutad"}{" "}
                                · {formatMoney(p.pricePerMachineOre, p.currency)}/automat
                              </span>
                            </li>
                          ))}
                        </ol>
                      ) : null}
                      <PlanForm
                        organizationId={c.id}
                        customerName={c.name}
                        hasPlan={c.periods.length > 0}
                        initial={{
                          effectiveFrom: today,
                          status: plan?.status ?? "active",
                          price: plan
                            ? String(plan.pricePerMachineOre / 100).replace(".", ",")
                            : "",
                          currency,
                          trialEndsOn: c.customer.trialEndsOn ?? "",
                          countryCode: c.customer.countryCode ?? "SE",
                          vatNumber: c.customer.vatNumber ?? "",
                          note: c.notes.at(-1)?.note ?? "",
                        }}
                      />
                      <Link
                        href={`/plattform/underlag?kund=${c.id}`}
                        className="text-sm text-muted underline hover:text-fg"
                      >
                        Kundens fakturaunderlag →
                      </Link>
                    </div>
                  </details>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}

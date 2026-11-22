import type { Metadata } from "next";
import Link from "next/link";

import type { CustomerState } from "@/analytics/subscriptions/billing";
import { Badge, type BadgeTone } from "@/components/v2/badge";
import { Card } from "@/components/v2/card";
import { Empty } from "@/components/v2/empty";
import { KpiBand, KpiTile } from "@/components/v2/kpi-tile";
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

const STATE_TONE: Record<CustomerState, BadgeTone> = {
  active: "success",
  trial: "info",
  paused: "warning",
  ended: "neutral",
  none: "neutral",
};

const STATE_ORDER: Record<CustomerState, number> = {
  active: 0,
  trial: 1,
  paused: 2,
  none: 3,
  ended: 4,
};

const sv = dayLabel;

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
    <div className="flex flex-col gap-[14px] max-[900px]:gap-3">
      <header className="flex flex-col gap-1">
        <h1 className="text-v2-xl font-[650] text-v2-ink">
          MRR <span className="tnum">{formatMoney(mrrSek, "SEK")}</span>
          {otherCurrencies.length > 0 ? (
            <span className="font-normal text-v2-mute"> + {formatMoneyList(otherCurrencies)}</span>
          ) : null}
          <span className="ml-2 text-v2-md font-normal text-v2-mute">{sv(today)}</span>
        </h1>
        <p className="text-v2-md text-v2-mute">
          {plural(totals.payingCustomers, "betalande kund", "betalande kunder")} ·{" "}
          {plural(totals.billableMachines, "automat", "automater")} debiteras. Inget dras
          automatiskt: fakturera från underlaget.
        </p>
      </header>

      <KpiBand>
        <KpiTile label="ARR" value={formatMoneyList(totals.arr)} compare="12 × MRR i dag" />
        <KpiTile
          label="Kunder"
          value={formatInt(totals.payingCustomers)}
          compare={`${formatInt(totals.trialCustomers)} i provperiod · ${plural(totals.customers, "organisation", "organisationer")}`}
        />
        <KpiTile
          label="Automater"
          value={formatInt(totals.billableMachines)}
          compare={`debiteras · ${formatInt(totals.machines)} aktiva totalt`}
        />
        <KpiTile
          label="Churn"
          value={
            lastFull?.churnBp === null || lastFull === undefined
              ? "–"
              : formatPercent(lastFull.churnBp / 10_000)
          }
          compare={`${lastFull ? monthLabel(lastFull.month) : ""} · ${plural(churned12, "kund", "kunder")} på 12 mån`}
        />
      </KpiBand>

      <Card title={<span id="historik">MRR per månad</span>}>
        <div className="flex flex-col gap-4 px-[18px] pt-1 pb-4">
          <p className="text-v2-sm text-v2-mute">
            SEK. Månadens sista dag, i dag för {monthLabel(history.at(-1)!.month)}.
          </p>
          <MrrChart
            data={sekHistory}
            summary={`MRR i kronor de senaste ${history.length} månaderna, från ${monthLabel(history[0]!.month)} till ${monthLabel(history.at(-1)!.month)}.`}
          />
          <details className="group">
            <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 text-v2-md text-v2-mute hover:text-v2-ink md:min-h-9 [&::-webkit-details-marker]:hidden">
              <span
                aria-hidden
                className="transition-transform duration-150 group-open:rotate-90 motion-reduce:transition-none"
              >
                ›
              </span>
              Visa som tabell
            </summary>
            <div className="v2-table-wrap -mx-[18px] mt-2 border-t border-v2-line">
              <table className="v2-table">
                <caption className="sr-only">MRR, fakturerat och churn per månad</caption>
                <thead>
                  <tr>
                    <th scope="col">Månad</th>
                    <th scope="col" className="num">
                      MRR
                    </th>
                    <th scope="col" className="num">
                      Fakturerat
                    </th>
                    <th scope="col" className="num">
                      Betalande
                    </th>
                    <th scope="col" className="num">
                      Churn
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {[...history].reverse().map((h) => (
                    <tr key={h.month}>
                      <td>
                        {monthLabel(h.month)}
                        {h.partial ? <span className="text-v2-mute"> (hittills)</span> : null}
                      </td>
                      <td className="num">{formatMoneyList(h.mrr)}</td>
                      <td className="num">{formatMoneyList(h.invoiced)}</td>
                      <td className="num">{formatInt(h.payingCustomers)}</td>
                      <td className="num">
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
        </div>
      </Card>

      <Card
        title={<span id="kunder">Kunder</span>}
        count={rows.length}
        link={{
          href: "/plattform/underlag",
          label: `Fakturaunderlag för ${monthLabel(today.slice(0, 7))}`,
        }}
      >
        {rows.length === 0 ? (
          <Empty title="Inga kundorganisationer ännu." />
        ) : (
          <ul className="flex flex-col">
            {rows.map(({ customer: c, summary: s }) => {
              const plan = s.plan;
              const currency = plan?.currency ?? "SEK";
              return (
                <li
                  key={c.id}
                  className="border-t border-v2-line px-[18px] py-3"
                  data-kund={c.slug}
                >
                  <div className="grid grid-cols-[1fr_auto] items-start gap-x-4 gap-y-1 md:grid-cols-[minmax(0,2fr)_repeat(3,minmax(0,1fr))]">
                    <div className="flex min-w-0 flex-col gap-1">
                      <p className="flex flex-wrap items-center gap-2 text-v2-md font-[550] text-v2-ink">
                        <span className="min-w-0 break-words">{c.name}</span>
                        {c.operator ? <Badge>Plattform</Badge> : null}
                        {c.archivedAt ? <Badge>Arkiverad</Badge> : null}
                      </p>
                      <div>
                        <Badge tone={STATE_TONE[s.state]} dot>
                          {STATE_LABEL[s.state]}
                        </Badge>
                      </div>
                    </div>
                    <p className="tnum text-right text-v2-md font-[550] text-v2-ink md:order-last">
                      {s.mrr ? formatMoney(s.mrr.amountOre, s.mrr.currency) : "–"}
                      <span className="block text-v2-sm font-normal text-v2-mute">MRR</span>
                    </p>
                    <p className="tnum col-span-2 text-v2-sm text-v2-mute md:col-span-1 md:text-v2-md md:text-v2-ink">
                      {plural(s.machinesNow, "automat", "automater")}
                      <span className="text-v2-mute md:block md:text-v2-sm">
                        {" "}
                        · {formatInt(s.activeMachinesThisMonth)} i månaden
                      </span>
                    </p>
                    <p className="tnum col-span-2 text-v2-sm text-v2-mute md:col-span-1 md:text-v2-md md:text-v2-ink">
                      {plan
                        ? `${formatMoney(plan.pricePerMachineOre, currency)}/automat`
                        : "Ingen plan"}
                      <span className="text-v2-mute md:block md:text-v2-sm">
                        {" "}
                        · ARR {s.arr ? formatMoney(s.arr.amountOre, s.arr.currency) : "–"}
                      </span>
                    </p>
                  </div>
                  <details className="group mt-1">
                    <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 text-v2-sm text-v2-mute hover:text-v2-ink md:min-h-8 [&::-webkit-details-marker]:hidden">
                      <span
                        aria-hidden
                        className="transition-transform duration-150 group-open:rotate-90 motion-reduce:transition-none"
                      >
                        ›
                      </span>
                      Mer och ändra plan
                    </summary>
                    <div className="mt-2 flex flex-col gap-5 rounded-v2-lg bg-v2-hover p-4 shadow-[0_0_0_1px_var(--v2-line)] md:p-5">
                      <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-v2-sm md:grid-cols-4">
                        {[
                          ["Kund sedan", sv(s.startedOn)],
                          ["Provperiod till", sv(s.trialEndsOn)],
                          ["Senaste försäljning", sv(c.lastSaleOn)],
                          ["Användare", formatInt(c.members)],
                          ["Land", c.customer.countryCode ?? "SE"],
                          ["Momsnummer", c.customer.vatNumber ?? "–"],
                          [
                            "Denna månad, prognos",
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
                            <dt className="text-v2-mute">{k}</dt>
                            <dd className="tnum break-words text-v2-ink">{v}</dd>
                          </div>
                        ))}
                      </dl>
                      {c.notes.length > 0 ? (
                        <p className="text-v2-sm text-v2-mute">
                          Anteckning: {c.notes.at(-1)!.note}
                        </p>
                      ) : null}
                      {c.periods.length > 0 ? (
                        <ol className="flex flex-col text-v2-sm">
                          {[...c.periods].reverse().map((p) => (
                            <li
                              key={p.validFrom}
                              className="tnum flex flex-wrap justify-between gap-2 border-t border-v2-line py-2"
                            >
                              <span className="text-v2-mute">
                                {sv(p.validFrom)} – {p.validTo ? sv(p.validTo) : "tills vidare"}
                              </span>
                              <span className="text-v2-ink">
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
                        monthStart={`${today.slice(0, 7)}-01`}
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
                        className="text-v2-sm font-[550] text-v2-ink underline underline-offset-4"
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
      </Card>
    </div>
  );
}

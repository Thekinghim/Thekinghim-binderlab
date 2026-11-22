import type { Metadata } from "next";
import Link from "next/link";

import { ButtonLink } from "@/components/v2/button";
import { Card, CardBody } from "@/components/v2/card";
import { Empty } from "@/components/v2/empty";
import { addMonths } from "@/domain";
import { formatInt } from "@/lib/format";
import type { StoreReport } from "@/reports";
import { loadPortalOverview } from "@/server/portal/load";
import type { PortalTrendMonth } from "@/server/portal/model";
import { requirePortalContext } from "@/server/portal/session";

import { EvidenceDetails } from "./_components/evidence";
import { PortalKpis, RankChart, TrendChart, type PortalKpi } from "./_components/overview-charts";
import { Lead, PortalPage } from "./_components/page-head";
import { CompensationSection, TitlesHeader, WeeksBlock } from "./_components/sections";
import { deltaText, kr, monthNameText, monthShortText, monthText, pct } from "./_components/text";

export const metadata: Metadata = { title: "Översikt" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

/**
 * Butikens översikt för en månad: försäljning, utveckling, ersättning steg för steg och
 * automaterna. Mest sålda titlar och snittköp visas bara när operatören har slagit på
 * "Visa detaljer i rapporten" för butiken (samma val som månadsrapporten följer). Alla siffror kommer från
 * buildStoreReport (@/reports), samma beräkning som månadsrapporten, och varje
 * siffra har sitt underlag ("Så räknas det").
 */
export default async function PortalOverviewPage({ searchParams }: { searchParams: SearchParams }) {
  const ctx = await requirePortalContext();
  const sp = await searchParams;
  const { overview, months, machinesToday, hasAgreement, details } = await loadPortalOverview(
    ctx,
    first(sp.manad),
  );
  const { report, month, partial, trend } = overview;
  const { sales, comparison, compensation } = report;
  const prevMonth = addMonths(month, -1);
  const prevName = monthNameText(prevMonth);
  const older = months.includes(prevMonth) ? prevMonth : null;
  const newer = months.find((m) => m === addMonths(month, 1)) ?? null;
  const monthName = monthNameText(month);

  const title = partial
    ? `${kr(sales.revenueOre)} i försäljning hittills i ${monthName}.`
    : `${kr(sales.revenueOre)} i försäljning i ${monthName}.`;
  const changeClause =
    comparison.revenueChangeBp === null || partial
      ? ""
      : ` ${deltaText(comparison.revenueChangeBp)} mot ${prevName}.`;
  const aside = compensation.pending
    ? `Er andel står i månadsrapporten.${changeClause}`
    : `${kr(compensation.totalOre)} i ersättning till er.${changeClause}`;

  const trendRevenue = trend.map((t) => t.revenueOre);
  const kpis: PortalKpi[] = [
    {
      id: "revenue",
      label: "Försäljning",
      value: sales.revenueOre,
      delta:
        comparison.revenueChangeBp === null || partial ? null : comparison.revenueChangeBp / 10_000,
      trend: trendRevenue,
    },
    {
      id: "orders",
      label: "Sålda pack",
      value: sales.orders,
      delta: partial || comparison.orders === 0 ? null : comparison.ordersDiff,
      trend: trend.map((t) => t.orders),
    },
    ...(details
      ? [
          {
            id: "average" as const,
            label: "Snittköp",
            value: sales.averageOrderOre,
            delta: null,
            trend: [],
          },
        ]
      : []),
    ...(compensation.pending
      ? []
      : [
          {
            id: "compensation" as const,
            label: "Er ersättning",
            value: compensation.totalOre,
            delta: null,
            trend: trend.map((t) => t.compensationOre),
          },
        ]),
  ];

  const titlesCard = details ? (
    <Card title="Mest sålda titlar">
      <CardBody className="flex flex-col gap-4">
        <TitlesHeader report={report} />
        {report.topTitles.length === 0 ? (
          <Empty title={`Inga sålda pack i ${monthName} ännu.`} />
        ) : (
          <>
            <RankChart
              data={report.topTitles.map((t) => ({
                label: t.name,
                name: t.name,
                value: t.revenueOre / 100,
                note: `${formatInt(t.orders)} st · ${pct(t.shareBp)}`,
              }))}
              labelHeading="Titel"
              valueHeading="Försäljning"
              summary={`Mest sålda titlar i ${monthName}: ${report.topTitles
                .slice(0, 3)
                .map((t) => `${t.name} ${kr(t.revenueOre)}`)
                .join(", ")}.`}
            />
            {report.topTitles[0] ? (
              <EvidenceDetails
                evidence={report.topTitles[0].evidence}
                summary={`Så räknas andelen för ${report.topTitles[0].name}`}
              />
            ) : null}
          </>
        )}
      </CardBody>
    </Card>
  ) : null;

  return (
    <PortalPage
      id="oversikt"
      title="Översikt"
      date={`${monthText(month)}${partial ? " · pågår" : ""}`}
      sub={
        <>
          <b>{title}</b> {aside}
        </>
      }
      actions={<MonthNav month={month} older={older} newer={newer} months={months} />}
    >
      <PortalKpis
        kpis={kpis}
        comparison={
          partial
            ? "Pågående månad: ingen jämförelse förrän den är slut"
            : `Jämfört med ${monthText(prevMonth)}`
        }
      />
      <section className="v2-card" aria-label={`Försäljning · ${monthText(month)}`}>
        <CardBody>
          <p className="pt-note">
            {partial
              ? `Period 1–${Number(overview.today.slice(8))} ${monthShortText(month)}. Pågående månad: ingen jämförelse förrän den är slut.`
              : `Period ${monthText(month)}. Jämfört med ${monthText(prevMonth)}.`}{" "}
            {formatInt(sales.orders)} sålda pack, {formatInt(report.machines.length)}{" "}
            {report.machines.length === 1 ? "automat" : "automater"}.
            {partial ? null : <> {report.conclusion.text}</>}
          </p>
        </CardBody>
        <div className="pt-evrow">
          <EvidenceDetails evidence={sales.evidence} summary="Så räknas försäljningen" />
          <EvidenceDetails evidence={comparison.evidence} summary="Så räknas jämförelsen" />
          <EvidenceDetails evidence={compensation.evidence} summary="Så räknas ersättningen" />
        </div>
      </section>

      <div className="v2-cols">
        <div className="v2-stack">
          <TrendSection trend={trend} month={month} />
          {titlesCard}
          <WeeksBlock report={report} today={partial ? overview.today : undefined} />
        </div>
        <div className="v2-stack">
          <CompensationSection report={report} hasAgreement={hasAgreement} />
          <MachinesSection
            report={report}
            machinesToday={machinesToday}
            placedDays={overview.placedDaysSoFar}
            partial={partial}
          />
        </div>
      </div>
    </PortalPage>
  );
}

// ---------------------------------------------------------------------------

function MonthNav({
  month,
  older,
  newer,
  months,
}: {
  month: string;
  older: string | null;
  newer: string | null;
  months: string[];
}) {
  return (
    <nav aria-label="Välj månad" className="flex flex-wrap items-center gap-2">
      {older ? (
        <ButtonLink href={`/portal?manad=${older}`} rel="prev" touch>
          <span aria-hidden>←</span> {monthShortText(older)}
        </ButtonLink>
      ) : (
        <span className="v2-btn touch" aria-disabled>
          <span aria-hidden>←</span> Tidigare
        </span>
      )}
      {newer ? (
        <ButtonLink href={`/portal?manad=${newer}`} rel="next" touch>
          {monthShortText(newer)} <span aria-hidden>→</span>
        </ButtonLink>
      ) : (
        <span className="v2-btn touch" aria-disabled>
          Senare <span aria-hidden>→</span>
        </span>
      )}
      {months.length > 2 ? (
        <form action="/portal" className="flex items-center gap-2">
          <label htmlFor="manad" className="sr-only">
            Månad
          </label>
          <select id="manad" name="manad" defaultValue={month} className="v2-select h-8 w-auto">
            {months.map((m) => (
              <option key={m} value={m}>
                {monthText(m)}
              </option>
            ))}
          </select>
          <button type="submit" className="v2-btn touch">
            Visa
          </button>
        </form>
      ) : null}
    </nav>
  );
}

function TrendSection({ trend, month }: { trend: readonly PortalTrendMonth[]; month: string }) {
  const complete = trend.filter((t) => !t.partial);
  const best = complete.reduce<PortalTrendMonth | null>(
    (b, t) => (b === null || t.revenueOre > b.revenueOre ? t : b),
    null,
  );
  const total = complete.reduce((s, t) => s + t.revenueOre, 0);
  const totalComp = complete.reduce((s, t) => s + t.compensationOre, 0);
  const compKnown = complete.every((t) => !t.compensationPending);
  // Snittet räknas bara på hela månader: en pågående månad drar ned det. Med
  // färre än två hela månader finns inget snitt att jämföra med.
  const meanOfComplete = complete.length >= 2 ? total / complete.length / 100 : undefined;
  const selectedIndex = Math.max(
    0,
    trend.findIndex((t) => t.month === month),
  );
  return (
    <Card title={`Utveckling · ${formatInt(trend.length)} mån`} id="utveckling">
      <CardBody className="flex flex-col gap-4">
        <Lead
          strong={
            complete.length > 0
              ? `${kr(total)} på ${formatInt(complete.length)} hela ${complete.length === 1 ? "månad" : "månader"}.`
              : "Första månaden pågår."
          }
          rest={
            best && complete.length > 1
              ? `Bästa månaden var ${monthText(best.month)} med ${kr(best.revenueOre)}.${compKnown ? ` Ersättning till er: ${kr(totalComp)}.` : ""}`
              : complete.length === 1
                ? compKnown
                  ? `Ersättning till er: ${kr(totalComp)}.`
                  : "Er andel står i månadsrapporten."
                : "Staplarna fylls på månad för månad."
          }
        />
        {trend.length > 1 ? (
          <TrendChart
            data={trend.map((t) => ({
              label: monthShortText(t.month),
              name: `${monthText(t.month)}${t.partial ? " (pågår)" : ""}`,
              value: t.revenueOre / 100,
            }))}
            selectedIndex={selectedIndex}
            mean={meanOfComplete}
            summary={`Försäljning per månad, ${monthText(trend[0]!.month)} till ${monthText(
              trend[trend.length - 1]!.month,
            )}.`}
          />
        ) : (
          <p className="pt-note">Utvecklingen visas när det finns mer än en månad att jämföra.</p>
        )}
      </CardBody>
      <TrendTable trend={trend} />
    </Card>
  );
}

function TrendTable({ trend }: { trend: readonly PortalTrendMonth[] }) {
  return (
    <div className="v2-table-wrap border-t border-v2-line">
      <table className="v2-table">
        <caption className="sr-only">Försäljning och ersättning per månad</caption>
        <thead>
          <tr>
            <th scope="col">Månad</th>
            <th scope="col" className="num">
              Pack
            </th>
            <th scope="col" className="num">
              Försäljning
            </th>
            <th scope="col" className="num">
              Ersättning
            </th>
          </tr>
        </thead>
        <tbody>
          {[...trend].reverse().map((t) => (
            <tr key={t.month}>
              <th scope="row" className="text-left font-[450]">
                <Link
                  href={`/portal?manad=${t.month}`}
                  className="rounded-v2-sm font-[550] underline-offset-4 hover:underline"
                >
                  {monthText(t.month)}
                </Link>
                {t.partial ? <span className="text-v2-faint"> · pågår</span> : null}
              </th>
              <td className="num text-v2-mute">{formatInt(t.orders)}</td>
              <td className="num">{kr(t.revenueOre)}</td>
              <td className="num">
                {t.compensationPending ? (
                  <span className="text-v2-mute" title="Står i månadsrapporten">
                    –
                  </span>
                ) : (
                  kr(t.compensationOre)
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function MachinesSection({
  report,
  machinesToday,
  placedDays,
  partial,
}: {
  report: StoreReport;
  machinesToday: { machineId: string; code: string; name: string }[];
  placedDays: Readonly<Record<string, number>>;
  partial: boolean;
}) {
  const todayIds = new Set(machinesToday.map((m) => m.machineId));
  const best = report.machines[0];
  return (
    <Card
      title="Automaterna"
      id="automater"
      actions={
        <ButtonLink href="/portal/felanmalan" size="sm" variant="act" touch>
          Felanmäl en automat
        </ButtonLink>
      }
    >
      <CardBody>
        <Lead
          strong={`${formatInt(machinesToday.length)} ${machinesToday.length === 1 ? "automat står" : "automater står"} i butiken i dag.`}
          rest={
            best && report.machines.length > 1
              ? `${best.name} sålde mest i ${monthNameText(report.month)}: ${kr(best.revenueOre)}.`
              : "Något som inte fungerar? Felanmäl automaten direkt här."
          }
        />
      </CardBody>
      {report.machines.length === 0 ? (
        <Empty
          className="border-t border-v2-line"
          title="Inga automater stod i butiken under månaden."
        />
      ) : (
        <ul className="pt-list border-t border-v2-line">
          {report.machines.map((m) => {
            const days = placedDays[m.machineId] ?? m.placedDays;
            return (
              <li key={m.machineId} className="pt-item">
                <div className="t">
                  <b>{m.name}</b>
                  <small>
                    {formatInt(days)} {days === 1 ? "dag" : "dagar"} i butiken
                    {partial ? " hittills" : ""} · {formatInt(m.orders)} pack
                  </small>
                </div>
                <div className="a">
                  <span className="pt-amount">{kr(m.revenueOre)}</span>
                  {todayIds.has(m.machineId) ? (
                    <Link href={`/portal/felanmalan?automat=${m.machineId}`} className="pt-link">
                      Felanmäl
                    </Link>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

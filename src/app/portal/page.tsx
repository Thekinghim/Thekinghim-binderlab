import type { Metadata } from "next";
import Link from "next/link";

import { SectionHeader } from "@/components/ui/section-header";
import { StateMessage } from "@/components/ui/state-message";
import { addMonths } from "@/domain";
import { formatInt } from "@/lib/format";
import type { StoreReport } from "@/reports";
import { loadPortalOverview } from "@/server/portal/load";
import type { PortalTrendMonth } from "@/server/portal/model";
import { requirePortalContext } from "@/server/portal/session";

import { EvidenceDetails } from "./_components/evidence";
import { PortalKpis, RankChart, TrendChart, type PortalKpi } from "./_components/overview-charts";
import { CompensationSection, TitlesHeader, WeeksBlock } from "./_components/sections";
import { deltaText, kr, monthNameText, monthShortText, monthText, pct } from "./_components/text";

export const metadata: Metadata = { title: "Översikt" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

/**
 * Butikens översikt för en månad: försäljning, utveckling, mest sålda titlar,
 * ersättning steg för steg och automaterna. Alla siffror kommer från
 * buildStoreReport (@/reports), samma beräkning som månadsrapporten, och varje
 * siffra har sitt underlag ("Så räknas det").
 */
export default async function PortalOverviewPage({ searchParams }: { searchParams: SearchParams }) {
  const ctx = await requirePortalContext();
  const sp = await searchParams;
  const { overview, months, machinesToday, hasAgreement } = await loadPortalOverview(
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
  const aside = `${kr(compensation.totalOre)} i ersättning till er.${changeClause}`;

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
    {
      id: "average",
      label: "Snittköp",
      value: sales.averageOrderOre,
      delta: null,
      trend: [],
    },
    {
      id: "compensation",
      label: "Er ersättning",
      value: compensation.totalOre,
      delta: null,
      trend: trend.map((t) => t.compensationOre),
    },
  ];

  return (
    <div className="flex flex-col">
      <MonthBar month={month} older={older} newer={newer} months={months} partial={partial} />

      <section className="flex flex-col gap-10 pt-10 pb-16 md:pt-12" aria-labelledby="oversikt">
        <SectionHeader
          as="h1"
          id="oversikt"
          index={1}
          eyebrow={`Försäljning · ${monthText(month)}`}
          title={title}
          aside={aside}
          size="xl"
          meta={[
            {
              label: "Period",
              value: partial
                ? `1–${Number(overview.today.slice(8))} ${monthShortText(month)}`
                : monthText(month),
            },
            { label: "Sålda pack", value: formatInt(sales.orders) },
            { label: "Automater", value: formatInt(report.machines.length) },
          ]}
        />
        <div className="flex flex-col gap-4">
          <PortalKpis
            kpis={kpis}
            comparison={
              partial
                ? "Pågående månad: ingen jämförelse förrän den är slut"
                : `Jämfört med ${monthText(prevMonth)}`
            }
          />
          <div className="grid gap-x-8 gap-y-4 md:grid-cols-3">
            <EvidenceDetails evidence={sales.evidence} summary="Så räknas försäljningen" />
            <EvidenceDetails evidence={comparison.evidence} summary="Så räknas jämförelsen" />
            <EvidenceDetails evidence={compensation.evidence} summary="Så räknas ersättningen" />
          </div>
        </div>
        {partial ? null : <p className="max-w-3xl text-md text-muted">{report.conclusion.text}</p>}
      </section>

      <TrendSection trend={trend} month={month} />

      <section
        className="grid gap-x-8 gap-y-12 border-t border-line py-16 lg:grid-cols-12"
        aria-label="Mest sålda och veckor"
      >
        <div className="flex min-w-0 flex-col gap-8 lg:col-span-7">
          <TitlesHeader report={report} />
          {report.topTitles.length === 0 ? (
            <StateMessage kind="empty" message={`Inga sålda pack i ${monthName} ännu.`} />
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
        </div>
        <div className="flex min-w-0 flex-col gap-8 lg:col-span-5">
          <WeeksBlock report={report} />
        </div>
      </section>

      <CompensationSection report={report} hasAgreement={hasAgreement} />

      <MachinesSection report={report} machinesToday={machinesToday} />
    </div>
  );
}

// ---------------------------------------------------------------------------

function MonthBar({
  month,
  older,
  newer,
  months,
  partial,
}: {
  month: string;
  older: string | null;
  newer: string | null;
  months: string[];
  partial: boolean;
}) {
  const link =
    "inline-flex h-8 items-center gap-1 rounded-sm border border-line-strong bg-surface px-2.5 text-sm text-fg transition-colors duration-fast ease-instrument hover:border-line-control hover:bg-hover";
  const off =
    "inline-flex h-8 items-center gap-1 rounded-sm border border-dashed border-line-strong px-2.5 text-sm text-disabled";
  return (
    <nav
      aria-label="Välj månad"
      className="flex flex-wrap items-center justify-between gap-3 border-b border-line py-3"
    >
      <p className="label text-subtle">
        <span className="text-fg">{monthText(month)}</span>
        {partial ? " · pågår" : " · hel månad"}
      </p>
      <div className="flex items-center gap-2">
        {older ? (
          <Link href={`/portal?manad=${older}`} className={link} rel="prev">
            <span aria-hidden>←</span> {monthShortText(older)}
          </Link>
        ) : (
          <span className={off} aria-disabled>
            <span aria-hidden>←</span> Tidigare
          </span>
        )}
        {newer ? (
          <Link href={`/portal?manad=${newer}`} className={link} rel="next">
            {monthShortText(newer)} <span aria-hidden>→</span>
          </Link>
        ) : (
          <span className={off} aria-disabled>
            Senare <span aria-hidden>→</span>
          </span>
        )}
        {months.length > 2 ? (
          <form action="/portal" className="flex items-center">
            <label htmlFor="manad" className="sr-only">
              Månad
            </label>
            <select
              id="manad"
              name="manad"
              defaultValue={month}
              className="h-8 rounded-sm border border-line-control bg-bg px-2 text-sm text-fg"
            >
              {months.map((m) => (
                <option key={m} value={m}>
                  {monthText(m)}
                </option>
              ))}
            </select>
            <button
              type="submit"
              className="ml-2 inline-flex h-8 items-center rounded-sm border border-line-strong bg-surface px-2.5 text-sm text-fg hover:bg-hover"
            >
              Visa
            </button>
          </form>
        ) : null}
      </div>
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
  const selectedIndex = Math.max(
    0,
    trend.findIndex((t) => t.month === month),
  );
  return (
    <section
      className="flex flex-col gap-10 border-t border-line py-16"
      aria-labelledby="utveckling"
    >
      <SectionHeader
        id="utveckling"
        index={2}
        eyebrow={`Utveckling · ${formatInt(trend.length)} mån`}
        title={
          complete.length > 0
            ? `${kr(total)} på ${formatInt(complete.length)} hela ${complete.length === 1 ? "månad" : "månader"}.`
            : "Första månaden pågår."
        }
        aside={
          best && complete.length > 1
            ? `Bästa månaden var ${monthText(best.month)} med ${kr(best.revenueOre)}. Ersättning till er: ${kr(totalComp)}.`
            : complete.length === 1
              ? `Ersättning till er: ${kr(totalComp)}.`
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
          summary={`Försäljning per månad, ${monthText(trend[0]!.month)} till ${monthText(
            trend[trend.length - 1]!.month,
          )}.`}
        />
      ) : (
        <StateMessage
          kind="empty"
          code="1 månad"
          message="Utvecklingen visas när det finns mer än en månad att jämföra."
        />
      )}
      <TrendTable trend={trend} />
    </section>
  );
}

function TrendTable({ trend }: { trend: readonly PortalTrendMonth[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-base">
        <caption className="sr-only">Försäljning och ersättning per månad</caption>
        <thead>
          <tr className="border-b border-line-strong">
            <th scope="col" className="label h-9 text-left font-normal text-subtle">
              Månad
            </th>
            <th scope="col" className="label h-9 text-right font-normal text-subtle">
              Sålda pack
            </th>
            <th scope="col" className="label h-9 text-right font-normal text-subtle">
              Försäljning
            </th>
            <th scope="col" className="label h-9 text-right font-normal text-subtle">
              Ersättning
            </th>
          </tr>
        </thead>
        <tbody>
          {[...trend].reverse().map((t) => (
            <tr key={t.month} className="h-11 border-b border-line">
              <th scope="row" className="text-left font-normal text-fg">
                <Link
                  href={`/portal?manad=${t.month}`}
                  className="rounded-xs underline-offset-4 hover:underline"
                >
                  {monthText(t.month)}
                </Link>
                {t.partial ? <span className="meta text-subtle"> · pågår</span> : null}
              </th>
              <td className="tnum text-right text-muted">{formatInt(t.orders)}</td>
              <td className="tnum text-right text-fg">{kr(t.revenueOre)}</td>
              <td className="tnum text-right text-fg">{kr(t.compensationOre)}</td>
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
}: {
  report: StoreReport;
  machinesToday: { machineId: string; code: string; name: string }[];
}) {
  const todayIds = new Set(machinesToday.map((m) => m.machineId));
  const best = report.machines[0];
  return (
    <section
      className="flex flex-col gap-10 border-t border-line py-16"
      aria-labelledby="automater"
    >
      <SectionHeader
        id="automater"
        index={5}
        eyebrow="Automaterna"
        title={`${formatInt(machinesToday.length)} ${machinesToday.length === 1 ? "automat står" : "automater står"} i butiken i dag.`}
        aside={
          best && report.machines.length > 1
            ? `${best.name} sålde mest i ${monthNameText(report.month)}: ${kr(best.revenueOre)}.`
            : "Något som inte fungerar? Felanmäl automaten direkt här."
        }
        actions={
          <Link
            href="/portal/felanmalan"
            className="inline-flex h-9 items-center rounded-sm border border-inverse bg-inverse px-3.5 text-base font-medium text-on-inverse transition-colors duration-fast ease-instrument hover:border-inverse-hover hover:bg-inverse-hover"
          >
            Felanmäl en automat
          </Link>
        }
      />
      {report.machines.length === 0 ? (
        <StateMessage kind="empty" message="Inga automater stod i butiken under månaden." />
      ) : (
        <ul className="flex flex-col border-t border-line-strong">
          {report.machines.map((m) => (
            <li
              key={m.machineId}
              className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2 border-b border-line py-4"
            >
              <div className="flex min-w-0 flex-col gap-1">
                <span className="text-base text-fg">{m.name}</span>
                <span className="meta text-subtle">
                  {formatInt(m.placedDays)} {m.placedDays === 1 ? "dag" : "dagar"} i butiken ·{" "}
                  {formatInt(m.orders)} pack
                </span>
              </div>
              <div className="flex items-baseline gap-4">
                <span className="tnum text-md text-fg">{kr(m.revenueOre)}</span>
                {todayIds.has(m.machineId) ? (
                  <Link
                    href={`/portal/felanmalan?automat=${m.machineId}`}
                    className="text-sm text-muted underline-offset-4 hover:text-fg hover:underline"
                  >
                    Felanmäl
                  </Link>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

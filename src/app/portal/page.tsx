import type { Metadata } from "next";
import Link from "next/link";

import { OpenOnHash } from "@/components/ui/open-on-hash";
import { ButtonLink } from "@/components/v2/button";
import { Card, CardBody } from "@/components/v2/card";
import { Empty } from "@/components/v2/empty";
import { addMonths, periodDays } from "@/domain";
import { formatInt } from "@/lib/format";
import type { StoreReport } from "@/reports";
import { loadPortalOverview } from "@/server/portal/load";
import type { PortalTrendMonth } from "@/server/portal/model";
import { requirePortalContext } from "@/server/portal/session";

import { EvidenceDetails } from "./_components/evidence";
import {
  CompensationHero,
  PodiumCard,
  TrendBars,
  type MachineOnStage,
} from "./_components/overview-hero";
import { Lead, PortalPage } from "./_components/page-head";
import { CompensationSection, WeeksBlock } from "./_components/sections";
import { TableToggles } from "./_components/table-toggles";
import { kr, monthNameText, monthShortText, monthText, pct } from "./_components/text";

export const metadata: Metadata = { title: "Översikt" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

/**
 * Butikens översikt för en månad (uppgradering 7): överst er ersättning som ett stort tal med
 * förändringen mot månaden före och en stapel (provision + hyra), bredvid butikens automat
 * som den ser ut i butiken med packen på skärmen. Under: pallen med de fem mest köpta packen
 * (bara när operatören har slagit på "Visa detaljer i rapporten") och försäljningen per månad
 * med "Bästa månaden hittills". Tabellerna ligger bakom "Visa tabell" och "Per vecka", och
 * hela uträkningen med underlag under "Så räknas det".
 *
 * Alla siffror kommer från buildStoreReport (@/reports), samma beräkning som
 * månadsrapporten. Butiken ser aldrig vårt inköpspris eller vår vinst.
 */
export default async function PortalOverviewPage({ searchParams }: { searchParams: SearchParams }) {
  const ctx = await requirePortalContext();
  const sp = await searchParams;
  const { overview, months, machinesToday, hasAgreement, details, screens } =
    await loadPortalOverview(ctx, first(sp.manad));
  const { report, month, partial, trend } = overview;
  const { sales, comparison, compensation } = report;
  const prevMonth = addMonths(month, -1);
  const older = months.includes(prevMonth) ? prevMonth : null;
  const newer = months.find((m) => m === addMonths(month, 1)) ?? null;
  const monthName = monthNameText(month);
  const days = partial ? Number(overview.today.slice(8)) : periodDays(overview.period);

  const screenOf = new Map(screens.map((s) => [s.machineId, s]));
  const stage: MachineOnStage[] = machinesToday.map((m) => ({
    ...m,
    screen: screenOf.get(m.machineId) ?? null,
  }));

  const complete = trend.filter((t) => !t.partial);
  const total = complete.reduce((s, t) => s + t.revenueOre, 0);

  const trendCard = (
    <section className="v2-card pt-trend" aria-labelledby="utveckling-rubrik" id="utveckling">
      <div className="v2-card-hd">
        <h2 id="utveckling-rubrik">Utveckling · {formatInt(trend.length)} mån</h2>
        <span className="lk">försäljning</span>
      </div>
      {trend.length > 1 ? (
        <TrendBars trend={trend} month={month} />
      ) : (
        <p className="pt-note px-[18px] py-6">
          Utvecklingen visas när det finns mer än en månad att jämföra.
        </p>
      )}
      <TableToggles
        panels={[
          { id: "tabell", label: "Visa tabell", content: <TrendTable trend={trend} /> },
          {
            id: "vecka",
            label: "Per vecka",
            content: <WeeksBlock report={report} today={partial ? overview.today : undefined} />,
          },
        ]}
        summary={
          complete.length > 0
            ? `${kr(total)} på ${formatInt(complete.length)} ${complete.length === 1 ? "hel månad" : "hela mån"}`
            : undefined
        }
      />
    </section>
  );

  return (
    <PortalPage
      id="oversikt"
      title="Översikt"
      date={`${monthText(month)}${partial ? " · pågår" : ""}`}
      actions={<MonthNav month={month} older={older} newer={newer} />}
    >
      <CompensationHero
        report={report}
        trend={trend}
        partial={partial}
        days={days}
        hasAgreement={hasAgreement}
        machines={stage}
        timeZone={ctx.store.timezone}
      />

      <div className="pt-grid2" data-single={details ? undefined : true}>
        {details ? <PodiumCard report={report} /> : null}
        {trendCard}
      </div>

      <details id="utrakning" className="v2-card pt-calc scroll-mt-28">
        <summary>
          <span aria-hidden className="chev">
            ›
          </span>
          <span className="t">
            <b>Så räknas det</b>
            <span>Ersättningen steg för steg, försäljningen och automaterna, med underlag.</span>
          </span>
        </summary>
        <div className="pt-calc-in">
          <p className="pt-note">
            {partial
              ? `Period 1–${Number(overview.today.slice(8))} ${monthShortText(month)}. Pågående månad: ingen jämförelse förrän den är slut.`
              : `Period ${monthText(month)}. Jämfört med ${monthText(prevMonth)}.`}{" "}
            {formatInt(sales.orders)} sålda pack, {formatInt(report.machines.length)}{" "}
            {report.machines.length === 1 ? "automat" : "automater"}.
            {partial ? null : <> {report.conclusion.text}</>}
          </p>
          <div className="pt-evrow">
            <EvidenceDetails evidence={sales.evidence} summary="Så räknas försäljningen" />
            <EvidenceDetails evidence={comparison.evidence} summary="Så räknas jämförelsen" />
            <EvidenceDetails evidence={compensation.evidence} summary="Så räknas ersättningen" />
            {details && report.topTitles[0] ? (
              <EvidenceDetails
                evidence={report.topTitles[0].evidence}
                summary={`Så räknas andelen för ${report.topTitles[0].name}`}
              />
            ) : null}
          </div>
          <div className="v2-cols">
            <CompensationSection report={report} hasAgreement={hasAgreement} />
            <MachinesSection
              report={report}
              machinesToday={machinesToday}
              placedDays={overview.placedDaysSoFar}
              partial={partial}
            />
          </div>
          {details && report.topTitles.length > 0 ? (
            <Card title={`Alla titlar · ${monthName}`}>
              <TitlesTable report={report} />
            </Card>
          ) : null}
        </div>
      </details>
      <OpenOnHash id="utrakning" />
    </PortalPage>
  );
}

// ---------------------------------------------------------------------------

function MonthNav({
  month,
  older,
  newer,
}: {
  month: string;
  older: string | null;
  newer: string | null;
}) {
  const chev = (d: string) => (
    <svg aria-hidden viewBox="0 0 16 16" width="16" height="16">
      <path
        d={d}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
  return (
    <nav aria-label="Välj månad" className="pt-mstep">
      {older ? (
        <Link
          href={`/portal?manad=${older}`}
          rel="prev"
          className="v2-btn touch ico"
          aria-label={`Föregående månad, ${monthText(older)}`}
        >
          {chev("M10 3.5L5.5 8l4.5 4.5")}
        </Link>
      ) : (
        <span className="v2-btn touch ico" aria-disabled>
          {chev("M10 3.5L5.5 8l4.5 4.5")}
        </span>
      )}
      <span className="cur" aria-current="date">
        {monthText(month)}
      </span>
      {newer ? (
        <Link
          href={`/portal?manad=${newer}`}
          rel="next"
          className="v2-btn touch ico"
          aria-label={`Nästa månad, ${monthText(newer)}`}
        >
          {chev("M6 3.5L10.5 8 6 12.5")}
        </Link>
      ) : (
        <span className="v2-btn touch ico" aria-disabled>
          {chev("M6 3.5L10.5 8 6 12.5")}
        </span>
      )}
    </nav>
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

/** Alla titlar i månaden (de åtta största), bakom "Så räknas det". */
function TitlesTable({ report }: { report: StoreReport }) {
  return (
    <div className="v2-table-wrap">
      <table className="v2-table">
        <caption className="sr-only">Mest sålda titlar</caption>
        <thead>
          <tr>
            <th scope="col">Titel</th>
            <th scope="col" className="num">
              Pack
            </th>
            <th scope="col" className="num">
              Försäljning
            </th>
            <th scope="col" className="num">
              Andel
            </th>
          </tr>
        </thead>
        <tbody>
          {report.topTitles.map((t) => (
            <tr key={t.titleId}>
              <th scope="row" className="text-left font-[450]">
                {t.name}
              </th>
              <td className="num text-v2-mute">{formatInt(t.orders)}</td>
              <td className="num">{kr(t.revenueOre)}</td>
              <td className="num text-v2-mute">{pct(t.shareBp)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

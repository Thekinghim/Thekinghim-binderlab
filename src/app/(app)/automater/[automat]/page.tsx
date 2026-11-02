import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { carriedQuery, parseIsoDate, wallClockIn } from "@/components/shell/period-state";
import { Panel } from "@/components/ui/frame";
import { SectionHeader } from "@/components/ui/section-header";
import { StateMessage } from "@/components/ui/state-message";
import { StatusTag } from "@/components/ui/status-tag";
import {
  formatDate,
  formatDateTime,
  formatDecimal,
  formatInt,
  formatPercent,
  formatSek,
  MISSING,
  NBSP,
} from "@/lib/format";

import { RevenueChart, SalesHeatmap, TitleBars } from "../_components/charts";
import { PlacementsTable, RecentOrdersTable, StockTable } from "../_components/detail-tables";
import { MachineKpis } from "../_components/kpis";
import { MachineActions } from "../_components/machine-dialogs";
import { Sub } from "../_components/sub";
import {
  isMachineId,
  loadMachineDetail,
  resolveMachineCode,
  type MachineDetailData,
} from "../_lib/data";
import { dayText, hourRange, sentence, unitEconomicsKpis } from "../_lib/model";

type Params = Promise<{ automat: string }>;
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const WEEKDAYS_LONG = [
  "måndagar",
  "tisdagar",
  "onsdagar",
  "torsdagar",
  "fredagar",
  "lördagar",
  "söndagar",
];
const TOP_TITLES = 8;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const slug = decodeURIComponent((await params).automat);
  return { title: isMachineId(slug) ? "Automat" : slug.toUpperCase() };
}

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

/**
 * En automat: intäkt och vinst för perioden, försäljning per dag, bästa titlar, köp per
 * veckodag och timme, lager, senaste order, placeringar och enhetsekonomi. Ägare och
 * admin redigerar, flyttar och avvecklar. Länkar från Att göra använder automatens id
 * och ?fran=&till=; de skickas vidare till kanonisk adress (koden) och skalets period.
 */
export default async function MachinePage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: SearchParams;
}) {
  const { automat } = await params;
  const sp = await searchParams;
  // Länkar från Att göra m.fl.: /automater/<id>?fran=&till=. En enda omdirigering till
  // kanonisk adress (koden) med skalets period.
  const slug = decodeURIComponent(automat);
  const fran = first(sp.fran);
  const legacyPeriod = Boolean(fran && !first(sp.from) && parseIsoDate(fran));
  if (isMachineId(slug) || legacyPeriod) {
    const code = await resolveMachineCode(slug);
    if (!code) notFound();
    const q = new URLSearchParams(carriedQuery(sp).replace(/^\?/, ""));
    if (legacyPeriod && fran) {
      q.set("period", "eget");
      q.set("from", fran);
      const till = first(sp.till);
      if (till && parseIsoDate(till)) q.set("to", till);
    }
    const query = q.toString();
    redirect(`/automater/${encodeURIComponent(code.toLowerCase())}${query ? `?${query}` : ""}`);
  }

  const data = await loadMachineDetail(automat, sp);
  if (!data) notFound();

  const { ctx, machine, period, headline, status, store } = data;
  const days = `${formatInt(period.days)}${NBSP}d`;
  const comparison = period.comparisonLabel ? `Jämfört med ${period.comparisonLabel}` : undefined;
  const today = parseIsoDate(ctx.today) ?? new Date();
  const listHref = `/automater${data.query}`;

  return (
    <div className="mx-auto flex w-full max-w-[1280px] flex-col gap-12 px-4 pt-6 pb-16 md:gap-16 md:px-8 md:pt-10">
      <div className="flex flex-col gap-6">
        <nav aria-label="Brödsmulor">
          <Link
            href={listHref}
            className="meta inline-flex items-center gap-1.5 rounded-xs text-subtle hover:text-fg"
          >
            <span aria-hidden className="text-faint">
              ←
            </span>
            Alla automater
          </Link>
        </nav>
        <SectionHeader
          as="h1"
          size="xl"
          eyebrow={`Automat / ${machine.code} · ${machine.name}`}
          title={headline.title}
          aside={headline.aside}
          description={status.reason && status.status !== "ok" ? status.reason : undefined}
          meta={[
            {
              label: "Status",
              value: <StatusTag status={status.status}>{status.label}</StatusTag>,
            },
            { label: "Butik", value: store?.name ?? MISSING },
            {
              label: "Driftstart",
              value: machine.activeFrom ? dayText(machine.activeFrom, ctx.today) : MISSING,
            },
            ...(machine.activeTo
              ? [{ label: "Sista dag", value: dayText(machine.activeTo, ctx.today) }]
              : []),
            { label: "Serienummer", value: machine.serial ?? MISSING },
          ]}
          actions={
            ctx.canEdit ? (
              <MachineActions
                machine={data.editable}
                stores={data.stores}
                today={ctx.today}
                storeName={store?.name ?? null}
              />
            ) : undefined
          }
        />
      </div>

      <MachineKpis items={data.kpis} label={`Nyckeltal · ${days}`} comparison={comparison} />

      <SalesSection data={data} days={days} today={today} />
      <TitlesAndHours data={data} days={days} />
      <StockSection data={data} />
      <OrdersSection data={data} />
      <PlacementSection data={data} />
      <UnitEconomicsSection data={data} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sektioner
// ---------------------------------------------------------------------------

function SalesSection({
  data,
  days,
  today,
}: {
  data: MachineDetailData;
  days: string;
  today: Date;
}) {
  const daily = data.daily;
  const total = daily.reduce((s, d) => s + d.value, 0);
  const mean = daily.length > 0 ? total / daily.length : 0;
  const peak = daily.reduce<(typeof daily)[number] | null>(
    (b, d) => (b === null || d.value > b.value ? d : b),
    null,
  );
  const peakDate = peak ? parseIsoDate(peak.date) : null;
  return (
    <section
      aria-labelledby="forsaljning"
      className="flex flex-col gap-8 border-t border-line pt-8"
    >
      <SectionHeader
        id="forsaljning"
        index={1}
        eyebrow={`Intäkt per dag · ${days}`}
        title="Försäljning per dag."
        aside={
          total > 0 && peak && peakDate
            ? sentence(
                `Snitt ${formatSek(mean)}, topp ${formatDate(peakDate, { year: "auto", now: today })} med ${formatSek(peak.value)}`,
              )
            : "Ingen försäljning i perioden."
        }
      />
      {total > 0 ? (
        <Panel grid marks>
          <RevenueChart
            code={data.machine.code}
            daily={daily}
            compare={data.dailyCompare}
            compareName={data.period.comparisonLabel ? `Föreg. ${days}` : undefined}
          />
        </Panel>
      ) : (
        <StateMessage
          kind="empty"
          message={`Inga order i ${data.machine.code} ${data.period.rangeLabel}.`}
          detail="Välj en längre period i periodraden."
        />
      )}
    </section>
  );
}

function TitlesAndHours({ data, days }: { data: MachineDetailData; days: string }) {
  const titles = data.titles;
  const top = titles[0];
  const heat = data.heatmap;
  const peak = heat.peak;
  return (
    <section
      aria-labelledby="vad-som-saljer"
      className="flex flex-col gap-8 border-t border-line pt-8"
    >
      <SectionHeader
        id="vad-som-saljer"
        index={2}
        eyebrow={`Titlar och tider · ${days}`}
        title={top ? sentence(`${top.name} säljer mest`) : "Inga titlar sålda i perioden."}
        aside={
          top
            ? sentence(
                `${formatPercent(top.share, 0)} av intäkten, ${formatInt(top.orders)}${NBSP}pack${
                  titles.length > 1
                    ? ` av ${formatInt(titles.reduce((n, t) => n + t.orders, 0))}`
                    : ""
                }`,
              )
            : undefined
        }
      />
      {top ? (
        <div className="grid grid-cols-1 gap-x-8 gap-y-12 lg:grid-cols-12">
          <Sub
            index="02.1"
            label={`Bästa titlar · ${days}`}
            meta={`${formatInt(titles.length)} titlar`}
            title={
              titles.length > TOP_TITLES
                ? `De ${TOP_TITLES} största av ${formatInt(titles.length)} titlar.`
                : `${formatInt(titles.length)} ${titles.length === 1 ? "titel" : "titlar"} såldes.`
            }
            className="lg:col-span-5"
          >
            <TitleBars titles={titles.slice(0, TOP_TITLES)} />
          </Sub>
          <Sub
            index="02.2"
            label={`Köp per veckodag och timme · ${days}`}
            meta={`${formatInt(heat.total)}${NBSP}köp`}
            title={
              peak
                ? `${capitalize(WEEKDAYS_LONG[peak.weekday] ?? "")} ${hourRange(peak.hour)} toppar med ${formatInt(peak.count)}${NBSP}köp.`
                : "Inga köp i perioden."
            }
            className="lg:col-span-7"
          >
            <SalesHeatmap heat={heat} days={data.period.days} />
          </Sub>
        </div>
      ) : (
        <StateMessage
          kind="empty"
          message={`Inga order i ${data.machine.code} ${data.period.rangeLabel}.`}
        />
      )}
    </section>
  );
}

function capitalize(s: string): string {
  return s ? s[0]!.toUpperCase() + s.slice(1) : s;
}

function StockSection({ data }: { data: MachineDetailData }) {
  const lines = data.stock;
  const now = lines.filter((l) => l.level === "now");
  const soon = lines.filter((l) => l.level === "soon");
  const packs = lines.reduce((n, l) => n + Math.max(0, l.onHand), 0);
  const known = lines.filter((l) => l.daysLeft !== null);
  const minDays = known.length > 0 ? Math.min(...known.map((l) => l.daysLeft ?? 0)) : null;
  const tz = data.ctx.timeZone;
  const restocked = data.lastRestockedAt
    ? formatDateTime(wallClockIn(new Date(data.lastRestockedAt), tz), {
        now: wallClockIn(new Date(data.ctx.now), tz),
      })
    : null;
  const title =
    now.length > 0
      ? `${formatInt(now.length)} ${now.length === 1 ? "titel" : "titlar"} behöver fyllas på nu.`
      : soon.length > 0
        ? `${formatInt(soon.length)} ${soon.length === 1 ? "titel" : "titlar"} behöver fyllas på snart.`
        : minDays !== null
          ? `Lagret räcker minst ${formatInt(minDays)}${NBSP}${minDays === 1 ? "dag" : "dagar"}.`
          : packs > 0
            ? "Lagret räcker."
            : "Automaten är tom.";
  return (
    <section aria-labelledby="lager" className="flex flex-col gap-8 border-t border-line pt-8">
      <SectionHeader
        id="lager"
        index={3}
        eyebrow="Lager · nu"
        title={title}
        aside={sentence(
          `${formatInt(packs)}${NBSP}pack i automaten${restocked ? `, senast påfylld ${restocked}` : ""}`,
        )}
      />
      {lines.length > 0 ? (
        <StockTable lines={lines} timeZone={tz} now={data.ctx.now} />
      ) : (
        <StateMessage
          kind="empty"
          message={`Inget lager registrerat i ${data.machine.code}.`}
          detail="Påfyllningar registreras under Lager."
          action={{ label: "Öppna Lager →", href: "/lager" }}
        />
      )}
    </section>
  );
}

function OrdersSection({ data }: { data: MachineDetailData }) {
  const orders = data.recentOrders;
  const latest = orders[0];
  const tz = data.ctx.timeZone;
  return (
    <section
      aria-labelledby="senaste-order"
      className="flex flex-col gap-8 border-t border-line pt-8"
    >
      <SectionHeader
        id="senaste-order"
        index={4}
        eyebrow="Senaste order"
        title={
          latest
            ? sentence(
                `Senaste ordern ${formatDateTime(wallClockIn(new Date(latest.orderedAt), tz), {
                  now: wallClockIn(new Date(data.ctx.now), tz),
                })}`,
              )
            : "Inga order ännu."
        }
        aside={
          latest
            ? sentence(`${latest.titleName} för ${formatSek(latest.amountOre / 100)}`)
            : undefined
        }
      />
      {orders.length > 0 ? (
        <RecentOrdersTable orders={orders} timeZone={tz} now={data.ctx.now} />
      ) : (
        <StateMessage
          kind="empty"
          message={`Inga order är kopplade till ${data.machine.code}.`}
          detail="Order från Awish kopplas till automaten under Datakällor."
          action={{ label: "Öppna Datakällor →", href: "/datakallor" }}
        />
      )}
    </section>
  );
}

function PlacementSection({ data }: { data: MachineDetailData }) {
  const placements = data.placements;
  const store = data.store;
  const stores = new Set(placements.map((p) => p.storeId)).size;
  return (
    <section aria-labelledby="placering" className="flex flex-col gap-8 border-t border-line pt-8">
      <SectionHeader
        id="placering"
        index={5}
        eyebrow="Placering"
        title={
          store
            ? sentence(`Står i ${store.name} sedan ${dayText(store.since, data.ctx.today)}`)
            : "Står inte i någon butik."
        }
        aside={
          placements.length > 0
            ? `${formatInt(placements.length)} ${placements.length === 1 ? "placering" : "placeringar"} i ${formatInt(stores)} ${stores === 1 ? "butik" : "butiker"}.`
            : undefined
        }
      />
      {placements.length > 0 ? (
        <PlacementsTable placements={placements} now={data.ctx.now} />
      ) : (
        <StateMessage
          kind="empty"
          message={`${data.machine.code} har aldrig stått i någon butik.`}
          detail={
            data.ctx.canEdit
              ? "Placera den i en butik så räknas hyra och provision."
              : "Ägare och admin placerar automater i butiker."
          }
        />
      )}
    </section>
  );
}

function UnitEconomicsSection({ data }: { data: MachineDetailData }) {
  const u = data.unitEconomics;
  const q = new URLSearchParams(data.query.replace(/^\?/, ""));
  q.set("automat", data.machine.id);
  const href = `/automater/enhetsekonomi?${q.toString()}`;
  return (
    <section
      id="enhetsekonomi-sektion"
      aria-labelledby="enhetsekonomi"
      className="flex flex-col gap-8 border-t border-line pt-8"
    >
      <SectionHeader
        id="enhetsekonomi"
        index={6}
        eyebrow="Enhetsekonomi"
        title={
          u
            ? u.paybackMonths === null
              ? "Automaten har inte gått med vinst ännu."
              : u.paybackMonths === 0
                ? "Investeringen är återbetald."
                : `Återbetalningstid ${formatDecimal(u.paybackMonths)}${NBSP}månader.`
            : "Investeringen är inte registrerad."
        }
        aside={
          u && u.profitPerMonthOre !== null
            ? `Vinst ${formatSek(u.profitPerMonthOre / 100)} per månad före avskrivning.`
            : undefined
        }
        actions={
          <Link href={href} className="meta rounded-xs text-muted hover:text-fg">
            Jämför med andra automater{NBSP}→
          </Link>
        }
      />
      {u ? (
        <MachineKpis items={unitEconomicsKpis(u)} label="Enhetsekonomi · till periodens slut" />
      ) : (
        <StateMessage
          kind="not-configured"
          message={`Inköp och installation av ${data.machine.code} saknas.`}
          detail="Återbetalningstid, bokfört värde och vinst efter avskrivning visas när investeringen är registrerad."
          action={data.ctx.canEdit ? { label: "Registrera investering →", href } : undefined}
        />
      )}
    </section>
  );
}

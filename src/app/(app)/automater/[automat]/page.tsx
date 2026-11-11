import type { Metadata } from "next";
import Link from "next/link";
import type React from "react";
import { Suspense } from "react";
import { notFound, redirect } from "next/navigation";

import { carriedQuery, parseIsoDate, wallClockIn } from "@/components/shell/period-state";
import { StoreShareToggle } from "@/components/shell/store-share-toggle";
import { requestStoreShareView } from "@/server/data/core";
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
import { BestAssortment } from "../_components/best-assortment";
import { PlacementsTable, RecentOrdersTable, StockTable } from "../_components/detail-tables";
import { MachineKpis } from "../_components/kpis";
import { personOptions } from "@/analytics/team";
import { loadTeamStateFor } from "@/server/data/team";

import { PersonPicker } from "../../_team/person-picker";
import { MachineActions } from "../_components/machine-dialogs";
import { ReadyList } from "../_components/ready-list";
import { RefillSourcePicker } from "../_components/refill-source";
import { Sub } from "../_components/sub";
import { UnpricedNote } from "../_components/unpriced-note";
import { pickTab, ViewTabs } from "../_components/view-tabs";
import {
  isMachineId,
  loadMachineDetail,
  resolveMachineCode,
  type MachineDetailData,
} from "../_lib/data";
import { dayText, hourRange, sentence, unitEconomicsKpis } from "../_lib/model";
import { refillByText, stockAsideText } from "../_lib/refill-text";
import { currentViewer } from "../_lib/session";
import { withUserDbFor } from "@/server/access";
import { queryRefillSources } from "@/server/data/core/places";
import { loadMachineReadinessSafe } from "@/server/onboarding/machine-ready-load";

const TABS = [
  { value: "forsaljning", label: "Försäljning" },
  { value: "lager", label: "Lager" },
  { value: "order", label: "Order" },
  { value: "ekonomi", label: "Placering och ekonomi" },
] as const;

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

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const slug = decodeURIComponent((await params).automat);
  return { title: isMachineId(slug) ? "Automat" : slug.toUpperCase() };
}

function capitalFirst(text: string): string {
  return text.charAt(0).toLocaleUpperCase("sv-SE") + text.slice(1);
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

  const [data, shareToggle] = await Promise.all([
    loadMachineDetail(automat, sp),
    requestStoreShareView(),
  ]);
  if (!data) notFound();

  const { ctx, machine, period, headline, status, store } = data;
  const days = `${formatInt(period.span.days)}${NBSP}d`;
  const comparison = period.comparisonLabel ? `Jämfört med ${period.comparisonLabel}` : undefined;
  const today = parseIsoDate(ctx.today) ?? new Date();
  const listHref = `/automater${data.query}`;
  const tab = pickTab(TABS, sp.vy);
  const rise = (i: number) => ({ "--i": i }) as React.CSSProperties;
  const sessionUser = { userId: ctx.user.id, email: ctx.user.email };
  const [team, readiness] = await Promise.all([
    loadTeamStateFor(sessionUser, ctx.organization.id),
    // Startklar: vad som är kvar innan automaten är helt inlagd (tom lista när allt är klart).
    loadMachineReadinessSafe(sessionUser, ctx.organization.id),
  ]);
  const responsible = team.responsibles.get(machine.id) ?? null;
  const ready = readiness.find((r) => r.machineId === machine.id && !r.complete) ?? null;
  // Länken "Välj butik" i Startklar (?gor=placera) öppnar rutan direkt.
  const openPlace = first(sp.gor) === "placera" && store === null;

  return (
    <div className="mx-auto flex w-full max-w-[1280px] flex-col gap-12 px-4 pt-6 pb-16 md:gap-16 md:px-8 md:pt-10">
      <div className="rise flex flex-col gap-6">
        <nav aria-label="Brödsmulor">
          <Link
            href={listHref}
            // min-h-7: klickytan minst 24 px hög (WCAG 2.5.8) även på mobilen.
            className="meta inline-flex min-h-7 items-center gap-1.5 rounded-xs text-subtle hover:text-fg max-md:tap max-md:min-h-11"
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
          eyebrow={`${machine.name} · ${machine.code}`}
          title={headline.title}
          aside={headline.aside}
          description={status.reason && status.status !== "ok" ? status.reason : undefined}
          meta={[
            {
              label: "Status",
              value:
                status.status === "ok" ? (
                  <span className="inline-flex items-center gap-2">
                    <span className="live-dot inline-block size-1.5 rounded-full bg-current text-muted" />
                    {status.label}
                  </span>
                ) : (
                  <StatusTag status={status.status}>{status.label}</StatusTag>
                ),
            },
            { label: "Butik", value: store?.name ?? MISSING },
            {
              label: "Ansvarig",
              value: (
                <PersonPicker
                  target={{ kind: "machine", machineId: machine.id }}
                  value={responsible ?? ""}
                  options={personOptions(ctx.user.id, team.team, responsible)}
                  label="Ansvarig"
                  hideLabel
                  editable={ctx.canEdit}
                />
              ),
            },
            machine.activeTo
              ? { label: "Sista dag", value: dayText(machine.activeTo, ctx.today) }
              : {
                  label: "Driftstart",
                  value: data.startedOn ? dayText(data.startedOn, ctx.today) : MISSING,
                },
          ]}
          actions={
            ctx.canEdit ? (
              <div className="flex flex-wrap items-center gap-2">
                <Link
                  href={`/fyll-pa/${machine.id}/qr`}
                  className="inline-flex h-9 items-center gap-2 rounded-sm border border-line-strong bg-surface px-3.5 text-base font-medium text-fg transition-colors duration-fast hover:border-line-control hover:bg-hover max-md:min-h-11"
                >
                  QR för påfyllning
                </Link>
                <MachineActions
                  machine={data.editable}
                  stores={data.stores}
                  today={ctx.today}
                  storeName={store?.name ?? null}
                  openMove={openPlace}
                />
              </div>
            ) : undefined
          }
        />
      </div>

      {ready ? <ReadyList ready={ready} canEdit={ctx.canEdit} /> : null}

      {period.pendingToday ? (
        <StateMessage kind="empty" message={`Inga order från ${machine.code} i dag än.`} />
      ) : (
        <div className="rise flex flex-col gap-4" style={rise(1)}>
          {/* Vår vinst före butikernas andel; med knappen efter butikens andel. */}
          <Suspense fallback={null}>
            <StoreShareToggle on={shareToggle} />
          </Suspense>
          <MachineKpis items={data.kpis} label={`Nyckeltal · ${days}`} comparison={comparison} />
          {data.unpriced ? <UnpricedNote unpriced={data.unpriced} canEdit={ctx.canEdit} /> : null}
        </div>
      )}

      <div className="rise -mb-6 md:-mb-10" style={rise(2)}>
        <ViewTabs
          tabs={TABS}
          value={tab}
          basePath={`/automater/${encodeURIComponent(machine.code.toLowerCase())}`}
          query={data.query}
          label="Visa"
        />
      </div>

      <div key={tab} className="fade-in flex flex-col gap-12 md:gap-16">
        {tab === "forsaljning" ? (
          <>
            <SalesSection data={data} days={days} today={today} />
            {/* Bästa sortiment: vad som säljer här och vad som bör bytas ut. */}
            {period.pendingToday ? null : (
              <Suspense fallback={null}>
                <BestAssortment machineId={machine.id} code={machine.code} searchParams={sp} />
              </Suspense>
            )}
            <TitlesAndHours data={data} days={days} />
          </>
        ) : null}
        {tab === "lager" ? <StockSection data={data} /> : null}
        {tab === "order" ? <OrdersSection data={data} /> : null}
        {tab === "ekonomi" ? (
          <>
            <PlacementSection data={data} />
            <UnitEconomicsSection data={data} />
          </>
        ) : null}
      </div>
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
            compareName={data.period.comparisonLabel ? "Perioden innan" : undefined}
          />
        </Panel>
      ) : (
        <StateMessage
          kind="empty"
          message={sentence(`Inga order i ${data.machine.code} ${data.period.rangeLabel}`)}
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
            label={`Bästa titlar · ${days}`}
            meta={`${formatInt(titles.length)} titlar`}
            title={`${formatInt(titles.length)} ${titles.length === 1 ? "titel" : "titlar"} såldes.`}
            className="lg:col-span-5"
          >
            <TitleBars titles={titles} />
          </Sub>
          <Sub
            label={`Köp per veckodag och timme · ${days}`}
            meta={`${formatInt(heat.total)}${NBSP}köp`}
            title={
              peak
                ? `${capitalize(WEEKDAYS_LONG[peak.weekday] ?? "")} ${hourRange(peak.hour)} toppar med ${formatInt(peak.count)}${NBSP}köp.`
                : "Inga köp i perioden."
            }
            className="lg:col-span-7"
          >
            <SalesHeatmap heat={heat} days={data.period.span.days} />
          </Sub>
        </div>
      ) : (
        <StateMessage
          kind="empty"
          message={sentence(`Inga order i ${data.machine.code} ${data.period.rangeLabel}`)}
        />
      )}
    </section>
  );
}

function capitalize(s: string): string {
  return s ? s[0]!.toUpperCase() + s.slice(1) : s;
}

/** Automatens "Fylls på från" (våra egna lager). */
async function RefillFrom({ data }: { data: MachineDetailData }) {
  const viewer = await currentViewer();
  const sources = await withUserDbFor(viewer.user, (tx) =>
    queryRefillSources(tx, viewer.organization.id),
  );
  if (sources.places.length === 0) return null;
  return (
    <RefillSourcePicker
      machineId={data.machine.id}
      machineLabel={data.machine.code}
      places={sources.places.map((p) => ({ id: p.id, name: p.name }))}
      current={sources.machineSource[data.machine.id] ?? null}
      defaultPlaceId={sources.defaultPlaceId}
      canEdit={data.ctx.role === "owner" || data.ctx.role === "admin"}
    />
  );
}

function StockSection({ data }: { data: MachineDetailData }) {
  const lines = data.stock;
  const now = lines.filter((l) => l.level === "now");
  const soon = lines.filter((l) => l.level === "soon");
  const packs = lines.reduce((n, l) => n + Math.max(0, l.onHand), 0);
  const known = lines.filter((l) => l.daysLeft !== null);
  const minDays = known.length > 0 ? Math.min(...known.map((l) => l.daysLeft ?? 0)) : null;
  const tz = data.ctx.timeZone;
  // Något ska fyllas på: rubriken är dagen ur besöksplanen (samma som Drift → Besök), och
  // antalet titlar står i den grå raden.
  const refillBy =
    data.refillBy && now.length + soon.length > 0
      ? refillByText(data.refillBy, data.ctx.today)
      : null;
  const count =
    now.length > 0
      ? `${formatInt(now.length)} ${now.length === 1 ? "titel" : "titlar"} behöver fyllas på nu.`
      : soon.length > 0
        ? `${formatInt(soon.length)} ${soon.length === 1 ? "titel" : "titlar"} behöver fyllas på snart.`
        : null;
  const title =
    refillBy ??
    count ??
    (minDays !== null
      ? `Lagret räcker minst ${formatInt(minDays)}${NBSP}${minDays === 1 ? "dag" : "dagar"}.`
      : packs > 0
        ? "Lagret räcker."
        : "Automaten är tom.");
  const aside = stockAsideText({
    packs,
    lastRefilledAt: data.lastRestockedAt,
    timeZone: tz,
    now: data.ctx.now,
  });
  return (
    <section aria-labelledby="lager" className="flex flex-col gap-8 border-t border-line pt-8">
      <SectionHeader
        id="lager"
        eyebrow="Lager · nu"
        title={title}
        aside={refillBy && count ? `${count} ${capitalFirst(aside)}` : aside}
      />
      <RefillFrom data={data} />
      {lines.length > 0 ? (
        <StockTable lines={lines} timeZone={tz} now={data.ctx.now} />
      ) : (
        <StateMessage
          kind="empty"
          message={`Inget lager registrerat i ${data.machine.code}.`}
          action={{ label: "Öppna Lager", href: "/lager" }}
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
          action={{ label: "Öppna Datakällor", href: "/datakallor" }}
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
        eyebrow="Placering"
        title={
          store
            ? sentence(`Står i ${store.name} sedan ${dayText(store.since, data.ctx.today)}`)
            : "Står inte i någon butik."
        }
        aside={
          [
            placements.length > 0
              ? `${formatInt(placements.length)} ${placements.length === 1 ? "placering" : "placeringar"} i ${formatInt(stores)} ${stores === 1 ? "butik" : "butiker"}.`
              : null,
            data.machine.serial ? `Serienummer ${data.machine.serial}.` : null,
          ]
            .filter(Boolean)
            .join(" ") || undefined
        }
      />
      {placements.length > 0 ? (
        <PlacementsTable placements={placements} now={data.ctx.now} />
      ) : (
        <StateMessage
          kind="empty"
          message={`${data.machine.code} har aldrig stått i någon butik.`}
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
        eyebrow="Enhetsekonomi"
        title={
          u
            ? u.paybackMonths === null
              ? "Automaten har inte gått med vinst ännu."
              : `Återbetalningstid ${formatDecimal(u.paybackMonths)}${NBSP}månader.`
            : "Investeringen är inte registrerad."
        }
        aside={
          u && u.profitPerMonthOre !== null
            ? `Vinst ${formatSek(u.profitPerMonthOre / 100)} per månad, ${data.storeShareDeducted ? "efter" : "före"} butikernas del.`
            : undefined
        }
        actions={
          <Link
            href={href}
            className="meta inline-flex min-h-7 items-center rounded-xs text-muted hover:text-fg max-md:tap max-md:min-h-11"
          >
            Jämför med andra automater{NBSP}→
          </Link>
        }
      />
      {u ? (
        <div className="flex flex-col gap-3">
          <MachineKpis
            items={unitEconomicsKpis(u)}
            label="Enhetsekonomi · till periodens slut"
            headingLevel={3}
          />
          <p className="meta text-subtle">
            Vinst/mån på {formatInt(u.activeDays)}
            {NBSP}d i butik · avskrivning {formatSek(u.monthlyDepreciationOre / 100)}/mån
          </p>
        </div>
      ) : (
        <StateMessage
          kind="not-configured"
          message={`Inköp och installation av ${data.machine.code} saknas.`}
          action={data.ctx.canEdit ? { label: "Registrera investering", href } : undefined}
        />
      )}
    </section>
  );
}

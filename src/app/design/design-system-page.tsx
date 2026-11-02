"use client";

import { useMemo, useState, type ReactNode } from "react";
import { AppShell } from "@/components/shell/app-shell";
import type { Period } from "@/components/shell/topbar";
import { Button, IconButton } from "@/components/ui/button";
import { DataTable, type Column } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import { Input, Select } from "@/components/ui/field";
import { CornerMarks, Panel, PanelHeader } from "@/components/ui/frame";
import { Icon, type IconName } from "@/components/ui/icon";
import { KpiCard } from "@/components/ui/kpi-card";
import { Modal } from "@/components/ui/modal";
import { SectionHeader } from "@/components/ui/section-header";
import { Segmented } from "@/components/ui/segmented";
import { KpiSkeleton, Skeleton, TableSkeleton } from "@/components/ui/skeleton";
import { StatusTag } from "@/components/ui/status-tag";
import { useToast } from "@/components/ui/toast";
import { BarChart } from "@/components/charts/bar-chart";
import { Heatmap } from "@/components/charts/heatmap";
import { LineChart } from "@/components/charts/line-chart";
import { ShareBar } from "@/components/charts/share-bar";
import { WaterfallChart } from "@/components/charts/waterfall-chart";
import { cn } from "@/lib/cn";
import {
  formatDay,
  formatDecimal,
  formatDelta,
  formatInt,
  formatPercent,
  formatSek,
  formatSekAxis,
  formatTkr,
  formatWeekdayDay,
} from "@/lib/format";
import {
  franchiseShare,
  heatDays,
  heatHours,
  heatValues,
  kpis,
  machines,
  periodDays,
  periodLabel,
  revenueSeries,
  waterfallSteps,
  type Machine,
} from "./sample-data";
import {
  ColorSpecimen,
  MotionSpecimen,
  RadiusSpecimen,
  SpacingSpecimen,
  TypeSpecimen,
} from "./token-specimens";

const axisSek = formatSekAxis;

function Section({
  id,
  children,
  className,
}: {
  id: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      id={id}
      aria-labelledby={`${id}-title`}
      className={cn("border-t border-line py-16 md:py-20", className)}
    >
      {children}
    </section>
  );
}

function Sub({
  label,
  children,
  className,
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-4", className)}>
      <p className="label text-subtle">{label}</p>
      {children}
    </div>
  );
}

const machineColumns: Column<Machine>[] = [
  {
    key: "id",
    header: "Automat",
    sortValue: (m) => m.id,
    render: (m) => (
      <div className="flex min-w-0 flex-col">
        <span className="truncate">{m.site}</span>
        <span className="label text-subtle">
          {m.id} · {m.city}
        </span>
      </div>
    ),
    footer: "Summa 14 automater",
  },
  {
    key: "status",
    header: "Status",
    sortValue: (m) => ["critical", "warning", "offline", "ok", "neutral"].indexOf(m.status),
    render: (m) => <StatusTag status={m.status} />,
    hideOnMobile: true,
  },
  {
    key: "revenue",
    header: "Intäkt",
    numeric: true,
    sortValue: (m) => m.revenue,
    render: (m) => formatSek(m.revenue),
  },
  {
    key: "packs",
    header: "Pack",
    numeric: true,
    sortValue: (m) => m.packs,
    render: (m) => formatInt(m.packs),
    hideOnMobile: true,
  },
  {
    key: "margin",
    header: "Marginal",
    numeric: true,
    sortValue: (m) => m.margin,
    render: (m) => formatPercent(m.margin, 1),
    hideOnMobile: true,
  },
  {
    key: "fill",
    header: "Fyllnad",
    numeric: true,
    sortValue: (m) => m.fill,
    render: (m) => <FillMeter value={m.fill} />,
  },
];

function FillMeter({ value }: { value: number }) {
  const low = value < 0.1;
  return (
    <span className="inline-flex items-center justify-end gap-2.5">
      <span className={cn(low && "text-signal-fg")}>{formatPercent(value)}</span>
      <span className="relative hidden h-1.5 w-16 bg-hover sm:block" aria-hidden>
        <span
          className={cn("absolute inset-y-0 left-0", low ? "bg-signal" : "bg-data-2")}
          style={{ width: `${value * 100}%` }}
        />
        <span className="absolute inset-y-[-2px] left-[20%] w-px bg-line-control" />
      </span>
    </span>
  );
}

const iconNames: IconName[] = [
  "overview",
  "sales",
  "machine",
  "inventory",
  "margin",
  "settings",
  "search",
  "filter",
  "calendar",
  "download",
  "alert",
  "info",
  "check",
  "close",
  "plus",
  "arrowUpRight",
  "external",
  "sun",
  "moon",
  "menu",
];

export function DesignSystemPage() {
  const [period, setPeriod] = useState<Period>("30d");
  const [modalOpen, setModalOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [chartMode, setChartMode] = useState<"intakt" | "jamfor">("jamfor");
  const toast = useToast();

  const k = useMemo(() => kpis(period), [period]);
  const series = useMemo(() => revenueSeries(period), [period]);
  const fleet = useMemo(() => machines(period), [period]);
  const heat = useMemo(() => heatValues(), []);
  const days = periodDays[period];

  const best = series.data[series.best];
  const barData = fleet
    .filter((m) => m.status !== "offline")
    .sort((a, b) => b.revenue - a.revenue)
    .map((m) => ({ label: m.id.slice(3), value: m.revenue, name: `${m.id} ${m.site}` }));
  const totalRevenue = fleet.reduce((s, m) => s + m.revenue, 0);
  const totalPacks = fleet.reduce((s, m) => s + m.packs, 0);
  const columns = machineColumns.map((c) =>
    c.key === "revenue"
      ? { ...c, footer: formatSek(totalRevenue) }
      : c.key === "packs"
        ? { ...c, footer: formatInt(totalPacks) }
        : c,
  );

  const first = series.data[0];
  const last = series.data[series.data.length - 1];
  const comparison =
    first && last ? `${formatDay(first.date)} – ${formatDay(last.date)}` : undefined;

  return (
    <AppShell
      activeHref="/design"
      crumbs={["Binderlab", "System", "Designsystem"]}
      period={period}
      onPeriodChange={setPeriod}
      comparison={comparison ? `Period ${comparison}` : undefined}
    >
      <div className="mx-auto w-full max-w-[1280px] px-4 md:px-8">
        {/* Inledning */}
        <div className="grid-field relative -mx-4 border-b border-line px-4 pt-14 pb-16 md:-mx-8 md:px-8 md:pt-20 md:pb-20">
          <div className="relative max-w-3xl">
            <p className="label flex items-center gap-2 text-subtle">
              <span className="size-1.5 bg-signal" aria-hidden />
              Designsystem · v0.1 · Fas 1
            </p>
            <h1 className="mt-5 text-[34px] leading-[38px] font-medium tracking-[-0.03em] text-balance hyphens-auto sm:text-3xl md:text-[56px] md:leading-[60px] md:tracking-[-0.035em]">
              Ett precisionsinstrument för automater.{" "}
              <span className="text-subtle">Varje linje har ett jobb.</span>
            </h1>
            <p className="mt-6 max-w-xl text-md text-muted">
              Tokens, komponenter och diagram för Binderlab. Allt nedan reagerar på periodvalet i
              toppbaren och på lägesväxlaren. Testa båda.
            </p>
          </div>
          <dl className="relative mt-12 grid grid-cols-2 gap-px overflow-hidden rounded-md border border-line bg-line md:grid-cols-4">
            {[
              ["01", "En signalfärg", "Orange-röd bara för det som kräver uppmärksamhet."],
              ["02", "Siffror först", "Stora, tabulära, högerställda."],
              [
                "03",
                "Konstruerade diagram",
                "Noder, hjälplinjer, annoteringar i stället för legender.",
              ],
              ["04", "Status utan färgberoende", "Form + text bär alltid betydelsen."],
            ].map(([n, t, d]) => (
              <div key={n} className="flex flex-col gap-2 bg-bg p-4 md:p-5">
                <dt className="label flex items-center gap-2 text-subtle">
                  <span className="text-fg">{n}</span> Princip
                </dt>
                <dd className="flex flex-col gap-1">
                  <span className="text-base font-medium">{t}</span>
                  <span className="text-sm text-muted">{d}</span>
                </dd>
              </div>
            ))}
          </dl>
        </div>

        {/* 01 Färg */}
        <Section id="farg" className="border-t-0">
          <SectionHeader
            id="farg-title"
            index={1}
            eyebrow="Färg"
            title="Gråskala med en signal."
            aside="Mörkt är huvudläget, ljust finns i andra hand."
            description="All text klarar minst 4.5:1 mot alla ytor i båda lägena. Formulärkanter når 3:1. ”Dekor” används bara för axlar och korsmarkeringar."
          />
          <div className="mt-10 grid gap-4 lg:grid-cols-2">
            <ColorSpecimen theme="dark" />
            <ColorSpecimen theme="light" />
          </div>
        </Section>

        {/* 02 Typografi */}
        <Section id="typografi">
          <SectionHeader
            id="typografi-title"
            index={2}
            eyebrow="Typografi"
            title="Geist för ord, Geist Mono för mått."
            aside="Tabulära siffror överallt där tal står i rad."
          />
          <div className="mt-10 grid gap-10 lg:grid-cols-[1fr_320px]">
            <TypeSpecimen />
            <Panel grid marks className="flex flex-col justify-between gap-8 self-start">
              <PanelHeader label="Tabulära siffror" meta="tnum" />
              <div className="tnum flex flex-col items-end gap-1 font-mono text-md">
                <span>1 111 kr</span>
                <span>48 720 kr</span>
                <span>128 640 kr</span>
                <span className="w-full border-t border-line-strong pt-1 text-right text-fg">
                  178 471 kr
                </span>
              </div>
              <div className="flex flex-col gap-2">
                <p className="label text-subtle">Tvådelad rubrik</p>
                <p className="text-lg font-medium">
                  Intäkt per dag.{" "}
                  <span className="text-subtle">
                    Bästa dagen var {best ? formatDay(best.date) : "–"}.
                  </span>
                </p>
              </div>
            </Panel>
          </div>
        </Section>

        {/* 03 Mått och rörelse */}
        <Section id="matt">
          <SectionHeader
            id="matt-title"
            index={3}
            eyebrow="Spacing · Radier · Rörelse"
            title="8px-rytm, små radier, snabb rörelse."
            aside="Inget studsar."
          />
          <div className="mt-10 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            <Panel>
              <PanelHeader label="Spacing" meta="bas 4px" className="mb-5" />
              <SpacingSpecimen />
            </Panel>
            <Panel>
              <PanelHeader label="Radier" meta="2 / 4 / 6" className="mb-5" />
              <RadiusSpecimen />
              <div className="mt-8 flex flex-col gap-3">
                <PanelHeader label="Kanter" meta="1px" />
                <div className="flex gap-3">
                  <span className="h-10 flex-1 border border-line" />
                  <span className="h-10 flex-1 border border-line-strong" />
                  <span className="h-10 flex-1 border border-line-control" />
                </div>
                <div className="label flex justify-between text-[10px] text-subtle">
                  <span>line</span>
                  <span>strong</span>
                  <span>control</span>
                </div>
              </div>
            </Panel>
            <Panel className="md:col-span-2 xl:col-span-1">
              <PanelHeader label="Rörelse" meta="120–180 ms" className="mb-5" />
              <MotionSpecimen />
            </Panel>
          </div>
        </Section>

        {/* 04 Kontroller */}
        <Section id="kontroller">
          <SectionHeader
            id="kontroller-title"
            index={4}
            eyebrow="Kontroller"
            title="Knappar, fält och val."
            aside="Raka hörn, tydligt fokus, aldrig piller."
          />
          <div className="mt-10 grid gap-4 lg:grid-cols-2">
            <Panel className="flex flex-col gap-8">
              <Sub label="Knappar">
                <div className="flex flex-wrap items-center gap-2">
                  <Button variant="primary">Fyll på automat</Button>
                  <Button iconLeft="download">Exportera</Button>
                  <Button variant="ghost" iconRight="arrowUpRight">
                    Öppna
                  </Button>
                  <Button variant="signal" iconLeft="alert">
                    Stoppa automat
                  </Button>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Button size="sm" variant="primary">
                    Spara
                  </Button>
                  <Button size="sm" iconLeft="filter">
                    Filter
                  </Button>
                  <Button size="sm" kbd="⌘K" iconLeft="search">
                    Sök
                  </Button>
                  <Button size="sm" loading>
                    Synkar
                  </Button>
                  <Button size="sm" disabled>
                    Inaktiv
                  </Button>
                </div>
              </Sub>
              <Sub label="Ikonknappar">
                <div className="flex flex-wrap items-center gap-2">
                  <IconButton icon="plus" label="Lägg till" variant="secondary" />
                  <IconButton icon="filter" label="Filtrera" variant="secondary" />
                  <IconButton icon="download" label="Ladda ner" />
                  <IconButton icon="more" label="Fler val" />
                  <IconButton icon="settings" label="Inställningar" size="sm" />
                </div>
              </Sub>
              <Sub label="Segmentväljare">
                <Segmented
                  label="Diagramläge"
                  value={chartMode}
                  onChange={setChartMode}
                  options={[
                    { value: "intakt", label: "Intäkt" },
                    { value: "jamfor", label: "Jämför" },
                  ]}
                />
                <p className="text-sm text-subtle">
                  Piltangenter flyttar valet. Styr linjediagrammet i sektion 06.
                </p>
              </Sub>
              <Sub label="Ikoner · 16px · 1.25 linje">
                <div className="grid grid-cols-10 gap-px overflow-hidden rounded-sm border border-line bg-line">
                  {iconNames.map((n) => (
                    <span
                      key={n}
                      title={n}
                      className="grid aspect-square place-items-center bg-surface text-muted"
                    >
                      <Icon name={n} />
                    </span>
                  ))}
                </div>
              </Sub>
            </Panel>
            <Panel className="flex flex-col gap-6">
              <Sub label="Fält">
                <div className="grid gap-4 sm:grid-cols-2">
                  <Input label="Sök automat" placeholder="BL-001, Nordstan …" icon="search" />
                  <Input
                    label="Inköpspris"
                    type="number"
                    defaultValue={42}
                    suffix="kr"
                    hint="Per pack, exkl. moms"
                  />
                  <Input
                    label="Larmgräns lager"
                    type="number"
                    defaultValue={4}
                    suffix="%"
                    error="Måste vara minst 5 %"
                  />
                  <Input label="Platsnamn" defaultValue="Westfield Arninge" disabled />
                </div>
              </Sub>
              <Sub label="Val">
                <div className="grid gap-4 sm:grid-cols-2">
                  <Select
                    label="Automat"
                    defaultValue="BL-010"
                    options={fleet.map((m) => ({ value: m.id, label: `${m.id} · ${m.site}` }))}
                  />
                  <Select
                    label="Gruppera efter"
                    options={[
                      { value: "dag", label: "Dag" },
                      { value: "vecka", label: "Vecka" },
                      { value: "manad", label: "Månad" },
                    ]}
                  />
                </div>
              </Sub>
              <Sub label="Statusetiketter">
                <div className="flex flex-wrap gap-2">
                  <StatusTag status="ok" />
                  <StatusTag status="warning">Lågt lager</StatusTag>
                  <StatusTag status="critical">Slut i fack 3</StatusTag>
                  <StatusTag status="offline" />
                  <StatusTag status="neutral">Synkad 14:32</StatusTag>
                </div>
                <p className="text-sm text-subtle">
                  Form bär status: fylld, halvfylld, signalkvadrat, streckad. Text står alltid
                  bredvid.
                </p>
              </Sub>
            </Panel>
          </div>
        </Section>

        {/* 05 Data */}
        <Section id="data">
          <SectionHeader
            id="data-title"
            index={5}
            eyebrow="Nyckeltal · Tabell"
            title={`${formatSek(k.revenue)} på ${periodLabel[period]}.`}
            aside="Byt period i toppbaren så räknar siffrorna om."
          />
          <div className="mt-10 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <KpiCard
              label="Intäkt"
              value={k.revenue}
              format={formatSek}
              delta={k.revenueDelta}
              trend={k.trend}
            />
            <KpiCard
              label="Sålda pack"
              value={k.packs}
              format={formatInt}
              delta={k.packsDelta}
              trend={k.packTrend}
            />
            <KpiCard
              label="Bruttomarginal"
              value={k.margin}
              format={(v) => `${formatDecimal(v)} %`}
              delta={k.marginDelta}
              trend={k.marginTrend}
            />
            <KpiCard
              label="Slutförsäljningar"
              value={k.stockouts}
              format={formatInt}
              delta={k.stockoutsDelta}
              trend={k.stockTrend}
              invert
              alert
              alertText="Över gräns"
            />
          </div>

          <Panel className="mt-3" padded={false}>
            <div className="flex flex-col gap-3 border-b border-line p-4 sm:flex-row sm:items-center sm:justify-between md:px-5">
              <div className="flex flex-col gap-0.5">
                <span className="label text-muted">Automater · {periodLabel[period]}</span>
                <span className="text-sm text-subtle">
                  Klicka på kolumnrubriker för att sortera. Signalkvadrat = kräver åtgärd.
                </span>
              </div>
              <div className="flex gap-2">
                <Button size="sm" iconLeft="filter">
                  Filter
                </Button>
                <Button size="sm" iconLeft="download">
                  CSV
                </Button>
              </div>
            </div>
            <div className="px-4 pb-2 md:px-5">
              <DataTable
                caption="Automater med intäkt, sålda pack, marginal och fyllnadsgrad"
                columns={columns}
                rows={fleet}
                rowKey={(m) => m.id}
                defaultSort={{ key: "revenue", dir: "desc" }}
                isFlagged={(m) => m.status === "critical"}
              />
            </div>
          </Panel>
        </Section>

        {/* 06 Diagram */}
        <Section id="diagram">
          <SectionHeader
            id="diagram-title"
            index={6}
            eyebrow="Diagram"
            title="Intäkt per dag."
            aside={best ? `Bästa dagen var ${formatDay(best.date)}.` : undefined}
            description="Hovra eller tabba in i diagrammet och använd piltangenterna. Crosshair och läsruta ger exakt värde."
          />

          <Panel className="mt-10" grid marks>
            <PanelHeader
              label="Linje / yta"
              meta={`${series.data.length} dagar · ${comparison ?? ""}`}
              className="mb-2"
            />
            <LineChart
              data={series.data}
              compare={chartMode === "jamfor" ? series.compare : undefined}
              format={formatSek}
              formatAxis={axisSek}
              highlightIndex={series.best}
              reference={{
                value: series.data.reduce((s, d) => s + d.value, 0) / series.data.length,
                label: "Snitt",
              }}
              annotations={
                best && series.weekDelta !== undefined
                  ? [
                      {
                        index: series.best,
                        text: `${formatDelta(series.weekDelta)} mot veckan innan`,
                        sub: `${formatWeekdayDay(best.date)} · släpp`,
                      },
                    ]
                  : []
              }
              height={320}
              summary={`Intäkt per dag de senaste ${series.data.length} dagarna. Högst ${best ? formatSek(best.value) : ""} ${best ? formatDay(best.date) : ""}.`}
              seriesName="Period"
              compareName="Föreg. period"
            />
          </Panel>

          <div className="mt-3 grid gap-3 lg:grid-cols-2">
            <Panel>
              <SectionHeader
                index="06.1"
                eyebrow="Stapel"
                title="Intäkt per automat."
                aside="Toppen sticker ut."
                as="h3"
                size="md"
              />
              <div className="mt-6">
                <BarChart
                  data={barData}
                  format={formatSek}
                  formatAxis={axisSek}
                  highlightIndex={0}
                  highlightNote={barData[0]?.name.split(" ").slice(1).join(" ")}
                  summary="Intäkt per automat, sorterat störst först."
                />
              </div>
            </Panel>
            <Panel>
              <SectionHeader
                index="06.2"
                eyebrow="Vattenfall"
                title="Från brutto till netto."
                aside="Svinn är över mål."
                as="h3"
                size="md"
              />
              <div className="mt-6">
                <WaterfallChart
                  steps={waterfallSteps}
                  format={formatSek}
                  formatAxis={formatTkr}
                  summary="Vattenfall från bruttoförsäljning via moms, kortavgifter, inköp, hyra och svinn till nettoresultat."
                />
              </div>
            </Panel>
            <Panel>
              <SectionHeader
                index="06.3"
                eyebrow="Värmekarta"
                title="Köp per timme."
                aside="Lördag eftermiddag är toppen."
                as="h3"
                size="md"
              />
              <div className="mt-6">
                <Heatmap
                  values={heat}
                  rowLabels={heatDays}
                  colLabels={heatHours}
                  format={(v) => `${formatInt(v)} köp`}
                  cellLabel={(r, c) =>
                    `${heatDays[r]} ${heatHours[c]}–${String(Number(heatHours[c]) + 1).padStart(2, "0")}`
                  }
                  summary="Antal köp per veckodag och timme mellan 08 och 22."
                />
              </div>
            </Panel>
            <Panel>
              <SectionHeader
                index="06.4"
                eyebrow="Andelsstapel"
                title="Försäljning per serie."
                aside="Pokémon bär 55 %."
                as="h3"
                size="md"
              />
              <div className="mt-6">
                <ShareBar
                  segments={franchiseShare}
                  format={formatSek}
                  summary="Andel av försäljningen per kortserie: Pokémon, One Piece, Lorcana, Magic och övrigt."
                />
              </div>
            </Panel>
          </div>
        </Section>

        {/* 07 Tillstånd */}
        <Section id="tillstand">
          <SectionHeader
            id="tillstand-title"
            index={7}
            eyebrow="Tillstånd · Återkoppling"
            title="Tomt, laddar, klart."
            aside="Varje läge har en tydlig form."
            actions={
              <Button size="sm" onClick={() => setLoading((v) => !v)}>
                {loading ? "Visa innehåll" : "Visa laddning"}
              </Button>
            }
          />
          <div className="mt-10 grid gap-3 lg:grid-cols-3">
            <EmptyState
              title="Inga försäljningar ännu"
              description="BL-014 Kista Galleria har inte rapporterat sedan installationen. Kontrollera uppkopplingen."
              action={
                <Button size="sm" iconLeft="external">
                  Öppna felsökning
                </Button>
              }
            />
            <div className="flex flex-col gap-3">
              {loading ? (
                <KpiSkeleton />
              ) : (
                <KpiCard
                  label="Intäkt idag"
                  value={Math.round(k.revenue / days)}
                  format={formatSek}
                  delta={0.042}
                  trend={k.trend.slice(-7)}
                />
              )}
              <Panel>
                <PanelHeader label="Skeleton" meta="1,6 s puls" className="mb-4" />
                <div className="flex flex-col gap-2">
                  <Skeleton className="h-3 w-3/4" />
                  <Skeleton className="h-3 w-1/2" />
                  <Skeleton className="h-3 w-2/3" />
                </div>
              </Panel>
            </div>
            <Panel>
              <PanelHeader label="Tabell laddar" className="mb-2" />
              <TableSkeleton rows={5} />
            </Panel>
          </div>

          <div className="mt-3 grid gap-3 md:grid-cols-2">
            <Panel className="flex flex-col gap-4">
              <PanelHeader label="Toast" meta="aria-live" />
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  onClick={() =>
                    toast({
                      title: "Påfyllning registrerad",
                      description: "48 pack lades till i BL-003 Täby Centrum.",
                      tone: "ok",
                      meta: "BL-003 · 14:32",
                      action: {
                        label: "Ångra",
                        onClick: () => toast({ title: "Påfyllning ångrad" }),
                      },
                    })
                  }
                >
                  Bekräftelse
                </Button>
                <Button
                  size="sm"
                  onClick={() =>
                    toast({
                      title: "Fack 3 är tomt",
                      description: "BL-010 Westfield Arninge sålde slut på One Piece OP-09.",
                      tone: "critical",
                      meta: "BL-010 · nyss",
                    })
                  }
                >
                  Kritisk
                </Button>
                <Button
                  size="sm"
                  onClick={() =>
                    toast({ title: "Export klar", description: "automater_okt.csv · 14 rader" })
                  }
                >
                  Neutral
                </Button>
              </div>
            </Panel>
            <Panel className="flex flex-col gap-4">
              <PanelHeader label="Modal" meta="dialog · Esc stänger" />
              <div>
                <Button size="sm" variant="primary" onClick={() => setModalOpen(true)}>
                  Registrera påfyllning
                </Button>
              </div>
            </Panel>
          </div>

          <Modal
            open={modalOpen}
            onClose={() => setModalOpen(false)}
            eyebrow="Automat / BL-010"
            title="Registrera påfyllning"
            description="Westfield Arninge, Täby. Senast påfylld för 6 dagar sedan."
            footer={
              <>
                <Button onClick={() => setModalOpen(false)}>Avbryt</Button>
                <Button
                  variant="primary"
                  onClick={() => {
                    setModalOpen(false);
                    toast({
                      title: "Påfyllning registrerad",
                      tone: "ok",
                      meta: "BL-010 · 36 pack",
                    });
                  }}
                >
                  Spara påfyllning
                </Button>
              </>
            }
          >
            <div className="grid gap-4 sm:grid-cols-2">
              <Select
                label="Produkt"
                options={[
                  { value: "sv8", label: "Pokémon SV8 Booster" },
                  { value: "op09", label: "One Piece OP-09" },
                  { value: "lor7", label: "Lorcana Kap. 7" },
                ]}
              />
              <Input label="Antal" type="number" defaultValue={36} suffix="st" />
              <Input label="Fack" type="number" defaultValue={3} />
              <Input label="Inköpspris" type="number" defaultValue={42} suffix="kr" />
            </div>
          </Modal>
        </Section>

        {/* 08 Lägen */}
        <Section id="lagen">
          <SectionHeader
            id="lagen-title"
            index={8}
            eyebrow="Lägen"
            title="Samma instrument, två lägen."
            aside="Tokens byts, komponenterna är desamma."
          />
          <div className="mt-10 grid gap-3 lg:grid-cols-2">
            {(["dark", "light"] as const).map((t) => (
              <div
                key={t}
                data-theme={t}
                className="relative flex flex-col gap-3 rounded-md border border-line bg-bg p-3 md:p-4"
              >
                <CornerMarks />
                <div className="flex items-center justify-between px-1">
                  <span className="label text-fg">{t === "dark" ? "Mörkt" : "Ljust"}</span>
                  <div className="flex gap-2">
                    <StatusTag status="ok" />
                    <StatusTag status="critical">Kritisk</StatusTag>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <KpiCard
                    label="Intäkt"
                    value={k.revenue}
                    format={formatSek}
                    delta={k.revenueDelta}
                    trend={k.trend}
                  />
                  <KpiCard
                    label="Slutförsäljn."
                    value={k.stockouts}
                    format={formatInt}
                    delta={k.stockoutsDelta}
                    trend={k.stockTrend}
                    invert
                    alert
                    alertText="Gräns"
                  />
                </div>
                <Panel>
                  <LineChart
                    data={series.data.slice(-14)}
                    format={formatSek}
                    formatAxis={axisSek}
                    highlightIndex={series.data
                      .slice(-14)
                      .reduce((bi, d, i, arr) => (d.value > (arr[bi]?.value ?? 0) ? i : bi), 0)}
                    height={200}
                    summary="Intäkt per dag, senaste 14 dagarna."
                  />
                </Panel>
                <div className="flex gap-2">
                  <Button size="sm" variant="primary">
                    Primär
                  </Button>
                  <Button size="sm">Sekundär</Button>
                  <Button size="sm" variant="signal">
                    Signal
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </Section>

        <footer className="label flex flex-col gap-2 border-t border-line py-8 text-subtle sm:flex-row sm:justify-between">
          <span>Binderlab · Designsystem v0.1</span>
          <span>Tokens: src/styles/tokens.css</span>
        </footer>
      </div>
    </AppShell>
  );
}

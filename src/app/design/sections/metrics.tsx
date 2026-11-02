"use client";

import { useMemo } from "react";
import { DataTable, type Column } from "@/components/ui/data-table";
import { KpiStrip, type KpiItem } from "@/components/ui/kpi-strip";
import { StatusTag } from "@/components/ui/status-tag";
import { cn } from "@/lib/cn";
import {
  NBSP,
  formatDate,
  formatDateTime,
  formatDelta,
  formatInt,
  formatKronor,
  formatPercent,
  formatSek,
} from "@/lib/format";
import { mean, sentence, type Model } from "../model";
import {
  EMPTY_SLOT,
  REF_NOW,
  REFILL_THRESHOLD,
  dayIndex,
  emptySlotsByDay,
  machineById,
  machineStates,
  machines as allMachines,
  revenueByDay,
  storeById,
  titles,
  type Machine,
  type Totals,
} from "../sample-data";
import { OrderTable } from "./grid";
import { SpecSection, Sub } from "./section";

type MachineRow = {
  machine: Machine;
  totals: Totals;
  status: (typeof machineStates)[number] | undefined;
};

/** Fyllnadsgrad med tröskel vid 20 %. Under gränsen: signalstapel och texten "under gräns". */
export function FillMeter({ value }: { value: number }) {
  const low = value < REFILL_THRESHOLD;
  return (
    <span className="inline-flex items-center justify-end gap-2.5">
      <span className={cn("tnum", low && "text-signal-fg")}>
        {formatPercent(value, 0)}
        {low ? <span className="sr-only"> under gräns</span> : null}
      </span>
      <span className="relative hidden h-1.5 w-16 bg-hover sm:block" aria-hidden>
        <span
          className={cn("absolute inset-y-0 left-0", low ? "bg-signal" : "bg-data-2")}
          style={{ width: `${value * 100}%` }}
        />
        <span
          className="absolute -inset-y-0.5 w-px bg-fg"
          style={{ left: `${REFILL_THRESHOLD * 100}%` }}
        />
      </span>
    </span>
  );
}

function machineColumns(rows: ReadonlyArray<MachineRow>, t: Totals): Column<MachineRow>[] {
  const fillAvg = mean(rows.map((r) => r.status?.fill ?? 0));
  return [
    {
      key: "machine",
      header: "Automat",
      width: 200,
      sortValue: (r) => r.machine.code,
      render: (r) => (
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="meta shrink-0 text-subtle">{r.machine.code.replace("-", "‑")}</span>
          <span className="truncate">{storeById.get(r.machine.storeId)?.name}</span>
        </span>
      ),
      footer: `Summa ${rows.length} st`,
    },
    {
      key: "status",
      header: "Status",
      width: 152,
      sortValue: (r) =>
        ["critical", "warning", "offline", "ok", "neutral"].indexOf(r.status?.status ?? "ok"),
      render: (r) =>
        r.status ? (
          <StatusTag status={r.status.status}>
            {r.status.status === "ok" ? undefined : r.status.statusText}
          </StatusTag>
        ) : null,
    },
    {
      key: "revenue",
      header: "Intäkt",
      numeric: true,
      sortValue: (r) => r.totals.revenue,
      render: (r) => formatSek(r.totals.revenue / 100),
      footer: formatSek(t.revenue / 100),
    },
    {
      key: "packs",
      header: "Pack",
      numeric: true,
      hideOnMobile: true,
      sortValue: (r) => r.totals.orders,
      render: (r) => formatInt(r.totals.orders),
      footer: formatInt(t.orders),
    },
    {
      key: "margin",
      header: "Marginal",
      numeric: true,
      hideOnMobile: true,
      sortValue: (r) => r.totals.margin ?? -1,
      render: (r) => (r.totals.margin === null ? "–" : formatPercent(r.totals.margin)),
      footer: (
        <span className="text-muted">
          Snitt {t.margin === null ? "–" : formatPercent(t.margin)}
        </span>
      ),
    },
    {
      key: "fill",
      header: "Fyllnad",
      numeric: true,
      // Under sm bär statusetiketten fyllnaden ("Fyllnad 17 %").
      hideOnMobile: true,
      sortValue: (r) => r.status?.fill ?? 0,
      render: (r) => <FillMeter value={r.status?.fill ?? 0} />,
      footer: <span className="text-muted">Snitt {formatPercent(fillAvg, 0)}</span>,
    },
    {
      key: "refill",
      header: "Påfylld",
      numeric: true,
      hideOnMobile: true,
      sortValue: (r) => r.status?.lastRefill.getTime() ?? 0,
      render: (r) =>
        r.status ? (
          <span className="tnum text-muted">
            {formatDate(r.status.lastRefill, { year: "auto", now: REF_NOW })}
          </span>
        ) : null,
    },
  ];
}

/** Daglig marginal (utan hyra) och dagligt antal ur samma ordrar. */
function dailySeries(model: Model) {
  const n = model.days;
  const first = dayIndex(model.range.start);
  const packs = new Array<number>(n).fill(0);
  const priced = new Array<number>(n).fill(0);
  const profit = new Array<number>(n).fill(0);
  for (const o of model.orders) {
    const i = o.day - first;
    if (i < 0 || i >= n) continue;
    packs[i] = (packs[i] ?? 0) + 1;
    const tt = titles[o.title];
    const m = allMachines[o.machine];
    const s = m ? storeById.get(m.storeId) : undefined;
    if (!tt || tt.costOre === null) continue;
    priced[i] = (priced[i] ?? 0) + o.amountOre;
    profit[i] =
      (profit[i] ?? 0) +
      o.amountOre -
      tt.costOre -
      Math.round((o.amountOre * (s?.commissionBp ?? 0)) / 10_000);
  }
  const margin = priced.map((p, i) => (p ? ((profit[i] ?? 0) / p) * 100 : 0));
  return { packs, margin };
}

export function MetricsSection({ index, model }: { index: number; model: Model }) {
  const n = String(index).padStart(2, "0");
  const { t, prev } = model;

  const revenue = useMemo(() => revenueByDay(model.orders, model.range), [model]);
  const prevRevenue = useMemo(
    () => (model.previous ? revenueByDay(model.prevOrders, model.previous) : null),
    [model],
  );
  const daily = useMemo(() => dailySeries(model), [model]);
  const emptyNow = model.emptyByDay[model.emptyByDay.length - 1] ?? 0;
  const emptyBefore = model.previous
    ? (emptySlotsByDay(model.previous, model.machineIdx).at(-1) ?? 0)
    : null;

  const rel = (a: number, b: number | undefined) => (b ? { delta: a / b - 1 } : undefined);

  const items: KpiItem[] = [
    {
      id: "revenue",
      label: "Intäkt",
      value: t.revenue / 100,
      format: formatSek,
      delta: rel(t.revenue, prev?.revenue),
      trend: revenue,
      reference: prevRevenue ? mean(prevRevenue) : undefined,
      primary: true,
    },
    {
      id: "profit",
      label: "Vinst",
      value: t.profit / 100,
      format: formatSek,
      delta: rel(t.profit, prev?.profit),
      trend: revenue.map((v, i) => (v * (daily.margin[i] ?? 0)) / 100),
    },
    {
      id: "margin",
      label: "Marginal",
      value: (t.margin ?? 0) * 100,
      format: (v) => formatPercent(v / 100),
      delta:
        prev?.margin !== null && prev?.margin !== undefined && t.margin !== null
          ? { delta: (t.margin - prev.margin) * 100, kind: "absolute", unit: "p.e." }
          : undefined,
      trend: daily.margin,
    },
    {
      id: "packs",
      label: "Sålda pack",
      value: t.orders,
      format: (v) => `${formatInt(v)}${NBSP}st`,
      delta: rel(t.orders, prev?.orders),
      trend: daily.packs,
    },
    {
      id: "empty",
      label: "Tomma fack",
      value: emptyNow,
      format: (v) => `${formatInt(v)}${NBSP}st`,
      delta:
        emptyBefore === null
          ? undefined
          : { delta: emptyNow - emptyBefore, kind: "absolute", unit: "st", invert: true },
      trend: model.emptyByDay,
      alert: emptyNow > 0,
      alertText: `${machineById.get(EMPTY_SLOT.machineId)?.code ?? ""} fack ${EMPTY_SLOT.slot}`,
    },
  ];

  const rows: MachineRow[] = model.machines.map((m) => ({
    machine: m.machine,
    totals: m.totals,
    status: machineStates.find((s) => s.machineId === m.machine.id),
  }));
  const columns = machineColumns(rows, t);
  const flagged = rows.filter((r) => r.status?.status === "critical").length;
  const warned = rows.filter((r) => r.status?.status === "warning").length;

  const deltaText =
    prev && prev.revenue
      ? sentence(`${formatDelta(t.revenue / prev.revenue - 1, 1)} mot ${model.comparisonLabel}`)
      : sentence(`Sedan ${formatDate(model.range.start, { year: "always" })}`);

  return (
    <SpecSection
      id="nyckeltal"
      index={index}
      eyebrow="Nyckeltal och tabeller"
      title={`${formatSek(t.revenue / 100)} på ${formatInt(model.days)} ${model.days === 1 ? "dag" : "dagar"}.`}
      aside={deltaText}
      space="loose"
      meta={[
        { label: "Period", value: model.rangeLabel },
        { label: "Automater", value: `${model.machineIdx.length} av ${allMachines.length}` },
        { label: "Synkad", value: formatDateTime(REF_NOW, { now: REF_NOW }) },
      ]}
    >
      <div className="lg:col-span-12">
        <KpiStrip
          label={`Nyckeltal · ${formatInt(model.days)} d`}
          comparison={
            model.comparisonLabel ? `Jämfört med ${model.comparisonLabel}` : "Ingen jämförelse"
          }
          items={items}
        />
        {t.unpricedOrders ? (
          <p className="meta mt-3 text-subtle">
            Vinst och marginal räknar {formatInt(t.orders - t.unpricedOrders)} av{" "}
            {formatInt(t.orders)} ordrar. {formatInt(t.unpricedOrders)} saknar inköpspris (
            {formatKronor(t.unpricedRevenue / 100, { decimals: 0 })}).
          </p>
        ) : null}
      </div>

      <Sub
        index={`${n}.1`}
        label={`Automater · ${formatInt(model.days)} d`}
        meta={`${rows.length} automater · ${flagged} kräver åtgärd · ${warned} varning`}
        className="lg:col-span-12"
      >
        <DataTable
          caption="Automater med status, intäkt, sålda pack, marginal, fyllnad och senaste påfyllning"
          columns={columns}
          rows={rows}
          rowKey={(r) => r.machine.id}
          defaultSort={{ key: "revenue", dir: "desc" }}
          dense
          surface="bg"
        />
      </Sub>

      <Sub
        index={`${n}.2`}
        label={`Awish-ordrar · ${formatInt(model.days)} d`}
        meta="1 order = 1 pack"
        title={`${formatInt(t.orders)} ordrar summerar till ${formatKronor(t.revenue / 100)}.`}
        className="lg:col-span-12"
      >
        <OrderTable orders={model.orders} range={model.range} total={t.revenue} />
      </Sub>
    </SpecSection>
  );
}

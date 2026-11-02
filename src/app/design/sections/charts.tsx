"use client";

import { BarChart } from "@/components/charts/bar-chart";
import { Heatmap } from "@/components/charts/heatmap";
import { LineChart } from "@/components/charts/line-chart";
import { ProfitBridge } from "@/components/charts/profit-bridge";
import { ShareBar } from "@/components/charts/share-bar";
import { Panel } from "@/components/ui/frame";
import { calendarDaysBetween } from "@/lib/period";
import {
  NBSP,
  formatDate,
  formatDelta,
  formatInt,
  formatPercent,
  formatSek,
  formatTime,
} from "@/lib/format";
import { mean, sentence, sum, type Model } from "../model";
import {
  EMPTY_SLOT,
  REF_NOW,
  RELEASE_DAY,
  heatDays,
  heatHours,
  machineById,
  storeById,
  titleById,
} from "../sample-data";
import { SpecSection, Sub } from "./section";

const WEEKDAYS = ["Sön", "Mån", "Tis", "Ons", "Tor", "Fre", "Lör"];
const weekday = (d: Date) => WEEKDAYS[d.getDay()] ?? "";

const hourRange = (c: number) => {
  const h = Number(heatHours[c]);
  return `${String(h).padStart(2, "0")}–${String(h + 1).padStart(2, "0")}`;
};

export function ChartsSection({ index, model }: { index: number; model: Model }) {
  const n = String(index).padStart(2, "0");
  const { chart, t } = model;
  const days = chart.dates.length;
  const data = chart.dates.map((date, i) => ({ date, value: chart.values[i] ?? 0 }));
  const avg = mean(chart.values);

  // Topp: högsta dagen. Annoteras i fg, aldrig signal.
  const peak = chart.values.reduce((b, v, i) => (v > (chart.values[b] ?? 0) ? i : b), 0);
  const peakDate = chart.dates[peak];
  const weekBefore = chart.values[peak - 7];
  const releaseIdx = chart.dates.findIndex((d) => calendarDaysBetween(RELEASE_DAY, d) === 0);
  const todayIdx = chart.dates.findIndex((d) => calendarDaysBetween(REF_NOW, d) === 0);
  const emptyIdx = chart.dates.findIndex((d) => calendarDaysBetween(EMPTY_SLOT.since, d) === 0);
  const emptyMachine = machineById.get(EMPTY_SLOT.machineId);
  const showsEmpty = emptyIdx >= 0 && model.machineIdx.some((i) => i === 1);

  // Automater
  const bars = model.machines
    .slice()
    .sort((a, b) => b.totals.revenue - a.totals.revenue)
    .map((m) => ({
      label: m.machine.code,
      code: m.machine.code,
      name: storeById.get(m.machine.storeId)?.name ?? "",
      value: m.totals.revenue / 100,
      ...(m.machine.id === EMPTY_SLOT.machineId
        ? { flag: true, note: `Tomt fack ${EMPTY_SLOT.slot}` }
        : {}),
    }));
  const top = bars[0];
  const barMean = mean(bars.map((b) => b.value));

  // Värmekarta
  let hr = 0;
  let hc = 0;
  model.heat.forEach((row, r) =>
    row.forEach((v, c) => {
      if (v > (model.heat[hr]?.[hc] ?? 0)) {
        hr = r;
        hc = c;
      }
    }),
  );
  const heatMax = model.heat[hr]?.[hc] ?? 0;

  // Titlar
  const shares = model.titles.map((r) => ({
    label: r.title.name,
    value: r.revenue / 100,
    ...(r.title.costOre === null ? { flag: true, note: "Saknar pris" } : {}),
  }));
  const leader = model.titles[0];
  const unpriced = model.titles.find((r) => r.title.costOre === null);

  const profit = t.profit / 100;

  return (
    <SpecSection
      id="diagram"
      index={index}
      eyebrow="Diagram"
      title="Intäkt per dag."
      aside={sentence(
        `Snitt ${formatSek(avg)}, topp ${peakDate ? formatDate(peakDate, { year: "never" }) : "–"}`,
      )}
      space="loose"
      meta={[
        { label: "Period", value: `${formatInt(days)} d` },
        { label: "Diagram", value: "5 st" },
        { label: "Signal", value: "högst 1 per diagram" },
      ]}
    >
      <Sub
        index={`${n}.1`}
        label={`Intäkt per dag · ${formatInt(days)} d`}
        meta={chart.compare ? "streckad: föregående period" : undefined}
        title={
          peakDate
            ? `${weekday(peakDate)} ${formatDate(peakDate, { year: "never" })} gav ${formatSek(chart.values[peak] ?? 0)}${
                peak === releaseIdx ? ", släppdagen för Black Bolt" : ""
              }.`
            : undefined
        }
        className="lg:col-span-12"
      >
        <Panel grid marks className="pt-2 md:pt-3">
          <LineChart
            data={data}
            compare={chart.compare ?? undefined}
            format={formatSek}
            peakIndex={peak}
            reference={{ value: avg, label: "Snitt" }}
            annotations={[
              ...(releaseIdx >= 0 && weekBefore
                ? [
                    {
                      index: releaseIdx,
                      text: `Släpp: ${titleById.get("t6")?.name ?? ""}`,
                      sub: `${formatDelta((chart.values[releaseIdx] ?? 0) / weekBefore - 1)} mot veckan innan`,
                    },
                  ]
                : []),
              ...(todayIdx >= 0 && todayIdx !== peak
                ? [{ index: todayIdx, text: "I dag", sub: `t.o.m. ${formatTime(REF_NOW)}` }]
                : []),
            ]}
            alertIndex={showsEmpty ? emptyIdx : undefined}
            alertNote={
              showsEmpty ? `Tomt fack ${EMPTY_SLOT.slot} i ${emptyMachine?.code ?? ""}` : undefined
            }
            area={false}
            height={320}
            summary={`Intäkt per dag, ${formatInt(days)} dagar till och med ${formatDate(chart.range.end, { year: "auto", now: REF_NOW })}. Totalt ${formatSek(sum(chart.values))}, snitt ${formatSek(avg)} per dag.`}
            seriesName="Period"
            compareName={chart.compare ? `Föreg. ${formatInt(days)} d` : undefined}
          />
        </Panel>
      </Sub>

      <Sub
        index={`${n}.2`}
        label={`Intäkt till vinst · ${formatInt(model.days)} d`}
        meta="moms 0 · kortavgift 0"
        title={`Vinst ${formatSek(profit)}, ${t.margin === null ? "–" : formatPercent(t.margin)} av intäkten med inköpspris.`}
        className="lg:col-span-7"
      >
        <ProfitBridge
          revenue={t.pricedRevenue / 100}
          purchases={t.purchases / 100}
          fees={t.fees / 100}
          storeCompensation={t.storeCompensation / 100}
          unpricedRevenue={t.unpricedRevenue ? t.unpricedRevenue / 100 : undefined}
          format={formatSek}
          height={280}
        />
      </Sub>

      <Sub
        index={`${n}.3`}
        label={`Intäkt per automat · ${formatInt(model.days)} d`}
        meta={`${bars.length} st`}
        title={
          top && bars.length > 1
            ? `${top.code} ${top.name} ${formatSek(top.value)}, ${formatPercent(top.value / barMean - 1, 0)} över snittet.`
            : top
              ? `${top.code} ${top.name} ${formatSek(top.value)}.`
              : undefined
        }
        className="lg:col-span-5"
      >
        <BarChart
          data={bars}
          format={formatSek}
          labelHeading="Automat"
          valueHeading="Intäkt"
          summary={`Intäkt per automat: ${bars.map((b) => `${b.code} ${b.name} ${formatSek(b.value)}`).join(", ")}.`}
        />
      </Sub>

      <Sub
        index={`${n}.4`}
        label={`Köp per veckodag och timme · ${formatInt(model.days)} d`}
        meta={`öppet ${heatHours[0]}–20`}
        title={`${heatDays[hr]} ${hourRange(hc)} toppar med ${formatInt(heatMax)}${NBSP}köp.`}
        className="lg:col-span-7"
      >
        <Heatmap
          values={model.heat}
          rowLabels={heatDays}
          colLabels={heatHours}
          format={(v) => `${formatInt(v)}${NBSP}köp`}
          unit="köp"
          cellLabel={(r, c) => `${heatDays[r]} ${hourRange(c)}`}
          summary={`Antal köp per veckodag och timme, summerat över ${formatInt(model.days)} dagar. Flest ${heatDays[hr]} ${hourRange(hc)} med ${formatInt(heatMax)} köp.`}
        />
      </Sub>

      <Sub
        index={`${n}.5`}
        label={`Intäkt per titel · ${formatInt(model.days)} d`}
        meta={`${shares.length} titlar`}
        title={
          leader
            ? `${leader.title.name} står för ${formatPercent(leader.revenue / (t.revenue || 1), 0)}.`
            : undefined
        }
        className="lg:col-span-5"
      >
        <ShareBar
          segments={shares}
          format={formatSek}
          summary={`Intäkt per titel: ${shares.map((s) => `${s.label} ${formatSek(s.value)}`).join(", ")}.${unpriced ? ` ${unpriced.title.name} saknar inköpspris.` : ""}`}
        />
      </Sub>
    </SpecSection>
  );
}

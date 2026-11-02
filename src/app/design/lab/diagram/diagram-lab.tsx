"use client";

import type { ReactNode } from "react";
import { BarChart } from "@/components/charts/bar-chart";
import { Heatmap } from "@/components/charts/heatmap";
import { LineChart } from "@/components/charts/line-chart";
import { ProfitBridge } from "@/components/charts/profit-bridge";
import { ShareBar } from "@/components/charts/share-bar";
import { Sparkline } from "@/components/charts/sparkline";
import { WaterfallChart } from "@/components/charts/waterfall-chart";
import { formatDelta, formatInt, formatSek } from "@/lib/format";
import {
  franchiseShare,
  heatDays,
  heatHours,
  heatValues,
  machines,
  revenueSeries,
} from "../../sample-data";

function Block({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section id={id} className="border-t border-line py-8">
      <h2 className="label mb-6 text-subtle">{title}</h2>
      {children}
    </section>
  );
}

export function DiagramLab({ theme, gray }: { theme: "dark" | "light" | "print"; gray: boolean }) {
  const series = revenueSeries("30d");
  const best = series.data[series.best];
  const week = series.data[series.best - 7];
  const fleet = machines("30d");
  const bars = fleet
    .filter((m) => m.status !== "offline")
    .sort((a, b) => b.revenue - a.revenue)
    .map((m) => ({
      label: m.id.slice(3),
      value: m.revenue,
      name: `${m.id} ${m.site}`,
      ...(m.status === "critical"
        ? { flag: true, note: `Fyllnad ${Math.round(m.fill * 100)} % · under gräns` }
        : {}),
    }));
  const heat = heatValues();

  return (
    <div
      data-theme={theme}
      className="min-h-screen bg-bg text-fg"
      style={gray ? { filter: "grayscale(1)" } : undefined}
    >
      <div className="mx-auto max-w-[1120px] px-4 py-8 md:px-8">
        <Block id="linje" title="Linje · jämförelse, snitt, topp">
          <LineChart
            data={series.data}
            compare={series.compare}
            format={formatSek}
            reference={{
              value: series.data.reduce((s, d) => s + d.value, 0) / series.data.length,
              label: "Snitt",
            }}
            annotations={
              best && week
                ? [
                    {
                      index: series.best,
                      text: "Släpp: Pokémon SV8",
                      sub: `${formatDelta(best.value / week.value - 1)} mot veckan innan`,
                    },
                  ]
                : []
            }
            height={320}
            summary="Intäkt per dag de senaste 30 dagarna."
            compareName="Föreg. 30 d"
          />
        </Block>

        <Block id="linje-larm" title="Linje · larm (signal) och 14 dagar">
          <LineChart
            data={series.data.slice(-14)}
            format={formatSek}
            alertIndex={11}
            alertNote="Automat tom 6 tim"
            height={220}
            area={false}
            summary="Intäkt per dag, senaste 14 dagarna."
          />
        </Block>

        <div className="grid gap-x-12 lg:grid-cols-2">
          <Block id="stapel" title="Stapel · liggande">
            <BarChart data={bars} format={formatSek} summary="Intäkt per automat." />
          </Block>
          <Block id="vattenfall" title="Vattenfall">
            <WaterfallChart
              steps={[
                { label: "Brutto", value: 131_400, name: "Bruttoförsäljning" },
                { label: "Moms", value: -26_280, name: "Utgående moms 25 %" },
                { label: "Kortavg.", value: -2_890, name: "Kortavgifter" },
                { label: "Inköp", value: -58_200, name: "Inköp av pack" },
                { label: "Hyra", value: -9_800, name: "Platshyra" },
                {
                  label: "Svinn",
                  value: -3_150,
                  name: "Svinn och skador",
                  flag: true,
                  note: "Över mål",
                },
                { label: "Netto", value: 0, total: true, name: "Nettoresultat" },
              ]}
              format={formatSek}
              summary="Från brutto till netto."
            />
          </Block>
          <Block id="brygga" title="Lönsamhetsbrygga · fas 4">
            <ProfitBridge
              revenue={104_320}
              purchases={41_870}
              fees={2_610}
              storeCompensation={18_240}
              unpricedRevenue={6_480}
              format={formatSek}
            />
          </Block>
          <Block id="brygga-forlust" title="Lönsamhetsbrygga · förlust">
            <ProfitBridge
              revenue={30_400}
              purchases={18_500}
              fees={763}
              storeCompensation={12_640}
              format={formatSek}
            />
          </Block>
          <Block id="varmekarta" title="Värmekarta">
            <Heatmap
              values={heat}
              rowLabels={heatDays}
              colLabels={heatHours}
              format={(v) => `${formatInt(v)} köp`}
              unit="köp/tim"
              cellLabel={(r, c) =>
                `${heatDays[r]} ${heatHours[c]}–${String(Number(heatHours[c]) + 1).padStart(2, "0")}`
              }
              summary="Antal köp per veckodag och timme."
            />
          </Block>
          <Block id="andel" title="Andel · lista och kompakt">
            <ShareBar segments={franchiseShare} format={formatSek} summary="Andel per kortserie." />
            <div className="mt-8">
              <ShareBar
                segments={franchiseShare}
                format={formatSek}
                variant="bar"
                summary="Andel per kortserie."
              />
            </div>
            <div className="mt-8">
              <ShareBar
                segments={franchiseShare.map((f, i) =>
                  i === 2 ? { ...f, flag: true, note: "Slut i 4 automater" } : f,
                )}
                format={formatSek}
                variant="bar"
                summary="Andel per kortserie, en serie kräver åtgärd."
              />
            </div>
          </Block>
          <Block id="stapel-staende" title="Stapel · stående">
            <BarChart
              data={[...bars.slice(0, 6), ...bars.filter((b) => b.flag).slice(0, 1)]}
              format={formatSek}
              orientation="vertical"
              summary="Intäkt per automat."
            />
          </Block>
          <Block id="spark" title="Sparkline">
            <div className="grid grid-cols-2 gap-6">
              <Sparkline data={series.data.slice(-14).map((d) => d.value)} height={36} />
              <Sparkline data={series.data.slice(-14).map((d) => d.value)} height={36} alert />
            </div>
          </Block>
        </div>
      </div>
    </div>
  );
}

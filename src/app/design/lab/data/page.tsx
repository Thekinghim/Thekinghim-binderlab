"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Panel, PanelHeader, PanelSection } from "@/components/ui/frame";
import { KpiCard } from "@/components/ui/kpi-card";
import { KpiStrip, type KpiItem } from "@/components/ui/kpi-strip";
import { SectionHeader } from "@/components/ui/section-header";
import { StatusTag, type Status } from "@/components/ui/status-tag";
import { NBSP, formatDecimal, formatInt, formatSek } from "@/lib/format";
import { seeded } from "@/lib/random";

type P = "7d" | "30d";

function series(seed: number, n: number, base: number, drift: number, noise: number) {
  const r = seeded(seed);
  return Array.from({ length: n }, (_, i) => {
    const dow = (i + 3) % 7;
    const wk = dow === 5 ? 1.35 : dow === 6 ? 1.2 : 1;
    return Math.max(0, base * wk * (1 + drift * (i / n)) * (1 + (r() - 0.5) * noise));
  });
}
const sum = (a: ReadonlyArray<number>) => a.reduce((s, v) => s + v, 0);
const mean = (a: ReadonlyArray<number>) => sum(a) / a.length;

/** All text och alla serier härleds från perioden, så att labbet inte motsäger sig självt. */
function period(p: P) {
  const n = p === "30d" ? 30 : 7;
  const seed = p === "30d" ? 0 : 100;
  const rev = series(seed + 1, n, 3700, 0.18, 0.3);
  const revDelta = p === "30d" ? 0.096 : 0.041;
  const packs = series(seed + 2, n, 49, 0.05, 0.5);
  const packsDelta = p === "30d" ? 0.063 : -0.022;
  const margin = series(seed + 3, n, 35.8, -0.04, 0.03).map((v, i) => v - (i % 7 === 5 ? 1.2 : 0));
  const marginNow = Math.round(mean(margin) * 10) / 10;
  const marginDelta = p === "30d" ? -1.4 : 0.3;
  // Tomma fack per dag; sista dagen är nuläget.
  const empty =
    p === "30d"
      ? [1, 0, 2, 1, 1, 3, 2, 2, 1, 2, 1, 0, 1, 2, 2, 3, 2, 2, 4, 3, 3, 2, 3, 4, 3, 3, 4, 4, 3, 5]
      : [1, 2, 2, 1, 2, 2, 2];
  const emptyDelta = p === "30d" ? 2 : 0;
  const revenue = Math.round(sum(rev));
  const items: KpiItem[] = [
    {
      id: "rev",
      label: "Intäkt",
      value: revenue,
      format: formatSek,
      delta: { delta: revDelta },
      trend: rev,
      reference: mean(rev) / (1 + revDelta),
      primary: true,
    },
    {
      id: "packs",
      label: "Sålda pack",
      value: Math.round(sum(packs)),
      format: formatInt,
      delta: { delta: packsDelta },
      trend: packs,
      reference: mean(packs) / (1 + packsDelta),
    },
    {
      id: "margin",
      label: "Bruttomarginal",
      value: marginNow,
      format: (v) => `${formatDecimal(v)} %`,
      delta: { delta: marginDelta, kind: "absolute", unit: "p.e." },
      trend: margin,
      reference: marginNow - marginDelta,
    },
    {
      id: "empty",
      label: "Tomma fack",
      value: empty[empty.length - 1] ?? 0,
      format: (v) => `${formatInt(v)} st`,
      delta: { delta: emptyDelta, kind: "absolute", unit: "st", invert: true },
      trend: empty,
      reference: mean(empty) - emptyDelta / 2,
      alert: (empty[empty.length - 1] ?? 0) > 3,
      alertText: "Gräns 3 st",
    },
  ];
  return {
    items,
    revenue,
    title: `${formatSek(revenue)} på ${n} dagar.`,
    aside: `${formatDecimal(revDelta * 100)}${NBSP}% mer än jämförelseperioden.`,
    label: `Nyckeltal · ${n} dagar`,
    range: p === "30d" ? "3 okt. – 1 nov." : "26 okt. – 1 nov.",
    comparison: p === "30d" ? "Jämfört med 3 sep. – 2 okt." : "Jämfört med 19–25 okt.",
  };
}

const STATUSES: Status[] = [
  "ok",
  "ok",
  "warning",
  "ok",
  "critical",
  "warning",
  "ok",
  "ok",
  "ok",
  "offline",
  "neutral",
];

function Board({ theme }: { theme: "dark" | "light" }) {
  const [p, setP] = useState<P>("30d");
  const [loading, setLoading] = useState(false);
  const d = period(p);
  return (
    <div data-theme={theme} data-board={theme} className="flex flex-col gap-16 px-4 py-10 md:px-8">
      <SectionHeader
        index={5}
        eyebrow="Nyckeltal"
        title={d.title}
        aside={d.aside}
        meta={[
          { label: "Period", value: d.range },
          { label: "Automater", value: "14 st" },
          { label: "Uppdaterad", value: "1 nov. 14:32" },
        ]}
        actions={
          <>
            <Button size="sm" onClick={() => setP(p === "30d" ? "7d" : "30d")} data-act="period">
              Byt period
            </Button>
            <Button size="sm" onClick={() => setLoading(!loading)}>
              {loading ? "Visa värden" : "Visa laddning"}
            </Button>
          </>
        }
      />

      <KpiStrip label={d.label} comparison={d.comparison} items={d.items} loading={loading} />

      <div className="grid gap-8 lg:grid-cols-2" data-shot="strip-in-panel">
        <Panel>
          <KpiStrip items={d.items.slice(1)} />
        </Panel>
        <Panel>
          <PanelHeader label={d.label} meta={d.comparison} className="mb-4" />
          <KpiStrip items={d.items.slice(1)} />
        </Panel>
      </div>

      <div className="grid gap-8 lg:grid-cols-12">
        <div className="flex flex-col gap-6 lg:col-span-5">
          <SectionHeader
            size="md"
            eyebrow="Status"
            title="Fjorton automater."
            aside="En kritisk."
          />
          <div className="flex flex-col">
            {STATUSES.map((s, i) => (
              <div
                key={i}
                className="flex h-11 items-center justify-between border-b border-line text-sm"
              >
                <span>BL-{String(i + 1).padStart(3, "0")}</span>
                <StatusTag status={s}>
                  {s === "neutral"
                    ? "Synkad 14:32"
                    : s === "critical"
                      ? "Slut i fack 3"
                      : undefined}
                </StatusTag>
              </div>
            ))}
          </div>
        </div>

        <div className="flex flex-col gap-6 lg:col-span-7">
          <SectionHeader size="sm" title="Fristående nyckeltal" aside="och panelregler." />
          <div className="grid gap-3 sm:grid-cols-2">
            <KpiCard
              label="Intäkt idag"
              value={4380}
              format={formatSek}
              delta={0.042}
              trend={series(9, 7, 4100, 0.1, 0.3)}
              reference={4000}
            />
            <KpiCard
              label="Tomma fack"
              value={5}
              format={(v) => `${formatInt(v)} st`}
              delta={2}
              deltaKind="absolute"
              deltaUnit="st"
              deltaLabel=""
              invert
              alert
              alertText="Gräns 3 st"
              trend={[1, 0, 2, 1, 1, 3, 2, 2, 4, 3, 3, 5, 4, 6]}
              reference={2}
            />
          </div>
          <Panel>
            <PanelSection label="KpiCard i panel" meta="kanten släpps">
              <KpiCard label="Sålda pack" value={1627} format={formatInt} delta={0.063} />
            </PanelSection>
            <PanelSection label="Panel i PanelSection" meta="ingen egen linje">
              <Panel>
                <p className="text-sm text-muted">
                  PanelSection är avdelaren. Den inre panelen ritar varken ram eller linje.
                </p>
              </Panel>
            </PanelSection>
          </Panel>
          <Panel>
            <PanelHeader label="Panel i panel" meta="linje bara mellan innehåll" />
            <Panel>
              <p className="text-sm text-muted">Direkt efter rubriken: ingen linje.</p>
            </Panel>
            <Panel>
              <p className="text-sm text-muted">Efter innehåll: en 1px linje överst.</p>
            </Panel>
          </Panel>
          <Panel variant="bare" className="border-t border-line">
            <PanelHeader label="variant=bare" meta="ingen kant" />
          </Panel>
        </div>
      </div>
    </div>
  );
}

export default function Page() {
  return (
    <div className="mx-auto max-w-[1280px]">
      <Board theme="dark" />
      <Board theme="light" />
    </div>
  );
}

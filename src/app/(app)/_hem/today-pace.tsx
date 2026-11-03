"use client";

import { CountUp } from "@/components/ui/count-up";
import { cn } from "@/lib/cn";
import { MINUS, NBSP, formatInt, formatSek } from "@/lib/format";

import type { PaceTone, TodayPace } from "./pace";
import { kr } from "./text";

const WEEKDAYS = ["måndag", "tisdag", "onsdag", "torsdag", "fredag", "lördag", "söndag"] as const;

const TONE: Record<PaceTone, string> = {
  up: "border-up-line text-up",
  down: "border-signal-line text-signal-fg",
  neutral: "border-line-control text-muted",
};

/** "+12 %", "−4 %", "±0 %" (hela procent). */
function deltaText(bp: number): string {
  const pct = Math.round(Math.abs(bp) / 100);
  const sign = pct === 0 ? "±" : bp > 0 ? "+" : MINUS;
  return `${sign}${formatInt(pct)}${NBSP}%`;
}

/**
 * I dag hittills: dagens intäkt fram till senaste hämtningen från Awish (levande prick), ±% mot samma klockslag en vanlig
 * {veckodag} och en liten kurva (i dag mot en vanlig dag). Visas bara när modellen har ett
 * värde (perioden innehåller i dag och det finns minst tre jämförelsedagar).
 */
export function TodayPaceCard({ pace }: { pace: TodayPace }) {
  const weekday = WEEKDAYS[pace.weekday - 1] ?? "dag";
  return (
    <section
      aria-labelledby="i-dag-hittills"
      className="flex flex-col gap-4 rounded-sm border border-line bg-surface p-4 sm:flex-row sm:items-center sm:justify-between md:px-5"
    >
      <div className="flex min-w-0 flex-col gap-1.5">
        <h2 id="i-dag-hittills" className="label flex items-center gap-2 text-muted">
          {/* Levande prick: talet kommer direkt från Awish. */}
          <span aria-hidden className="live-dot inline-block size-1.5 rounded-full bg-up text-up" />
          {`I dag · kl. ${pace.clock}`}
        </h2>
        <p className="tnum flex flex-wrap items-center gap-x-3 gap-y-1">
          <CountUp
            id="i-dag-hittills"
            value={pace.soFarOre}
            format={(v) => formatSek(v / 100)}
            className="text-3xl font-medium text-fg md:text-4xl"
          />
          <span
            className={cn(
              "label inline-flex h-6 items-center rounded-xs border px-1.5 whitespace-nowrap",
              TONE[pace.tone],
            )}
          >
            {deltaText(pace.deltaBp)}
          </span>
          <span className="meta text-subtle">{`mot vanlig ${weekday}`}</span>
        </p>
        <p className="meta tnum text-subtle">
          {`Prognos ${kr(pace.projectionOre)} · vanlig dag ${kr(pace.baselineFullOre)}`}
        </p>
      </div>
      <PaceSpark pace={pace} weekday={weekday} />
    </section>
  );
}

const W = 240;
const H = 56;
const PAD = 3;

/** Kumulativ intäkt över dygnet: i dag (heldragen) mot en vanlig dag (dämpad), med "nu". */
function PaceSpark({ pace, weekday }: { pace: TodayPace; weekday: string }) {
  const [hh = "0", mm = "0"] = pace.clock.split(":");
  const nowHours = Number(hh) + Number(mm) / 60;
  const max = Math.max(1, pace.baselineHourly[23] ?? 0, ...pace.todayHourly);
  const x = (h: number) => PAD + (h / 24) * (W - 2 * PAD);
  const y = (v: number) => H - PAD - (v / max) * (H - 2 * PAD);

  // Värdet för timme i gäller vid timmens slut; i dag slutar kurvan vid klockslaget.
  const base = [`${x(0)},${y(0)}`, ...pace.baselineHourly.map((v, i) => `${x(i + 1)},${y(v)}`)];
  const today = [
    `${x(0)},${y(0)}`,
    ...pace.todayHourly.map((v, i) =>
      i === pace.todayHourly.length - 1 ? `${x(nowHours)},${y(v)}` : `${x(i + 1)},${y(v)}`,
    ),
  ];
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      className="block h-14 w-full shrink-0 sm:w-64"
      role="img"
      aria-label={`I dag ${kr(pace.soFarOre)} kl. ${pace.clock}, en vanlig ${weekday} ${kr(pace.baselineSoFarOre)} vid samma tid och ${kr(pace.baselineFullOre)} hela dagen.`}
    >
      <polyline
        points={base.join(" ")}
        fill="none"
        pathLength={1}
        className="draw"
        style={{ stroke: "var(--bl-data-3)", ["--len" as string]: 1 }}
        strokeWidth={1.25}
        vectorEffect="non-scaling-stroke"
      />
      <line
        x1={x(nowHours)}
        x2={x(nowHours)}
        y1={PAD}
        y2={H - PAD}
        style={{ stroke: "var(--bl-fg-faint)" }}
        strokeDasharray="2 2"
        vectorEffect="non-scaling-stroke"
      />
      <polyline
        points={today.join(" ")}
        fill="none"
        pathLength={1}
        className="draw"
        style={{ stroke: "var(--bl-data-1)", ["--len" as string]: 1 }}
        strokeWidth={1.75}
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

"use client";

import { Fragment, useState } from "react";
import { Segmented } from "@/components/ui/segmented";
import { cn } from "@/lib/cn";
import {
  EN_DASH,
  MINUS,
  NBSP,
  formatCsvNumber,
  formatDate,
  formatDateTime,
  formatDelta,
  formatDuration,
  formatKronor,
  formatMonth,
  formatPercent,
  formatPeriod,
  formatPeriodShort,
  formatRelative,
  formatSek,
  formatSekAxis,
  formatSignedKronor,
  formatTime,
} from "@/lib/format";
import { periodFromPreset } from "@/lib/period";
import { REF_NOW } from "../sample-data";
import { SpecSection } from "./section";

/** Samma referenstid som resten av /design: mån 2 nov. 2026 14:32 (senaste synk). */
const NOW = REF_NOW;
const d = (y: number, m: number, day: number, h = 0, min = 0) => new Date(y, m - 1, day, h, min);

type Row = { fn: string; input: string; output: string };
type Group = { id: string; title: string; rows: Row[] };

const groups: Group[] = [
  {
    id: "kronor",
    title: "Kronor",
    rows: [
      { fn: "formatKronor", input: "79987", output: formatKronor(79987) },
      {
        fn: "formatKronor",
        input: "79987, { decimals: 0 }",
        output: formatKronor(79987, { decimals: 0 }),
      },
      { fn: "formatKronor", input: "-1240.5", output: formatKronor(-1240.5) },
      { fn: "formatKronor", input: "1.005", output: formatKronor(1.005) },
      { fn: "formatSignedKronor", input: "1240", output: formatSignedKronor(1240) },
      { fn: "formatSignedKronor", input: "-1240", output: formatSignedKronor(-1240) },
      { fn: "formatSek", input: "12480.6", output: formatSek(12480.6) },
      { fn: "formatSekAxis", input: "1240000", output: formatSekAxis(1_240_000) },
      { fn: "formatCsvNumber", input: "-79987", output: formatCsvNumber(-79987) },
      { fn: "formatKronor", input: "NaN", output: formatKronor(NaN) },
    ],
  },
  {
    id: "procent",
    title: "Procent",
    rows: [
      { fn: "formatPercent", input: "0.331", output: formatPercent(0.331) },
      { fn: "formatPercent", input: "0.331, 0", output: formatPercent(0.331, 0) },
      {
        fn: "formatPercent",
        input: "0.33149, { digits: 2 }",
        output: formatPercent(0.33149, { digits: 2 }),
      },
      { fn: "formatDelta", input: "0.064, 1", output: formatDelta(0.064, 1) },
      { fn: "formatDelta", input: "-0.08", output: formatDelta(-0.08) },
      { fn: "formatDelta", input: "0", output: formatDelta(0) },
    ],
  },
  {
    id: "datum",
    title: "Datum och tid",
    rows: [
      {
        fn: "formatDateTime",
        input: "2026-11-01 17:17",
        output: formatDateTime(d(2026, 11, 1, 17, 17), { now: NOW }),
      },
      {
        fn: "formatDateTime",
        input: "2025-12-28 09:05",
        output: formatDateTime(d(2025, 12, 28, 9, 5), { now: NOW }),
      },
      { fn: "formatDate", input: "2026-11-01", output: formatDate(d(2026, 11, 1)) },
      {
        fn: "formatDate",
        input: "2026-11-01, { year: 'auto' }",
        output: formatDate(d(2026, 11, 1), { year: "auto", now: NOW }),
      },
      { fn: "formatTime", input: "2026-11-01 09:05", output: formatTime(d(2026, 11, 1, 9, 5)) },
      { fn: "formatMonth", input: "2026-11-15", output: formatMonth(d(2026, 11, 15)) },
      {
        fn: "formatRelative",
        input: "now − 240 000 ms",
        output: formatRelative(new Date(NOW.getTime() - 240_000), NOW),
      },
      {
        fn: "formatRelative",
        input: "2026-11-01 17:17",
        output: formatRelative(d(2026, 11, 1, 17, 17), NOW),
      },
      { fn: "formatDuration", input: "8040000", output: formatDuration(8_040_000) },
      { fn: "formatDuration", input: "273600000", output: formatDuration(273_600_000) },
    ],
  },
  {
    id: "perioder",
    title: "Perioder",
    rows: [
      {
        fn: "formatPeriod",
        input: "2026-11-01 … 11-01",
        output: formatPeriod({ start: d(2026, 11, 1), end: d(2026, 11, 1) }),
      },
      {
        fn: "formatPeriod",
        input: "2026-11-03 … 11-30",
        output: formatPeriod({ start: d(2026, 11, 3), end: d(2026, 11, 30) }),
      },
      {
        fn: "formatPeriod",
        input: "2026-11-01 … 11-30",
        output: formatPeriod({ start: d(2026, 11, 1), end: d(2026, 11, 30) }),
      },
      {
        fn: "formatPeriod",
        input: "2026-10-03 … 11-01",
        output: formatPeriod({ start: d(2026, 10, 3), end: d(2026, 11, 1) }),
      },
      {
        fn: "formatPeriod",
        input: "2025-12-28 … 2026-01-03",
        output: formatPeriod({ start: d(2025, 12, 28), end: d(2026, 1, 3) }),
      },
      {
        fn: "formatPeriod",
        input: "periodFromPreset('atd')",
        output: formatPeriod(periodFromPreset("atd", NOW)),
      },
      {
        fn: "formatPeriod",
        input: "2026-01-01 … 12-31",
        output: formatPeriod({ start: d(2026, 1, 1), end: d(2026, 12, 31) }),
      },
      {
        fn: "formatPeriodShort",
        input: "periodFromPreset('30d')",
        output: formatPeriodShort(periodFromPreset("30d", NOW), NOW),
      },
      {
        fn: "formatPeriodShort",
        input: "2025-11-01 … 11-30",
        output: formatPeriodShort({ start: d(2025, 11, 1), end: d(2025, 11, 30) }, NOW),
      },
    ],
  },
];

/** Skriver ut tecken och gör de typografiskt viktiga synliga i läget "Tecken". */
function Glyphs({ text, reveal }: { text: string; reveal: boolean }) {
  if (!reveal) return <>{text}</>;
  return (
    <>
      {Array.from(text).map((ch, i) => {
        if (ch === NBSP) {
          return (
            <span key={i} className="text-subtle" title="Hårt mellanslag, U+00A0">
              ·
            </span>
          );
        }
        if (ch === MINUS || ch === EN_DASH) {
          return (
            <span
              key={i}
              className="rounded-xs bg-hover text-fg"
              title={ch === MINUS ? "Minustecken, U+2212" : "Tankstreck, U+2013"}
            >
              {ch}
            </span>
          );
        }
        return <Fragment key={i}>{ch}</Fragment>;
      })}
    </>
  );
}

const rules: { code: string; name: string; rule: string; example: string }[] = [
  {
    code: "U+00A0",
    name: "Hårt mellanslag",
    rule: "Mellan tal och enhet och som tusentalsavgränsare. Beloppet bryts aldrig över två rader.",
    example: formatKronor(79987),
  },
  {
    code: "U+2212",
    name: "Minustecken",
    rule: "Lika brett som plustecknet, så att kolumner linjerar. Bindestreck bara i CSV.",
    example: formatSignedKronor(-1240),
  },
  {
    code: "U+2013",
    name: "Tankstreck",
    rule: "I intervall. Tätt mellan enkla led, hårda mellanslag kring sammansatta.",
    example: formatPeriodShort({ start: d(2026, 11, 3), end: d(2026, 11, 30) }, NOW),
  },
  {
    code: "NaN",
    name: "Saknat värde",
    rule: "NaN, oändligt och ogiltiga datum visas som ett tankstreck, aldrig som 0 eller NaN.",
    example: formatPercent(NaN),
  },
];

/** Antal exempel i tabellen (för innehållsindexet). */
export const FORMAT_EXAMPLE_COUNT = groups.reduce((n, g) => n + g.rows.length, 0);

type Mode = "utdata" | "tecken";

export function FormatSection({ index }: { index: number }) {
  const [mode, setMode] = useState<Mode>("utdata");
  const reveal = mode === "tecken";

  return (
    <SpecSection
      id="formatering"
      index={index}
      eyebrow="Formatering"
      title="Alla tal formateras på ett ställe."
      aside={`${FORMAT_EXAMPLE_COUNT} exempel, samma utdata i panel, rapport och e-post.`}
      space="tight"
      actions={
        <Segmented<Mode>
          label="Visning av utdata"
          size="sm"
          value={mode}
          onChange={setMode}
          options={[
            { value: "utdata", label: "Utdata" },
            { value: "tecken", label: "Tecken" },
          ]}
        />
      }
    >
      <dl className="grid grid-cols-1 border-t border-line sm:grid-cols-2 lg:col-span-12 lg:grid-cols-4">
        {rules.map((r, i) => (
          <div
            key={r.code}
            className={cn(
              "flex flex-col gap-3 border-b border-line py-5 sm:px-5",
              i % 2 === 1 && "sm:border-l",
              i > 0 && "lg:border-l",
              i % 2 === 0 && "sm:pl-0",
              i > 0 && "lg:pl-5",
            )}
          >
            <dt className="flex items-baseline justify-between gap-3">
              <span className="text-sm text-fg">{r.name}</span>
              <span className="label text-subtle">{r.code}</span>
            </dt>
            <dd className="tnum text-lg whitespace-nowrap text-fg">
              <Glyphs text={r.example} reveal={r.code !== "NaN"} />
            </dd>
            <dd className="text-sm text-muted">{r.rule}</dd>
          </div>
        ))}
      </dl>

      <div className="lg:col-span-12">
        <p className="label text-subtle">
          Referenstid <span className="tnum text-muted normal-case">now = 2026-11-02 14:32</span>
          <span className="text-faint"> · </span>
          Europe/Stockholm
        </p>
        <table className="mt-4 w-full border-collapse text-sm">
          <caption className="sr-only">
            Formateringsfunktioner med exempel på indata och utdata, grupperade per kategori
          </caption>
          <thead>
            <tr className="border-b border-line-strong">
              <th scope="col" className="label py-2 pr-4 text-left font-normal text-subtle">
                Funktion
              </th>
              <th
                scope="col"
                className="label hidden py-2 pr-4 text-left font-normal text-subtle sm:table-cell"
              >
                Indata
              </th>
              <th scope="col" className="label py-2 text-right font-normal text-subtle">
                Utdata
              </th>
            </tr>
          </thead>
          {groups.map((g) => (
            <tbody key={g.id}>
              <tr>
                <th
                  scope="colgroup"
                  colSpan={3}
                  className="label pt-8 pb-2 text-left font-normal text-fg"
                >
                  {g.title}
                  <span className="ml-2 text-faint">{String(g.rows.length).padStart(2, "0")}</span>
                </th>
              </tr>
              {g.rows.map((r, i) => (
                <tr key={i} className="border-t border-line">
                  <td className="py-2.5 pr-4 align-baseline">
                    <code className="meta text-fg">{r.fn}</code>
                    <code className="mt-0.5 block font-mono text-xs text-subtle sm:hidden">
                      {r.input}
                    </code>
                  </td>
                  <td className="hidden py-2.5 pr-4 align-baseline sm:table-cell">
                    <code className="meta text-subtle">{r.input}</code>
                  </td>
                  <td className="tnum py-2.5 text-right align-baseline whitespace-nowrap text-fg">
                    <Glyphs text={r.output} reveal={reveal} />
                  </td>
                </tr>
              ))}
            </tbody>
          ))}
        </table>
      </div>
    </SpecSection>
  );
}

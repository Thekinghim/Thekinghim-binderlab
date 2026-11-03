import type { Metadata } from "next";
import Link from "next/link";
import type React from "react";

import {
  buildShrinkage,
  shrinkageValueText,
  SHRINKAGE_MIN_PACKS,
  type ShrinkageLine,
  type ShrinkageMachine,
} from "@/analytics/shrinkage";
import { periodText } from "@/analytics/todos/text";
import type { SearchParamsInput } from "@/components/shell/period-state";
import { SectionHeader } from "@/components/ui/section-header";
import { StateMessage } from "@/components/ui/state-message";
import { StatusTag } from "@/components/ui/status-tag";
import { cn } from "@/lib/cn";
import { EN_DASH, formatInt, MINUS, NBSP } from "@/lib/format";
import { loadMasterData, loadPeriod, requireRoute, requireViewer } from "@/server/data/core";
import { loadShrinkageFor } from "@/server/data/shrinkage";

import { machineHref } from "../_lib/model";

export const metadata: Metadata = { title: "Svinn" };

/**
 * Svinnkontroll: påfyllt (vårt lager → automat) mot sålt (Awish) mot automatens saldo
 * (Awish) per automat och titel i perioden (@/analytics/shrinkage). Automater där pack
 * saknas över tröskeln står först; resten under "Stämmer". Ägare, admin och läsare.
 */
export default async function SvinnPage({
  searchParams,
}: {
  searchParams: Promise<SearchParamsInput>;
}) {
  await requireRoute("automater");
  const sp = await searchParams;
  const [p, master, viewer] = await Promise.all([
    loadPeriod(sp),
    loadMasterData(),
    requireViewer(),
  ]);
  const aggregates = await loadShrinkageFor(viewer, p.period);
  const scoped = p.scope.machineId
    ? aggregates.filter((a) => a.machineId === p.scope.machineId)
    : p.scope.storeId
      ? aggregates.filter(
          (a) => master.machines.find((m) => m.id === a.machineId)?.storeId === p.scope.storeId,
        )
      : aggregates;
  const report = buildShrinkage(scoped, master);
  const value = shrinkageValueText(report.valueOre);

  return (
    <div className="mx-auto flex w-full max-w-[1280px] flex-col gap-12 px-4 pt-8 pb-16 md:gap-16 md:px-8 md:pt-12">
      <div className="rise">
        <SectionHeader
          as="h1"
          size="xl"
          eyebrow="Automater / Svinn"
          title={report.headline.title}
          aside={report.headline.aside}
          meta={[
            { label: "Period", value: periodText(p.period) },
            { label: "Saknas", value: value ?? formatInt(report.missing) },
          ]}
        />
      </div>

      {report.flagged.length === 0 && report.ok.length === 0 ? (
        <StateMessage kind="empty" message="Ingen påfyllning eller försäljning i perioden." />
      ) : null}

      {report.flagged.length > 0 ? (
        <section
          aria-labelledby="svinn-saknas"
          className="rise flex flex-col gap-6"
          style={{ "--i": 1 } as React.CSSProperties}
        >
          <h2 id="svinn-saknas" className="sr-only">
            Pack saknas
          </h2>
          {report.flagged.map((m, i) => (
            <MachineCard key={m.machineId} machine={m} index={i} flagged />
          ))}
        </section>
      ) : null}

      {report.ok.length > 0 ? (
        <section
          aria-labelledby="svinn-stammer"
          className="rise flex flex-col gap-4"
          style={{ "--i": 2 } as React.CSSProperties}
        >
          <details className="group" open={report.flagged.length === 0}>
            <summary
              id="svinn-stammer"
              className="label inline-flex cursor-pointer list-none items-center gap-2 text-subtle hover:text-fg [&::-webkit-details-marker]:hidden"
            >
              <span aria-hidden className="transition-transform group-open:rotate-90">
                ›
              </span>
              {report.ok.some(compared) ? "Stämmer" : "Ej jämfört"} ({formatInt(report.ok.length)})
            </summary>
            <div className="mt-6 flex flex-col gap-6">
              {report.ok.map((m, i) => (
                <MachineCard key={m.machineId} machine={m} index={i} flagged={false} />
              ))}
            </div>
          </details>
        </section>
      ) : null}

      <p className="meta max-w-2xl text-subtle">
        Väntat = förra räkningen + påfyllt {MINUS} sålt. Minst {formatInt(SHRINKAGE_MIN_PACKS)}
        {NBSP}pack som saknas flaggas.
      </p>
    </div>
  );
}

function MachineCard({
  machine,
  index,
  flagged,
}: {
  machine: ShrinkageMachine;
  index: number;
  flagged: boolean;
}) {
  const value = shrinkageValueText(machine.valueOre);
  const lines = flagged ? machine.lines.filter((l) => l.state !== "unknown") : machine.lines;
  return (
    <article
      className={cn(
        "rise rounded-md border bg-surface",
        flagged ? "border-signal-line" : "border-line",
      )}
      style={{ "--i": index } as React.CSSProperties}
    >
      <header className="flex flex-wrap items-baseline justify-between gap-3 border-b border-line px-4 py-3">
        <Link
          href={machineHref(machine.code)}
          className="min-w-0 text-md font-medium text-fg underline-offset-4 hover:underline"
        >
          {machine.code}
          {NBSP}
          <span className="font-normal text-muted">
            {machine.name}
            {machine.storeName ? ` · ${machine.storeName}` : ""}
          </span>
        </Link>
        {flagged ? (
          <span className="flex items-center gap-3">
            <StatusTag status="critical">
              {formatInt(machine.missing)}
              {NBSP}pack saknas
            </StatusTag>
            {value ? <span className="tnum text-base text-fg">{value}</span> : null}
          </span>
        ) : compared(machine) ? (
          <StatusTag status="ok">Stämmer</StatusTag>
        ) : (
          // Inget saldo från Awish att jämföra med: påstå inte att det stämmer.
          <StatusTag status="neutral">Ej jämfört</StatusTag>
        )}
      </header>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[28rem] text-sm">
          <thead>
            <tr className="label text-left text-subtle">
              <th scope="col" className="px-4 py-2 font-normal">
                Titel
              </th>
              <th scope="col" className="px-2 py-2 text-right font-normal">
                Påfyllt
              </th>
              <th scope="col" className="px-2 py-2 text-right font-normal">
                Sålt
              </th>
              <th scope="col" className="px-2 py-2 text-right font-normal">
                I automaten
              </th>
              <th scope="col" className="px-4 py-2 text-right font-normal">
                Saknas
              </th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => (
              <LineRow key={l.titleId} line={l} />
            ))}
          </tbody>
        </table>
      </div>
    </article>
  );
}

/** Minst en rad har ett saldo att jämföra med. */
function compared(m: ShrinkageMachine): boolean {
  return m.lines.some((l) => l.state !== "unknown");
}

function missingText(l: ShrinkageLine): string {
  if (l.missing === null) return EN_DASH;
  if (l.missing === 0) return "0";
  if (l.missing < 0) return `+${formatInt(-l.missing)}`;
  return formatInt(l.missing);
}

function LineRow({ line }: { line: ShrinkageLine }) {
  return (
    <tr className="border-t border-line">
      <th scope="row" className="px-4 py-2 text-left font-normal text-fg">
        {line.titleName}
      </th>
      <td className="tnum px-2 py-2 text-right text-muted">{formatInt(line.refilled)}</td>
      <td className="tnum px-2 py-2 text-right text-muted">{formatInt(line.sold)}</td>
      <td className="tnum px-2 py-2 text-right text-muted">
        {line.closing === null ? EN_DASH : formatInt(line.closing)}
      </td>
      <td
        className={cn(
          "tnum px-4 py-2 text-right",
          line.flagged ? "font-medium text-fg" : "text-muted",
        )}
        title={
          line.state === "extra"
            ? "Fler pack än väntat (påfyllning som inte registrerats)."
            : line.state === "unknown"
              ? "Inget saldo att jämföra med i perioden."
              : undefined
        }
      >
        {line.flagged ? <span className="text-signal-fg">{missingText(line)}</span> : null}
        {line.flagged ? null : missingText(line)}
      </td>
    </tr>
  );
}

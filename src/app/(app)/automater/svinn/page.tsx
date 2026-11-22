import type { Metadata } from "next";
import Link from "next/link";
import type React from "react";

import {
  buildShrinkage,
  NO_REFILL_TEXT,
  shrinkageValueText,
  SHRINKAGE_MIN_PACKS,
  type ShrinkageLine,
  type ShrinkageMachine,
} from "@/analytics/shrinkage";
import { periodText } from "@/analytics/todos/text";
import type { SearchParamsInput } from "@/components/shell/period-state";
import { Badge } from "@/components/v2/badge";
import { Card } from "@/components/v2/card";
import { Empty } from "@/components/v2/empty";
import { PAGE_BODY, PageIntro } from "@/components/v2/page-intro";
import { V2Page, headerDate } from "@/components/v2/shell/page";
import { SubNav } from "@/components/v2/sub-nav";
import { cn } from "@/lib/cn";
import { EN_DASH, formatInt, MINUS, NBSP } from "@/lib/format";
import {
  loadMasterData,
  loadPeriod,
  requireViewer,
  storeInScope,
  storeScoped,
} from "@/server/data/core";
import { requireAutomaterEconomy } from "../_lib/data";
import { loadShrinkageFor } from "@/server/data/shrinkage";

import { machineHref } from "../_lib/model";
import { SwapButton } from "./swap-button";

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
  const ctx = await requireAutomaterEconomy();
  const sp = await searchParams;
  const [p, master, viewer] = await Promise.all([
    loadPeriod(sp),
    loadMasterData(),
    requireViewer(),
  ]);
  const aggregates = await loadShrinkageFor(viewer, p.period);
  const scoped = p.scope.machineId
    ? aggregates.filter((a) => a.machineId === p.scope.machineId)
    : storeScoped(p.scope)
      ? aggregates.filter((a) =>
          storeInScope(p.scope, master.machines.find((m) => m.id === a.machineId)?.storeId),
        )
      : aggregates;
  const report = buildShrinkage(scoped, master);
  const value = shrinkageValueText(report.valueOre);

  return (
    <V2Page title="Svinn" date={headerDate(new Date(ctx.now), ctx.timeZone)} period filters>
      <SubNav />
      <div className={PAGE_BODY}>
        <PageIntro
          title={report.headline.title}
          aside={report.headline.aside}
          facts={[
            { label: "Period", value: periodText(p.period) },
            { label: "Saknas", value: value ?? formatInt(report.missing) },
          ]}
        />

        {report.flagged.length === 0 && report.ok.length === 0 ? (
          <Card>
            <Empty title="Ingen påfyllning eller försäljning i perioden." />
          </Card>
        ) : null}

        {report.flagged.length > 0 ? (
          <section aria-labelledby="svinn-saknas" className="v2-stack">
            <h2 id="svinn-saknas" className="sr-only">
              Pack saknas
            </h2>
            {report.flagged.map((m) => (
              <MachineCard key={m.machineId} machine={m} flagged canEdit={ctx.canEdit} />
            ))}
          </section>
        ) : null}

        {report.ok.length > 0 ? (
          // En nivå kort: en rad per automat som fälls ut till sin tabell. Ingen saknar pack,
          // så raderna är hopfällda från början.
          <Card
            title={report.ok.some(compared) ? "Stämmer" : "Ej jämfört"}
            count={report.ok.length}
            id="svinn-stammer"
          >
            <ul className="flex flex-col divide-y divide-v2-line2">
              {report.ok.map((m) => (
                <li key={m.machineId}>
                  <MachineRow machine={m} />
                </li>
              ))}
            </ul>
          </Card>
        ) : null}

        <p className="max-w-2xl text-v2-sm text-v2-mute">
          Väntat = förra räkningen + påfyllt {MINUS} sålt. Minst {formatInt(SHRINKAGE_MIN_PACKS)}
          {NBSP}pack som saknas flaggas.
        </p>
      </div>
    </V2Page>
  );
}

/** En automat utan saknade pack: rubrikrad (namn, märke, Saknas 0) som fälls ut till tabellen. */
function MachineRow({ machine }: { machine: ShrinkageMachine }) {
  return (
    <details className="group">
      <summary className="flex min-h-12 cursor-pointer list-none flex-wrap items-center justify-between gap-x-3 gap-y-1 px-[18px] py-2.5 transition-colors duration-150 hover:bg-v2-hover [&::-webkit-details-marker]:hidden">
        <span className="flex min-w-0 items-center gap-2">
          <span
            aria-hidden
            className="text-v2-mute transition-transform duration-150 group-open:rotate-90 motion-reduce:transition-none"
          >
            ›
          </span>
          <span className="min-w-0 text-v2-md font-[550] text-v2-ink">
            {machine.code}
            {NBSP}
            <span className="font-normal text-v2-mute">
              {machine.name}
              {machine.storeName ? ` · ${machine.storeName}` : ""}
            </span>
          </span>
        </span>
        <span className="flex items-center gap-3">
          <span className="tnum text-v2-sm text-v2-mute">
            Saknas {compared(machine) ? formatInt(Math.max(0, machine.missing)) : EN_DASH}
          </span>
          {compared(machine) ? <Badge tone="success">Stämmer</Badge> : <Badge>Ej jämfört</Badge>}
        </span>
      </summary>
      <div className="border-t border-v2-line2">
        <div className="flex justify-end px-[18px] pt-2">
          <Link
            href={machineHref(machine.code)}
            className="text-v2-sm text-v2-mute underline-offset-4 hover:text-v2-ink hover:underline"
          >
            Till automaten <span aria-hidden="true">→</span>
          </Link>
        </div>
        <MachineBody machine={machine} lines={machine.lines} canEdit={false} />
      </div>
    </details>
  );
}

function MachineCard({
  machine,
  flagged,
  canEdit = false,
}: {
  machine: ShrinkageMachine;
  flagged: boolean;
  /** Ägare och admin: "Det var ett produktbyte" på rader där pack saknas. */
  canEdit?: boolean;
}) {
  const value = shrinkageValueText(machine.valueOre);
  const lines = flagged ? machine.lines.filter((l) => l.state !== "unknown") : machine.lines;
  return (
    <article className={cn("v2-card", flagged && "shadow-[0_0_0_1px_var(--v2-crit-line)]")}>
      <header className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b border-v2-line px-[18px] py-3">
        <Link
          href={machineHref(machine.code)}
          className="min-w-0 text-v2-md font-[550] text-v2-ink underline-offset-4 hover:underline"
        >
          {machine.code}
          {NBSP}
          <span className="font-normal text-v2-mute">
            {machine.name}
            {machine.storeName ? ` · ${machine.storeName}` : ""}
          </span>
        </Link>
        {flagged ? (
          <span className="flex items-center gap-3">
            <Badge tone="critical">
              {formatInt(machine.missing)}
              {NBSP}pack saknas
            </Badge>
            {value ? <span className="tnum text-v2-md font-[550] text-v2-ink">{value}</span> : null}
          </span>
        ) : compared(machine) ? (
          <Badge tone="success">Stämmer</Badge>
        ) : (
          // Inget saldo från Awish att jämföra med: påstå inte att det stämmer.
          <Badge>Ej jämfört</Badge>
        )}
      </header>
      <MachineBody machine={machine} lines={lines} canEdit={canEdit} />
    </article>
  );
}

/** Raden om saknade påfyllningar och tabellen per titel. */
function MachineBody({
  machine,
  lines,
  canEdit,
}: {
  machine: ShrinkageMachine;
  lines: readonly ShrinkageLine[];
  canEdit: boolean;
}) {
  return (
    <>
      {machine.refilled === 0 ? (
        // Inga registrerade påfyllningar: "Påfyllt 0" bredvid allt som sålts ser ut som svinn.
        <p className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-v2-line px-[18px] py-3 text-v2-sm text-v2-mute">
          <span>{NO_REFILL_TEXT}</span>
          <Link
            href={`/fyll-pa/${encodeURIComponent(machine.machineId)}`}
            className="font-[550] text-v2-ink underline underline-offset-4"
          >
            Registrera i Fyll på
          </Link>
        </p>
      ) : null}
      <div className="v2-table-wrap">
        <table className="v2-table min-w-[28rem]">
          <thead>
            <tr>
              <th scope="col">Titel</th>
              <th scope="col" className="num">
                Påfyllt
              </th>
              <th scope="col" className="num">
                Sålt
              </th>
              <th scope="col" className="num">
                I automaten
              </th>
              <th scope="col" className="num">
                Saknas
              </th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => (
              <LineRow
                key={l.titleId}
                line={l}
                noRefills={machine.refilled === 0}
                swap={
                  canEdit && l.flagged && l.missing !== null && l.missing > 0 ? (
                    <SwapButton
                      machineId={machine.machineId}
                      titleId={l.titleId}
                      titleName={l.titleName}
                      missing={l.missing}
                    />
                  ) : null
                }
              />
            ))}
          </tbody>
        </table>
      </div>
    </>
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

function LineRow({
  line,
  noRefills,
  swap = null,
}: {
  line: ShrinkageLine;
  noRefills: boolean;
  /** V2: "Det var ett produktbyte" (ägare och admin). */
  swap?: React.ReactNode;
}) {
  return (
    <tr>
      <th
        scope="row"
        className="h-auto border-v2-line2 bg-transparent py-2.5 text-left text-v2-sm font-normal whitespace-normal text-v2-ink"
      >
        {line.titleName}
        {swap ? <span className="ml-3">{swap}</span> : null}
      </th>
      <td className="num text-v2-mute">{noRefills ? EN_DASH : formatInt(line.refilled)}</td>
      <td className="num text-v2-mute">{formatInt(line.sold)}</td>
      <td className="num text-v2-mute">
        {line.closing === null ? EN_DASH : formatInt(line.closing)}
      </td>
      <td
        className={cn("num", line.flagged ? "font-[550] text-v2-crit-text" : "text-v2-mute")}
        title={
          line.state === "extra"
            ? "Fler pack än väntat (påfyllning som inte registrerats)."
            : line.state === "unknown"
              ? "Inget saldo att jämföra med i perioden."
              : undefined
        }
      >
        {missingText(line)}
      </td>
    </tr>
  );
}

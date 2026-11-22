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
        <section aria-labelledby="svinn-stammer">
          <details className="group v2-card" open={report.flagged.length === 0}>
            <summary
              id="svinn-stammer"
              className="flex min-h-11 cursor-pointer list-none items-center gap-2 px-[18px] py-3 text-v2-md font-[550] text-v2-ink [&::-webkit-details-marker]:hidden"
            >
              <span
                aria-hidden
                className="text-v2-mute transition-transform duration-150 group-open:rotate-90 motion-reduce:transition-none"
              >
                ›
              </span>
              {report.ok.some(compared) ? "Stämmer" : "Ej jämfört"}
              <span className="tnum font-normal text-v2-mute">· {formatInt(report.ok.length)}</span>
            </summary>
            <div className="v2-stack border-t border-v2-line p-3 md:p-[14px]">
              {report.ok.map((m) => (
                <MachineCard key={m.machineId} machine={m} flagged={false} canEdit={ctx.canEdit} />
              ))}
            </div>
          </details>
        </section>
      ) : null}

      <p className="max-w-2xl text-v2-sm text-v2-mute">
        Väntat = förra räkningen + påfyllt {MINUS} sålt. Minst {formatInt(SHRINKAGE_MIN_PACKS)}
        {NBSP}pack som saknas flaggas.
      </p>
    </div>
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

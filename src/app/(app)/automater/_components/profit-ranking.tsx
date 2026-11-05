import Link from "next/link";
import type React from "react";

import type { SearchParamsInput } from "@/components/shell/period-state";
import { SectionHeader } from "@/components/ui/section-header";
import { StatusTag } from "@/components/ui/status-tag";
import { cn } from "@/lib/cn";
import { formatInt, NBSP } from "@/lib/format";

import { loadUnitEconomicsPage } from "../../expansion/_lib/data";
import { machineHref } from "../_lib/model";
import { perDayText, rankingView } from "../_lib/ranking";

/**
 * Automaterna rangordnade efter vinst per dag (samma tal som Enhetsekonomi), med "Flytta?"
 * på dem som tjänar minst. Strömmas in under listan (egen Suspense på sidan).
 */
export async function ProfitRanking({
  searchParams,
  query,
}: {
  searchParams: SearchParamsInput;
  query: string;
}) {
  const data = await loadUnitEconomicsPage(searchParams);
  const view = rankingView({
    comparison: data.comparison,
    machines: data.names.machines
      .filter((m) => !m.archived)
      .map((m) => ({ id: m.id, code: m.code ?? "", name: m.name })),
    hrefOf: (code) => machineHref(code, query),
  });
  if (view.rows.length < 2) return null;
  return (
    <section
      aria-labelledby="vinst-per-dag"
      className="rise flex flex-col gap-6"
      style={{ "--i": 3 } as React.CSSProperties}
    >
      <SectionHeader
        id="vinst-per-dag"
        eyebrow="Rangordning"
        title={view.title}
        aside={view.aside}
        actions={
          <Link
            href={`/automater/enhetsekonomi${query}`}
            className="meta inline-flex min-h-7 items-center gap-1.5 rounded-xs text-muted underline-offset-4 transition-colors hover:text-fg hover:underline max-md:min-h-11"
          >
            <span>Enhetsekonomi</span>
            <span aria-hidden className="text-subtle">
              →
            </span>
          </Link>
        }
      />
      <ol className="flex flex-col">
        {view.rows.map((r, i) => (
          <li key={r.machineId} className="border-t border-line first:border-t-0">
            <Link
              href={r.href}
              className="grid grid-cols-[2rem_minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2 py-3 transition-colors hover:bg-hover md:grid-cols-[2rem_minmax(0,14rem)_minmax(0,1fr)_auto]"
            >
              <span className="tnum label text-subtle">{formatInt(r.rank)}</span>
              <span className="flex min-w-0 flex-col">
                <span className="truncate text-base text-fg">
                  {r.code}
                  {NBSP}
                  <span className="text-muted">{r.name}</span>
                </span>
                <span className="meta text-subtle">
                  {formatInt(r.activeDays)}
                  {NBSP}dagar{r.vsAverage ? ` · ${r.vsAverage}` : ""}
                </span>
              </span>
              <span
                aria-hidden
                className="col-span-3 h-2 overflow-hidden rounded-xs bg-line md:col-span-1"
              >
                <span
                  className={cn(
                    "grow-x block h-full rounded-xs",
                    r.move ? "bg-signal" : "bg-fg/70",
                  )}
                  style={{ width: `${Math.round(r.bar * 100)}%`, "--i": i } as React.CSSProperties}
                />
              </span>
              <span className="col-start-3 row-start-1 flex items-center justify-end gap-3 md:col-start-4">
                {r.move ? <StatusTag status="warning">Flytta?</StatusTag> : null}
                <span className="tnum text-base text-fg">{perDayText(r.profitPerDayOre)}</span>
              </span>
            </Link>
          </li>
        ))}
      </ol>
    </section>
  );
}

import Link from "next/link";
import type React from "react";

import type { SearchParamsInput } from "@/components/shell/period-state";
import { SectionHeader } from "@/components/ui/section-header";
import { StatusTag } from "@/components/ui/status-tag";
import { cn } from "@/lib/cn";
import { formatInt, NBSP } from "@/lib/format";

import { machineHref } from "../_lib/model";
import { rankingView } from "../_lib/ranking";
import { loadFleetRanking } from "../_lib/ranking-data";

/**
 * Automat-ranking: automaterna rangordnade efter vinst per dag (samma tal som
 * Enhetsekonomi), med försäljning per dag, slutsålt och ett omdöme per automat ("Bäst",
 * "Tjänar bra", "Tjänar dåligt: överväg att flytta"). Med en enda automat jämförs den med sin
 * egen förra period. Strömmas in under listan (egen Suspense på sidan).
 */
export async function ProfitRanking({
  searchParams,
  query,
  down,
}: {
  searchParams: SearchParamsInput;
  query: string;
  /** Automater som är ur drift just nu (id → etikett): raden visar det i stället för omdömet. */
  down?: ReadonlyMap<string, string>;
}) {
  // Ett fel i rankingen ska aldrig stoppa listan ovanför.
  const data = await loadFleetRanking(searchParams).catch((error: unknown) => {
    console.error("[automater] Automat-rankingen kunde inte läsas:", error);
    return null;
  });
  if (!data) return null;
  const view = rankingView({
    ranking: data.ranking,
    machines: data.machines,
    hrefOf: (code) => machineHref(code, query),
    storeShareDeducted: data.storeShareDeducted,
    down,
  });
  if (view.rows.length === 0) return null;
  return (
    <section
      aria-labelledby="rangordning"
      data-ranking={view.mode}
      className="rise flex flex-col gap-6"
      style={{ "--i": 3 } as React.CSSProperties}
    >
      <SectionHeader
        id="rangordning"
        eyebrow={`Rangordning · vinst per dag · ${formatInt(data.days)}${NBSP}d`}
        title={view.title}
        aside={view.aside}
        actions={
          <Link
            href={`/automater/enhetsekonomi${query}`}
            className="meta inline-flex min-h-7 items-center gap-1.5 rounded-xs text-muted underline-offset-4 transition-colors hover:text-fg hover:underline max-md:tap max-md:min-h-11"
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
              data-verdict={r.verdict}
              className="flex min-h-11 flex-col gap-2 py-3 transition-colors hover:bg-hover"
            >
              <span className="flex items-baseline justify-between gap-3">
                <span className="flex min-w-0 items-baseline gap-3">
                  <span className="tnum label w-4 shrink-0 text-subtle">{formatInt(r.rank)}</span>
                  <span className="truncate text-base text-fg">
                    {r.code}
                    {NBSP}
                    <span className="text-muted">{r.name}</span>
                  </span>
                </span>
                <span className="tnum shrink-0 text-base font-medium text-fg">{r.profit}</span>
              </span>
              <span aria-hidden className="ml-7 block h-2 overflow-hidden rounded-xs bg-line">
                <span
                  className={cn(
                    "grow-x block h-full rounded-xs",
                    r.warn ? "bg-signal" : "bg-fg/70",
                  )}
                  style={{ width: `${Math.round(r.bar * 100)}%`, "--i": i } as React.CSSProperties}
                />
              </span>
              <span className="ml-7 flex flex-col gap-1">
                <StatusTag status={r.warn ? "warning" : "neutral"} wrap>
                  {r.verdictText}
                </StatusTag>
                <span className="meta text-muted">{r.sales}</span>
                {r.lost ? <span className="meta text-muted">{r.lost}</span> : null}
                <span className="meta text-subtle">{r.basis}</span>
              </span>
            </Link>
          </li>
        ))}
      </ol>
      <p className="meta text-subtle">{view.note}</p>
    </section>
  );
}

import type React from "react";

import type { SearchParamsInput } from "@/components/shell/period-state";
import { SectionHeader } from "@/components/ui/section-header";
import { StatusTag } from "@/components/ui/status-tag";
import { cn } from "@/lib/cn";
import { formatInt, NBSP } from "@/lib/format";

import { assortmentView } from "../_lib/assortment-view";
import { loadBestAssortment } from "../_lib/ranking-data";

/**
 * Bästa sortiment för automaten: förslagen först ("Byt ut … Prova …"), sedan varje titel
 * med pack och vinst per dag i lager. Bara verklig försäljning; för lite data sägs rakt ut.
 * Strömmas in (egen Suspense på sidan). Ett fel här stoppar inte sidan.
 */
export async function BestAssortment({
  machineId,
  code,
  searchParams,
}: {
  machineId: string;
  code: string;
  searchParams: SearchParamsInput;
}) {
  const data = await loadBestAssortment(machineId, searchParams).catch((error: unknown) => {
    console.error("[automater] Bästa sortiment kunde inte läsas:", error);
    return null;
  });
  if (!data) return null;
  const view = assortmentView({
    assortment: data.assortment,
    code,
    storeShareDeducted: data.storeShareDeducted,
  });
  return (
    <section
      aria-labelledby="basta-sortiment"
      data-assortment
      className="fade-in flex flex-col gap-6 border-t border-line pt-8"
    >
      <SectionHeader
        id="basta-sortiment"
        eyebrow={`Bästa sortiment · ${formatInt(data.assortment.days)}${NBSP}d`}
        title={view.title}
        aside={view.aside}
      />
      {view.suggestions.length > 0 ? (
        <ul className="flex flex-col gap-2" data-assortment-suggestions>
          {view.suggestions.map((text) => (
            <li
              key={text}
              className="flex items-start gap-2.5 rounded-md border border-signal-line bg-surface px-4 py-3 text-base text-fg max-md:px-3"
            >
              <span aria-hidden className="mt-2 inline-block size-2 shrink-0 bg-signal" />
              <span>{text}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {view.notice ? <p className="text-base text-muted">{view.notice}</p> : null}
      {view.rows.length > 0 ? (
        <ol className="flex flex-col">
          {view.rows.map((r, i) => (
            <li
              key={r.titleId}
              className="flex flex-col gap-2 border-t border-line py-3 first:border-t-0"
            >
              <span className="flex items-baseline justify-between gap-3">
                <span className="min-w-0 text-base break-words text-fg">{r.name}</span>
                <span className="tnum shrink-0 text-base font-medium text-fg">{r.units}</span>
              </span>
              <span aria-hidden className="block h-2 overflow-hidden rounded-xs bg-line">
                <span
                  className={cn(
                    "grow-x block h-full rounded-xs",
                    r.warn ? "bg-signal" : "bg-fg/70",
                  )}
                  style={{ width: `${Math.round(r.bar * 100)}%`, "--i": i } as React.CSSProperties}
                />
              </span>
              <span className="flex flex-col gap-1">
                {r.tag ? (
                  <StatusTag status={r.warn ? "warning" : "neutral"} wrap>
                    {r.tag}
                  </StatusTag>
                ) : null}
                <span className="meta text-muted">Vinst {r.profit}</span>
                <span className="meta text-subtle">{r.basis}</span>
              </span>
            </li>
          ))}
        </ol>
      ) : null}
      <p className="meta text-subtle">{view.note}</p>
    </section>
  );
}

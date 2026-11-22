import type React from "react";

import type { SearchParamsInput } from "@/components/shell/period-state";
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
    <section aria-labelledby="basta-sortiment" data-assortment className="v2-card">
      <div className="v2-card-hd">
        <h2>{`Bästa sortiment · ${formatInt(data.assortment.days)}${NBSP}d`}</h2>
      </div>
      <div className="flex flex-col gap-3 px-[18px] pt-3.5 pb-4 max-[900px]:px-4">
        <div className="flex flex-col gap-1">
          <h3 id="basta-sortiment" className="text-v2-lg font-[650] text-v2-ink">
            {view.title}
          </h3>
          {view.aside ? <p className="text-v2-sm text-v2-mute">{view.aside}</p> : null}
        </div>
        {view.suggestions.length > 0 ? (
          <ul className="flex flex-col gap-2" data-assortment-suggestions>
            {view.suggestions.map((text) => (
              <li key={text} className="v2-notice warning">
                <span className="dot" aria-hidden="true" />
                <div className="tx">
                  <div>{text}</div>
                </div>
              </li>
            ))}
          </ul>
        ) : null}
        {view.notice ? <p className="text-v2-sm text-v2-mute">{view.notice}</p> : null}
        {view.rows.length > 0 ? (
          <ol className="grid grid-cols-1 gap-x-8 md:grid-cols-2">
            {view.rows.map((r) => (
              <li key={r.titleId} className="flex flex-col gap-1.5 border-t border-v2-line2 py-2.5">
                <span className="flex items-baseline justify-between gap-3">
                  <span className="min-w-0 text-v2-sm font-[550] break-words text-v2-ink">
                    {r.name}
                  </span>
                  <span className="tnum shrink-0 text-v2-sm font-[550] text-v2-ink">{r.units}</span>
                </span>
                <span className="v2-track block w-full" aria-hidden>
                  <i
                    className={cn(r.warn && "critical")}
                    style={{ transform: `scaleX(${r.bar})` }}
                  />
                </span>
                <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-v2-xs text-v2-mute">
                  {r.tag ? (
                    <StatusTag status={r.warn ? "warning" : "neutral"} wrap>
                      {r.tag}
                    </StatusTag>
                  ) : null}
                  <span>{`Vinst ${r.profit}`}</span>
                  <span aria-hidden>·</span>
                  <span>{r.basis}</span>
                </span>
              </li>
            ))}
          </ol>
        ) : null}
        <p className="text-v2-xs text-v2-mute">{view.note}</p>
      </div>
    </section>
  );
}

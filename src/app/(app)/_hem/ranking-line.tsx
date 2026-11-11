import Link from "next/link";

import type { SearchParamsInput } from "@/components/shell/period-state";
import { carriedQuery } from "@/components/shell/period-state";
import { loadContext, loadMasterData } from "@/server/data/core";

import { machineHref } from "../automater/_lib/model";
import { homeRankingLine, rankingView } from "../automater/_lib/ranking";
import { loadFleetRanking } from "../automater/_lib/ranking-data";

/** Raden, eller null: färre än två automater, inget att säga, eller rankingen går inte att läsa. */
async function loadLine(sp: SearchParamsInput): Promise<string | null> {
  try {
    const [ctx, master] = await Promise.all([loadContext(), loadMasterData()]);
    if (!ctx.canSeeEconomy) return null;
    // Med en automat finns ingen rangordning: inget läses.
    if (master.machines.filter((m) => !m.archived).length < 2) return null;
    const data = await loadFleetRanking(sp, { withLost: false });
    const view = rankingView({
      ranking: data.ranking,
      machines: data.machines,
      hrefOf: (code) => machineHref(code),
      storeShareDeducted: data.storeShareDeducted,
    });
    return homeRankingLine(view, data.ranking);
  } catch (error) {
    // Ett fel i rankingen ska aldrig stoppa Hem.
    console.error("[hem] Automat-rankingen kunde inte läsas:", error);
    return null;
  }
}

/**
 * Automat-ranking på Hem, bara med minst två automater: "BL-003 tjänar mest: 412 kr/dag.
 * BL-007 går dåligt: överväg att flytta den." Länkar till rangordningen på Automater.
 */
export async function RankingLine({ searchParams }: { searchParams: SearchParamsInput }) {
  const text = await loadLine(searchParams);
  if (!text) return null;
  return (
    <Link
      href={`/automater${carriedQuery(searchParams)}#rangordning`}
      data-home-ranking
      className="fade-in group flex min-h-11 items-center justify-between gap-3 rounded-md border border-line bg-surface px-4 py-3 text-base text-fg hover:bg-hover max-md:px-3 max-md:py-2 max-md:text-sm"
    >
      <span>{text}</span>
      <span aria-hidden className="text-subtle transition-colors group-hover:text-fg">
        →
      </span>
    </Link>
  );
}

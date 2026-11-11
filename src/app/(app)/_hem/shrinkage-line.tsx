import { buildShrinkage, shrinkageHomeLine, shrinkageValueText } from "@/analytics/shrinkage";
import { addDays, type Period } from "@/domain";
import { loadContext, loadMasterData, requireViewer } from "@/server/data/core";
import { loadShrinkageFor } from "@/server/data/shrinkage";

import { HomeRow } from "./home-row";

/** Dagar bakåt (t.o.m. i dag) som Hem tittar på. */
export const HOME_SHRINKAGE_DAYS = 14;

/** Raden och perioden, eller null när inget saknas (eller svinnkontrollen inte går att läsa). */
async function loadLine(): Promise<{ text: string; value: string | null; period: Period } | null> {
  try {
    const [ctx, master, viewer] = await Promise.all([
      loadContext(),
      loadMasterData(),
      requireViewer(),
    ]);
    if (!ctx.canSeeEconomy) return null;
    const period = { start: addDays(ctx.today, -(HOME_SHRINKAGE_DAYS - 1)), end: ctx.today };
    const report = buildShrinkage(await loadShrinkageFor(viewer, period), master);
    const text = shrinkageHomeLine(report);
    return text ? { text, value: shrinkageValueText(report.valueOre), period } : null;
  } catch (error) {
    // Ett fel i svinnkontrollen ska aldrig stoppa Hem.
    console.error("[hem] Svinnkontrollen kunde inte läsas:", error);
    return null;
  }
}

/**
 * En rad på Hem bara när pack saknas i en automat (svinnkontrollen för de senaste
 * HOME_SHRINKAGE_DAYS dagarna): "4 pack borta ur BL-002 (svinn). · 240 kr →", till svinnkontrollen. Samma radstil som utbetalningen
 * och nästa sak att göra (HomeRow). Annars inget.
 */
export async function ShrinkageLine() {
  const line = await loadLine();
  if (!line) return null;
  return (
    <HomeRow
      href={`/automater/svinn?period=eget&from=${line.period.start}&to=${line.period.end}`}
      tone="signal"
      className="fade-in"
      data-home-shrinkage=""
    >
      {line.text}
      {line.value ? <span className="text-muted"> · {line.value}</span> : null}
    </HomeRow>
  );
}

/**
 * KPI-bandet på Hem (V2, byggplanen 3.5, prototypens paintBand): alltid åtta rutor i samma
 * ordning, så att layouten aldrig hoppar:
 *
 *   Vinst · Vinst i dag (mot i går samma tid) · Intäkt · Sålda pack · Snittköp · Marginal ·
 *   Vinst/automat/dag · Lagervärde (mot förra veckan)
 *
 * Med perioden "I dag" blir de två första "Vinst i dag" och "Vinst 30 d" (som prototypen).
 *
 * Allt ur befintliga modeller: Hems nyckeltal (vinst, sålda pack, med jämförelse och
 * dagsserie), Lönsamhets modell (samma som Pengar) för intäkten och marginalen, liggaren
 * (profitability) för dagens och gårdagens vinst, och Vårt lager för lagervärdet.
 *
 * Intäkt = intäkten exkl. moms för order med inköpspris, samma tal som Pengars Resultat och
 * samma bas som marginalen (vinst ÷ intäkt), så att Intäkt × Marginal = Vinst. Order utan
 * inköpspris står inte i intäkten (de har ingen vinst än); de syns på Pengar.
 *
 * En period utan försäljning visar 0 kr (inte "–"). Bara ekonomiroller; påfyllaren får null
 * och ser inte bandet.
 */

import "server-only";

import { sql } from "drizzle-orm";

import {
  changeBp,
  hourlyRunning,
  kpiDeltaBp,
  machineDays,
  perMachineDaySeries,
  profitPerMachineDayOre,
  splitTodayYesterday,
} from "@/analytics/home-v2";
import {
  compareTextShort,
  periodQuery,
  type SearchParamsInput,
} from "@/components/shell/period-state";
import { addDays, profitability, type IsoDate } from "@/domain";
import { withUserDbFor } from "@/server/access";
import {
  loadContext,
  loadDomainInput,
  loadPeriod,
  loadSyncInfo,
  requireViewer,
} from "@/server/data/core";
import type { DomainInput } from "@/server/data/core/types";

import type { HomeKpi } from "@/app/(app)/_hem/model";
import { hemKey, loadHemCore, loadHemProfit, loadHemStock } from "./hem-base";

export type KpiTileUnit = "ore" | "bp" | "count";

export interface KpiBandTile {
  readonly id: string;
  readonly label: string;
  readonly value: number | null;
  readonly unit: KpiTileUnit;
  readonly deltaBp: number | null;
  readonly deltaUnit: "pct" | "pe";
  readonly compare: string | null;
  readonly trend: readonly number[];
  readonly href: string;
  /** Grått förändringsmärke (lagervärdet: upp är inte bättre). */
  readonly neutral?: boolean;
}

/** En ruta ur Hems nyckeltal. Utan försäljning: 0 (aldrig "–"), och rutan står alltid kvar. */
function fromKpi(
  id: string,
  k: HomeKpi | undefined,
  label: string,
  href: string,
  compare: string | null,
  unit: KpiTileUnit,
): KpiBandTile {
  if (!k) {
    return {
      id,
      label,
      value: 0,
      unit,
      deltaBp: null,
      deltaUnit: "pct",
      compare: null,
      trend: [],
      href,
    };
  }
  const deltaBp = kpiDeltaBp(k.delta, k.deltaKind);
  return {
    id,
    label,
    value: k.value ?? 0,
    unit: k.unit,
    deltaBp,
    deltaUnit: k.deltaKind === "absolute" ? ("pe" as const) : ("pct" as const),
    compare: deltaBp === null ? null : compare,
    trend: k.trend,
    href,
  } satisfies KpiBandTile;
}

/** Värdet av lagret till inköpspris: hemma + i automaterna (öre), eller null. */
export function stockValueOre(
  rows: readonly {
    readonly home: number;
    readonly inMachines: number;
    readonly unitCostOre: number | null;
  }[],
): number | null {
  let sum = 0;
  let any = false;
  for (const r of rows) {
    if (r.unitCostOre === null) continue;
    const packs = Math.max(0, r.home) + Math.max(0, r.inMachines);
    if (packs === 0) continue;
    sum += packs * r.unitCostOre;
    any = true;
  }
  return any ? sum : null;
}

/**
 * Lagrets värde till inköpspris vid slutet av var och en av de senaste 8 dagarna (äldst först,
 * sista = nu): saldot per lagerplats och titel räknat ur liggaren som vyn stock_levels gör det
 * (senaste inventeringen före tidpunkten + händelserna efter den), samma urval som Vårt lager
 * (alla egna lager; automaterna bara där saldot är känt, minst 0) och dagens inköpspris per
 * titel. Ändringen mot förra veckan är alltså antalet pack, värderat till samma pris.
 */
export async function loadStockValueHistory(
  today: IsoDate,
  timeZone: string,
  unitCost: ReadonlyMap<string, number | null>,
): Promise<number[]> {
  const viewer = await requireViewer();
  const org = viewer.organization.id;
  const rows = await withUserDbFor(
    viewer.user,
    async (tx) =>
      Array.from(
        await tx.execute(sql`
        with ends as (
          select k, ((${today}::date - k + 1)::timestamp at time zone ${timeZone}) as at
          from generate_series(0, 7) as k
        ),
        pairs as (
          select distinct e.location_id, e.title_id, l.kind::text as kind
          from public.stock_events e
          join public.stock_locations l
            on l.organization_id = e.organization_id and l.id = e.location_id
          where e.organization_id = ${org}::uuid and l.archived_at is null
            and l.kind in ('warehouse', 'machine')
        )
        select ends.k, p.kind, p.title_id::text as title_id,
          (coalesce(lc.quantity, 0) + coalesce((
            select sum(a.quantity) from public.stock_events a
            where a.organization_id = ${org}::uuid and a.location_id = p.location_id
              and a.title_id = p.title_id and a.kind <> 'count' and a.occurred_at < ends.at
              and (lc.seq is null or row(a.occurred_at, a.seq) > row(lc.occurred_at, lc.seq))
          ), 0))::int as qty,
          (lc.seq is not null or exists (
            select 1 from public.stock_events r
            where r.organization_id = ${org}::uuid and r.location_id = p.location_id
              and r.title_id = p.title_id and r.kind = 'refill' and r.occurred_at < ends.at
          )) as known
        from pairs p
        cross join ends
        left join lateral (
          select c.quantity, c.occurred_at, c.seq from public.stock_events c
          where c.organization_id = ${org}::uuid and c.location_id = p.location_id
            and c.title_id = p.title_id and c.kind = 'count' and c.occurred_at < ends.at
          order by c.occurred_at desc, c.seq desc
          limit 1
        ) lc on true`),
      ) as { k: number; kind: string; title_id: string; qty: number; known: boolean }[],
  );
  const perDay = Array.from(
    { length: 8 },
    () => new Map<string, { home: number; inMachines: number }>(),
  );
  for (const r of rows) {
    const day = perDay[7 - Number(r.k)];
    if (!day) continue;
    const cur = day.get(r.title_id) ?? { home: 0, inMachines: 0 };
    if (r.kind === "warehouse") cur.home += Number(r.qty);
    else if (r.known) cur.inMachines += Math.max(0, Number(r.qty));
    day.set(r.title_id, cur);
  }
  return perDay.map(
    (day) =>
      stockValueOre(
        [...day.entries()].map(([titleId, q]) => ({
          ...q,
          unitCostOre: unitCost.get(titleId) ?? null,
        })),
      ) ?? 0,
  );
}

/** Vinsten (öre) för en del av perioden ur liggaren, med periodens avtal och priser. */
function profitOf(
  input: DomainInput["current"],
  day: IsoDate,
  orders: DomainInput["current"]["orders"],
): number {
  return profitability({ ...input, period: { start: day, end: day }, orders }, "title").totals
    .profitOre;
}

export async function loadKpiBand(sp: SearchParamsInput): Promise<KpiBandTile[] | null> {
  const key = hemKey(sp);
  const [ctx, home] = await Promise.all([loadContext(), loadHemCore(key)]);
  if (!ctx.canSeeEconomy || !home) return null;
  const p = await loadPeriod(sp);
  const isToday = p.key === "idag";
  const yesterday = addDays(ctx.today, -1);
  // Med perioden "I dag" visar andra rutan de senaste 30 dagarna (samma filter).
  const key30 = JSON.stringify({ ...(JSON.parse(key) as Record<string, string>), period: "30d" });
  const [input, money, money30, stock, twoDays, sync] = await Promise.all([
    loadDomainInput({ period: p.period, compare: p.compare, ...p.scope }),
    loadHemProfit(key),
    isToday ? loadHemProfit(key30) : Promise.resolve(null),
    loadHemStock(),
    loadDomainInput({ period: { start: yesterday, end: ctx.today }, compare: null, ...p.scope }),
    loadSyncInfo().catch(() => null),
  ]);
  const kpis = new Map(home.model.kpis.map((k) => [k.id, k]));
  const compare = compareTextShort(p.resolved) ?? "mot förra";
  // Rutornas länkar bär periodvalet, så att sidan bakom visar samma period som Hem.
  const pq = periodQuery(sp);
  const lp = (extra: string) => `/pengar${extra || pq}`;

  // Vinsten: utan order i perioden 0 kr (inte "–").
  const profitKpi = kpis.get("profit");
  const profitTile = fromKpi("profit", profitKpi, "Vinst", lp(""), compare, "ore");

  // I dag mot i går samma tid (klockslaget: det tidigaste av nu och senaste synken).
  const now = Date.parse(ctx.now);
  const synced = sync?.syncedAt ? Date.parse(sync.syncedAt) : Number.NaN;
  const cutoff = Number.isFinite(synced) ? Math.min(now, synced) : now;
  const split = splitTodayYesterday(twoDays.current.orders, ctx.today, cutoff, ctx.timeZone);
  const todayProfit = split.today.length ? profitOf(twoDays.current, ctx.today, split.today) : 0;
  const yesterdayProfit = split.yesterday.length
    ? profitOf(twoDays.current, yesterday, split.yesterday)
    : 0;
  const todayDelta = split.yesterday.length > 0 ? changeBp(todayProfit, yesterdayProfit) : null;
  const todayTile: KpiBandTile = {
    id: "profit-today",
    label: "Vinst i dag",
    value: todayProfit,
    unit: "ore",
    deltaBp: todayDelta,
    deltaUnit: "pct",
    compare: todayDelta === null ? "i går 0 kr samma tid" : "mot i går",
    trend: hourlyRunning(split, (os) => profitOf(twoDays.current, ctx.today, os)),
    href: lp("?period=idag"),
  };
  const p30 = money30?.model.kpis.find((k) => k.id === "profit");
  const days30 = money30?.model.trend.day.buckets ?? [];
  const tile30: KpiBandTile = {
    id: "profit-30d",
    label: "Vinst 30 d",
    value: p30?.value ?? 0,
    unit: "ore",
    deltaBp: kpiDeltaBp(p30?.delta ?? null, "relative"),
    deltaUnit: "pct",
    compare: p30?.delta != null ? "mot förra 30 d" : null,
    trend: days30.map((b) => b.profitOre),
    href: lp("?period=30d"),
  };

  // Intäkten och marginalen ur Lönsamhets modell (samma som Pengar): intäkt med inköpspris.
  const bridge = money?.model.bridge;
  const revenue = bridge?.revenueOre ?? 0;
  const prevRevenue =
    money?.input.previous && p.compare && !isToday
      ? profitability(money.input.previous, "title").totals.revenueOre
      : null;
  const dayBuckets = money?.model.trend.day.buckets ?? [];
  const revenueDelta = changeBp(revenue, prevRevenue);
  const revenueTile: KpiBandTile = {
    id: "revenue",
    label: "Intäkt",
    value: revenue,
    unit: "ore",
    deltaBp: revenueDelta,
    deltaUnit: "pct",
    compare: revenueDelta === null ? "exkl. moms" : compare,
    trend: dayBuckets.map((b) => b.revenueOre),
    href: lp(""),
  };
  // Marginalen: vinst ÷ intäkten ovan (Hems och Lönsamhets nyckeltal är samma tal).
  const marginKpi = fromKpi("margin", kpis.get("margin"), "Marginal", lp(""), compare, "bp");
  // Utan intäkt finns ingen marginal: "–" (inte "0,0 %").
  const marginTile: KpiBandTile =
    revenue > 0 ? marginKpi : { ...marginKpi, value: null, deltaBp: null, compare: null };

  // Vinst per automat och dag (automatdagar: dagar en automat var i drift).
  const md = machineDays(input.machines, p.period);
  const mdPrev = p.compare ? machineDays(input.machines, p.compare) : 0;
  const perMachine = profitPerMachineDayOre(profitTile.value ?? 0, md) ?? 0;
  const prevProfit = profitKpi?.previous ?? null;
  const perMachinePrev = profitPerMachineDayOre(prevProfit, mdPrev);
  const perMachineDelta = isToday ? null : changeBp(perMachine, perMachinePrev);

  // Lagervärdet nu och vid dagens slut de senaste 7 dagarna (mot förra veckan).
  const unitCost = new Map((stock?.rows ?? []).map((r) => [r.titleId, r.unitCostOre]));
  const history = stock
    ? await loadStockValueHistory(ctx.today, ctx.timeZone, unitCost).catch((error: unknown) => {
        console.error("[hem] Lagervärdets historik kunde inte räknas:", error);
        return [];
      })
    : [];
  const stockNow = stock ? (stockValueOre(stock.rows) ?? 0) : 0;
  const weekAgo = history.length === 8 ? (history[0] ?? null) : null;
  const stockDelta = changeBp(stockNow, weekAgo);

  const tiles: KpiBandTile[] = [
    isToday
      ? { ...profitTile, id: "profit-today", label: "Vinst i dag", ...pick(todayTile) }
      : profitTile,
    isToday ? tile30 : todayTile,
    revenueTile,
    fromKpi("orders", kpis.get("orders"), "Sålda pack", `/order${pq}`, compare, "count"),
    fromKpi("aov", kpis.get("aov"), "Snittköp", `/order${pq}`, compare, "ore"),
    marginTile,
    {
      id: "per-machine",
      label: "Vinst/automat/dag",
      value: perMachine,
      unit: "ore",
      deltaBp: perMachineDelta,
      deltaUnit: "pct",
      compare: perMachineDelta === null ? null : compare,
      trend: perMachineDaySeries(
        dayBuckets
          .filter((b) => !b.partial || p.days === 1)
          .map((b) => ({
            date: b.start,
            profitOre: b.profitOre,
          })),
        input.machines,
      ),
      href: `/automater${pq}`,
    },
    {
      id: "stock-value",
      label: "Lagervärde",
      value: stockNow,
      unit: "ore",
      deltaBp: stockDelta,
      deltaUnit: "pct",
      compare: stockDelta === null ? "till inköpspris" : "mot förra v.",
      neutral: true,
      trend: history.length === 8 ? [...history.slice(0, 7), stockNow] : [],
      href: `/vart-lager${pq}`,
    },
  ];
  return tiles;
}

/** Värde, jämförelse och linje ur dagens ruta (perioden "I dag": första rutan). */
function pick(t: KpiBandTile) {
  return { value: t.value, deltaBp: t.deltaBp, compare: t.compare, trend: t.trend };
}

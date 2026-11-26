/**
 * Underlaget till Dagens brief (GET /dagens-brief): samma laddare som Hem (Kräver åtgärd,
 * Dagens rutt), Att göra (avräkningar, inköpspriser, larm) och försäljningen i går. Korten
 * byggs av @/analytics/brief.
 *
 * Rollen avgörs här, på servern: påfyllaren läser aldrig Att göras ekonomipunkter eller
 * försäljningen i kronor, och Hems laddare skickar redan inga belopp för rollen. Ett fel i
 * en del ger bara att kortet saknas; ett fel i allt ger inga kort (rutan visas inte).
 */

import "server-only";

import {
  buildBriefCards,
  type BriefCard,
  type BriefInput,
  type BriefRole,
} from "@/analytics/brief";
import type { TodoItem } from "@/analytics/todos";
import { addDays, daysBetween, type IsoDate } from "@/domain";
import { loadContext } from "@/server/data/core";
import { loadRankedTodoState } from "@/server/data/todos";
import { loadDaySales } from "@/server/data/v2/analytics/day-sales";

import { loadHemToday } from "../v2/today-data";

/** Dagar bakåt som "vanligt" räknas på (före i går). */
const NORMAL_DAYS = 28;

export interface BriefPayload {
  /** Dagens datum i organisationens tidszon (en gång per dag räknas på det). */
  readonly day: IsoDate;
  readonly cards: readonly BriefCard[];
}

function appHref(link: string): string {
  return link.startsWith("/") ? link : `/${link.replace(/^#/, "")}`;
}

function figure(t: TodoItem, key: string): number | null {
  const f = t.evidence.figures.find((x) => x.key === key);
  return typeof f?.value === "number" ? f.value : null;
}

/** Punkterna ur Att göra som korten använder (bara ekonomiroller). */
export function todoParts(
  items: readonly TodoItem[],
  offlineIds: ReadonlySet<string>,
): Pick<BriefInput, "alerts" | "settlements" | "missingPrices"> {
  const alerts = items
    .filter((t) => t.kind === "alert")
    .filter((t) => !t.evidence.machineIds.some((id) => offlineIds.has(id)))
    .map((t) => ({ title: t.title, href: appHref(t.link) }));
  const settlements = items
    .filter((t) => t.kind === "settlement")
    .map((t) => ({
      count: figure(t, "settlements") ?? 0,
      totalOre: figure(t, "totalOre") ?? 0,
      due: t.evidence.dates[0] ?? null,
      href: appHref(t.link),
    }));
  const missingPrices = items
    .filter((t) => t.kind === "missing-price")
    .map((t) => ({
      name: t.title.replace(/^Lägg in inköpspris för\s+/, ""),
      href: appHref(t.link),
    }));
  return { alerts, settlements, missingPrices };
}

async function loadYesterday(today: IsoDate): Promise<BriefInput["yesterday"]> {
  const [y, normal] = await Promise.all([
    loadDaySales({ period: "igar" }),
    loadDaySales({
      period: "eget",
      from: addDays(today, -(NORMAL_DAYS + 1)),
      to: addDays(today, -2),
    }),
  ]);
  const days = Math.max(1, daysBetween(normal.period.start, normal.period.end) + 1);
  const normalRevenue =
    normal.sales.revenueOre !== null && normal.sales.units > 0
      ? Math.round(normal.sales.revenueOre / days)
      : null;
  return {
    units: y.sales.units,
    revenueOre: y.sales.revenueOre ?? 0,
    normalRevenueOre: normalRevenue,
  };
}

function soft<T>(label: string, p: Promise<T>, fallback: T): Promise<T> {
  return p.catch((error: unknown) => {
    console.error(`[brief] ${label} kunde inte läsas:`, error);
    return fallback;
  });
}

/** Dagens brief för den inloggade. null: inget att visa (t.ex. enkel vy). */
export async function loadBrief(): Promise<BriefPayload | null> {
  const ctx = await loadContext();
  if (ctx.viewMode === "simple") return null;
  const role = ctx.role as BriefRole;
  const economy = ctx.canSeeEconomy;
  const [today, todoState, yesterday] = await Promise.all([
    loadHemToday(),
    economy
      ? soft("Att göra", loadRankedTodoState(), { items: [], dismissed: [] })
      : Promise.resolve({ items: [] as TodoItem[], dismissed: [] }),
    economy ? soft("Försäljningen i går", loadYesterday(ctx.today), null) : Promise.resolve(null),
  ]);

  const rows = today.actions.rows;
  const machines = rows
    .filter((r) => r.kind !== "pris" && r.machineId !== null)
    .map((r) => ({
      id: r.machineId!,
      name: r.title,
      kind: r.kind as Exclude<typeof r.kind, "pris">,
      packs: r.packs,
      ...(economy && r.lossOre !== undefined ? { lossOre: r.lossOre } : {}),
    }));
  const offlineIds = new Set(machines.filter((m) => m.kind === "offline").map((m) => m.id));
  const lossPrices = economy
    ? rows
        .filter((r) => r.kind === "pris")
        .map((r) => ({
          name: r.title.replace(/\s+går med förlust$/, ""),
          lossOre: r.lossOre ?? null,
          suggestedPriceOre: r.price?.suggestedPriceOre ?? null,
        }))
    : [];

  const input: BriefInput = {
    role,
    today: ctx.today,
    machines,
    route: {
      stops: today.route.stops,
      done: today.route.done,
      cities: today.route.cities,
      totalPacks: today.route.totalPacks,
      km: today.route.totalKm,
    },
    ...(economy ? todoParts(todoState.items, offlineIds) : {}),
    lossPrices,
    yesterday: economy ? yesterday : null,
  };
  return { day: ctx.today, cards: buildBriefCards(input) };
}

/**
 * Besök i Att göra: påfyllningspunkterna för en automat slås ihop till en rad, "Åk till
 * BL-003 senast torsdag". Ingen ny sorts punkt: punkterna (och deras nycklar,
 * 'refill:<automat>:<titel>') är desamma och bockas av per titel. Det här är bara hur
 * listan visas och räknas, på Att göra, Hem och i menyns räknare.
 *
 * Dagen kommer ur besöksplanen (samma som Drift > Besök): stoppets `needBy`. Den räknas
 * inte här. Utan plan (eller när automaten inte har något stopp i veckans plan) står raden
 * utan dag: "i dag" när något redan är slut, annars "snart".
 *
 * Ren modul utan I/O och utan `Date`.
 */

import { addDays, dayOfWeek, daysBetween, sumOre, type IsoDate } from "@/domain";

import { day, weekdayName } from "./text";
import type { TodoItem, TodoLevel } from "./types";

/** Det som behövs ur besöksplanen (VisitPlan i @/analytics/visits passar rakt in). */
export interface VisitPlanDays {
  readonly days: ReadonlyArray<{
    readonly date: IsoDate;
    readonly stops: ReadonlyArray<{
      readonly machineId: string;
      readonly needBy: IsoDate;
      readonly late: boolean;
      readonly totalPacks: number;
      /** Packlistan per titel. Med den räknas besökets pack bara för titlarna i besöket. */
      readonly packs?: ReadonlyArray<{ readonly titleId: string; readonly quantity: number }>;
    }>;
  }>;
  /** Automater utan besök i veckans plan, med sin senaste dag (längre fram), om den finns. */
  readonly notNeeded?: ReadonlyArray<{
    readonly machineId: string;
    readonly needBy: IsoDate | null;
  }>;
}

/** Ett besök: alla påfyllningspunkter för en automat. */
export interface TodoVisit {
  /** 'visit:<automat>'. Bara för visning, sparas aldrig. */
  readonly key: string;
  readonly machineId: string;
  /** Den mest brådskande punktens nivå. */
  readonly level: TodoLevel;
  /** Besöksplanens senaste dag för besöket, eller null utan stopp i planen. */
  readonly needBy: IsoDate | null;
  /** Dagen besöket är planerat (besöksdag i planen), eller null. */
  readonly planned: IsoDate | null;
  /**
   * Pack att fylla på för titlarna i besöket, enligt besöksplanens packlista (samma antal som
   * raderna i Drift > Besök), eller null utan stopp. Planen kan lägga fler titlar i samma
   * besök (fyller upp när man ändå är där); de räknas inte här, så att "1 titel · 6 pack"
   * gäller samma titel.
   */
  readonly packs: number | null;
  /**
   * Hela packlistan för automaten i besöksplanen (talet på Drift > Besök och Lager: "Ta med
   * 86 pack"), också titlarna som bara fylls upp när man ändå är där. null utan stopp.
   * Större än `packs` när planen har fler titlar än punkterna i besöket.
   */
  readonly planPacks?: number | null;
  /** Intäkt i risk 7 dagar (öre), summan av punkternas belopp i hela kronor. */
  readonly atStakeOre: number;
  /** Punkterna i besöket, i listans ordning. */
  readonly items: readonly TodoItem[];
}

/** En rad i listan: en vanlig punkt eller ett besök. */
export type TodoEntry =
  | { readonly type: "todo"; readonly item: TodoItem }
  | { readonly type: "visit"; readonly visit: TodoVisit };

const LEVEL_RANK: Record<TodoLevel, number> = { now: 0, soon: 1, later: 2 };

/** Automaten för en påfyllningspunkt, annars null (andra sorter står som egna rader). */
export function refillMachineOf(item: Pick<TodoItem, "kind" | "key" | "evidence">): string | null {
  if (item.kind !== "refill") return null;
  return item.evidence.machineIds[0] ?? item.key.split(":")[1] ?? null;
}

/** Titeln för en påfyllningspunkt ('refill:<automat>:<titel>'), annars null. */
export function refillTitleOf(item: Pick<TodoItem, "kind" | "key" | "evidence">): string | null {
  if (item.kind !== "refill") return null;
  return item.key.split(":")[2] ?? item.evidence.titleIds[0] ?? null;
}

/** Hela kronor per punkt innan summan tas, som rubriken på Att göra (stakeOf). */
function wholeKronor(ore: number): number {
  return Math.round(Math.max(ore, 0) / 100) * 100;
}

/**
 * Listan med påfyllningarna hopslagna per automat. Besöket står där automatens första
 * punkt stod, och tar den mest brådskande punktens nivå. Övriga punkter står kvar som de är.
 */
export function groupVisits(
  items: readonly TodoItem[],
  plan: VisitPlanDays | null = null,
  /** Dagens datum: ett besök som planen lägger i dag (eller tidigare) gäller nu. */
  today: IsoDate | null = null,
): TodoEntry[] {
  const stops = new Map<
    string,
    {
      needBy: IsoDate;
      planned: IsoDate | null;
      total: number | null;
      byTitle: ReadonlyMap<string, number> | null;
    }
  >();
  for (const d of plan?.days ?? []) {
    for (const s of d.stops) {
      if (!stops.has(s.machineId)) {
        stops.set(s.machineId, {
          needBy: s.needBy,
          planned: d.date,
          total: s.totalPacks,
          byTitle: s.packs ? new Map(s.packs.map((p) => [p.titleId, p.quantity])) : null,
        });
      }
    }
  }
  // Utan besök den här veckan: planens senaste dag står kvar (längre fram), utan packlista.
  for (const n of plan?.notNeeded ?? []) {
    if (n.needBy !== null && !stops.has(n.machineId)) {
      stops.set(n.machineId, { needBy: n.needBy, planned: null, total: null, byTitle: null });
    }
  }
  const byMachine = new Map<string, TodoItem[]>();
  for (const t of items) {
    const m = refillMachineOf(t);
    if (m === null) continue;
    const list = byMachine.get(m);
    if (list) list.push(t);
    else byMachine.set(m, [t]);
  }
  const out: TodoEntry[] = [];
  const seen = new Set<string>();
  for (const t of items) {
    const m = refillMachineOf(t);
    if (m === null) {
      out.push({ type: "todo", item: t });
      continue;
    }
    if (seen.has(m)) continue;
    seen.add(m);
    const group = byMachine.get(m) ?? [t];
    const stop = stops.get(m) ?? null;
    out.push({
      type: "visit",
      visit: {
        key: `visit:${m}`,
        machineId: m,
        // Säger planen "i dag" står besöket under I dag, så att rad och grupp säger samma.
        level:
          today !== null && stop && stop.needBy <= today
            ? "now"
            : group.reduce<TodoLevel>(
                (best, x) => (LEVEL_RANK[x.level] < LEVEL_RANK[best] ? x.level : best),
                "later",
              ),
        needBy: stop?.needBy ?? null,
        planned: stop?.planned ?? null,
        packs: stop
          ? stop.byTitle
            ? group.reduce((n, x) => n + (stop.byTitle?.get(refillTitleOf(x) ?? "") ?? 0), 0)
            : stop.total
          : null,
        planPacks: stop?.total ?? null,
        atStakeOre: sumOre(group.map((x) => wholeKronor(x.atStakeOre ?? 0))),
        items: group,
      },
    });
  }
  // Ett besök tar sin mest brådskande punkts nivå och kan därför hamna före punkter som
  // stod före dess första punkt: nivån går först, sedan ordningen som den var.
  return out
    .map((e, i) => ({ e, i }))
    .sort((a, b) => LEVEL_RANK[entryLevel(a.e)] - LEVEL_RANK[entryLevel(b.e)] || a.i - b.i)
    .map((x) => x.e);
}

export function entryLevel(e: TodoEntry): TodoLevel {
  return e.type === "visit" ? e.visit.level : e.item.level;
}

/** Antalet rader: ett besök räknas som en sak (menyns räknare, Hem och Att göra). */
export function countWithVisits(items: readonly TodoItem[]): number {
  const machines = new Set<string>();
  let n = 0;
  for (const t of items) {
    const m = refillMachineOf(t);
    if (m === null) n += 1;
    else machines.add(m);
  }
  return n + machines.size;
}

/**
 * När besöket ska göras, i ord: "i dag" (också när dagen passerat, och alltid när besöket
 * gäller nu), "senast i morgon", "senast torsdag" (inom en vecka), "senast 19 nov." (längre
 * fram). Utan dag ur planen: "snart".
 */
export function visitWhen(visit: Pick<TodoVisit, "needBy" | "level">, today: IsoDate): string {
  const { needBy } = visit;
  // Står besöket under "I dag" (något är slut eller under larmgränsen) säger raden i dag,
  // också när planens dag är senare: raden och gruppen får aldrig säga olika.
  if (visit.level === "now") return "i dag";
  if (needBy === null) return "snart";
  if (needBy <= today) return "i dag";
  if (needBy === addDays(today, 1)) return "senast i morgon";
  if (daysBetween(today, needBy) < 7) return `senast ${weekdayName(dayOfWeek(needBy))}`;
  return `senast ${day(needBy)}`;
}

/** "Åk till BL-003 senast torsdag" (utan punkt). `label` = automatens kod, annars namnet. */
export function visitTitle(
  visit: Pick<TodoVisit, "needBy" | "level">,
  label: string,
  today: IsoDate,
): string {
  return `Åk till ${label} ${visitWhen(visit, today)}`;
}

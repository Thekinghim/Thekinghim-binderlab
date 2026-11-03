/**
 * Morgonbriefens underlag och de fasta raderna.
 *
 * Underlaget är litet: gårdagens försäljning (keyMetrics och profitabilityViews, samma
 * tal som Hem med perioden "I går") mot samma veckodag veckan före, gårdagens bästa
 * automat och punkterna i Att göra (samma lista och ordning som Hem och Att göra). Talen
 * är färdigformaterade ("1 240 kr", "+12 %"), så att modellen bara citerar dem, och
 * raderna kontrolleras mot just det här objektet (check.ts).
 *
 * De fasta raderna (fallbackLines) byggs ur samma underlag och används när modellens rad
 * inte klarar kontrollen.
 *
 * Ren modul: ingen databas, inga miljövariabler.
 */

import type { TodoItem } from "@/analytics/todos/types";
import {
  addDays,
  changeBp,
  keyMetrics,
  profitabilityViews,
  type IsoDate,
  type ProfitabilityInput,
} from "@/domain";
import { formatDelta, formatSek } from "@/lib/format";

/** Högst så många punkter ur Att göra i underlaget. */
export const BRIEF_MAX_TODOS = 5;

const WEEKDAYS = ["måndag", "tisdag", "onsdag", "torsdag", "fredag", "lördag", "söndag"];

export interface BriefFactsInput {
  /** Dagens affärsdatum. "I går" är dagen före. */
  readonly today: IsoDate;
  /** Indata för gårdagen (period = i går). */
  readonly yesterday: ProfitabilityInput;
  /** Indata för samma veckodag veckan före, eller null. */
  readonly weekBefore: ProfitabilityInput | null;
  readonly machines: ReadonlyArray<{ id: string; name: string; code?: string | null }>;
  /** Punkterna i Att göra i visningsordning (loadRankedTodoStateFor). */
  readonly todos: ReadonlyArray<Pick<TodoItem, "title" | "level">>;
}

export interface BriefFacts {
  readonly datum: IsoDate;
  readonly veckodag: string;
  readonly igar: {
    readonly intakt: string;
    readonly vinst: string;
    readonly kop: number;
    /** Intäkten mot samma veckodag veckan före ("+12 %"), eller null utan jämförelse. */
    readonly motForraVeckan: string | null;
    readonly bastaAutomat: { readonly namn: string; readonly intakt: string } | null;
  };
  /** Det som brådskar (Att göra, nivå "nu"), viktigast först. */
  readonly fel: string[];
  /** Det som ska göras, viktigast först (de första punkterna i Att göra). */
  readonly gorIdag: string[];
  readonly attGora: { readonly totalt: number; readonly nu: number };
}

export interface BriefLines {
  readonly yesterday: string;
  readonly problem: string;
  readonly today: string;
}

const kr = (ore: number) => formatSek(ore / 100);

function weekdayOf(date: IsoDate): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return WEEKDAYS[(new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7]!;
}

const clean = (s: string) => s.replace(/\s+/g, " ").trim();

export function buildBriefFacts(input: BriefFactsInput): BriefFacts {
  const date = addDays(input.today, -1);
  const cur = keyMetrics(input.yesterday);
  const prev = input.weekBefore ? keyMetrics(input.weekBefore) : null;
  const change = prev && prev.orderCount > 0 ? changeBp(cur.revenueOre, prev.revenueOre) : null;

  const machineName = new Map(
    input.machines.map((m) => [m.id, m.code ? `${m.code} ${m.name}` : m.name]),
  );
  let best: { namn: string; intakt: string } | null = null;
  if (cur.orderCount > 0) {
    const rows = profitabilityViews(input.yesterday, ["machine"]).machine.rows.filter(
      (r) => r.kind === "item" && machineName.has(r.key),
    );
    const top = rows
      .map((r) => ({ key: r.key, ore: r.revenueOre + r.unpricedRevenueOre }))
      .sort((a, b) => b.ore - a.ore || (a.key < b.key ? -1 : 1))[0];
    // Bara när det finns fler än en automat att jämföra.
    if (top && top.ore > 0 && rows.length > 1) {
      best = { namn: machineName.get(top.key)!, intakt: kr(top.ore) };
    }
  }

  const todos = input.todos.map((t) => ({ title: clean(t.title), level: t.level }));
  return {
    datum: date,
    veckodag: weekdayOf(date),
    igar: {
      intakt: kr(cur.revenueOre),
      vinst: kr(cur.profitOre),
      kop: cur.orderCount,
      motForraVeckan: change === null ? null : formatDelta(change / 10_000),
      bastaAutomat: best,
    },
    fel: todos
      .filter((t) => t.level === "now")
      .slice(0, BRIEF_MAX_TODOS)
      .map((t) => t.title),
    gorIdag: todos.slice(0, BRIEF_MAX_TODOS).map((t) => t.title),
    attGora: { totalt: todos.length, nu: todos.filter((t) => t.level === "now").length },
  };
}

/** Punkt utan avslutande punkt, med stor bokstav först. */
function sentence(s: string): string {
  const t = clean(s).replace(/[.!]+$/, "");
  return t ? `${t.charAt(0).toUpperCase()}${t.slice(1)}.` : "";
}

/** De fasta raderna ur underlaget (används när modellens rad inte klarar kontrollen). */
export function fallbackLines(f: BriefFacts): BriefLines {
  const y = f.igar;
  const yesterday =
    y.kop === 0
      ? "Ingen försäljning i går."
      : `${y.intakt} på ${y.kop} köp, ${y.vinst} i vinst${
          y.motForraVeckan ? ` (${y.motForraVeckan} mot förra ${f.veckodag})` : ""
        }.`;
  const problem = f.fel[0] ? sentence(f.fel[0]) : "Inget akut.";
  const today = f.gorIdag[0] ? sentence(f.gorIdag[0]) : "Inget att göra.";
  return { yesterday, problem, today };
}

/**
 * Rådgivarens dagliga förslag på rätt sida: ett förslag om inköpspriser visas på
 * Inköpspriser, ett om påfyllning på Automater osv. Förslagen saknar sidfält, så sidan
 * väljs med nyckelord i titel, varför och åtgärd. Hem visar sitt eget förslag, annars det
 * viktigaste. Ren modul (testas i page-tips.test.ts).
 */

import type { RouteId } from "@/components/shell/nav";

/** Sidorna som visar en tipsrad. */
export const TIP_ROUTES = [
  "hem",
  "lonsamhet",
  "automater",
  "butiker",
  "inkopspriser",
  "ekonomi",
] as const satisfies readonly RouteId[];
export type TipRoute = (typeof TIP_ROUTES)[number];

export interface TipSource {
  readonly id: string;
  readonly rank: number;
  readonly title: string;
  readonly why: string;
  readonly action: string;
}

export interface PageTip {
  readonly id: string;
  readonly title: string;
  readonly why: string;
  readonly action: string;
  readonly route: TipRoute;
}

function fold(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

const RULES: ReadonlyArray<{ route: TipRoute; re: RegExp }> = [
  { route: "inkopspriser", re: /inkopspris|marginal|forlust|pris(et|er)?\b|hojt? priset/ },
  { route: "butiker", re: /butik(ens|er|en)?\b|andel|hyra|avtal|vinstdeln/ },
  {
    route: "automater",
    re: /fyll|pafyll|tar slut|slutsald|tom(t|ma)? fack|lager|automat|tyst|stillast/,
  },
  { route: "ekonomi", re: /bokfor|utbetal|moms|vmb|revisor/ },
  { route: "lonsamhet", re: /titel|titlar|flytta|byt ut|saljer bra|lonsam|vinst/ },
];

/** Sidan ett förslag hör till. */
export function tipRouteFor(tip: Pick<TipSource, "title" | "why" | "action">): TipRoute {
  const text = fold(`${tip.title} ${tip.action} ${tip.why}`);
  // Titeln och åtgärden väger tyngst: första regeln som träffar dem vinner.
  const head = fold(`${tip.title} ${tip.action}`);
  for (const r of RULES) if (r.re.test(head)) return r.route;
  for (const r of RULES) if (r.re.test(text)) return r.route;
  return "hem";
}

/**
 * Högst ett förslag per sida: det viktigaste (lägst rang) som hör till sidan. Hem får sitt
 * eget, annars det viktigaste av alla som inte redan visas på en annan sida.
 */
export function tipsByRoute(tips: readonly TipSource[]): Partial<Record<TipRoute, PageTip>> {
  const sorted = [...tips].sort((a, b) => a.rank - b.rank);
  const out: Partial<Record<TipRoute, PageTip>> = {};
  for (const t of sorted) {
    const route = tipRouteFor(t);
    if (!out[route]) out[route] = { id: t.id, title: t.title, why: t.why, action: t.action, route };
  }
  if (!out.hem && sorted[0]) {
    const t = sorted[0];
    out.hem = { id: t.id, title: t.title, why: t.why, action: t.action, route: "hem" };
  }
  return out;
}

/** Frågan i panelen när användaren vill prata om förslaget. */
export function tipQuestion(tip: Pick<PageTip, "title" | "action">): string {
  return `Berätta mer om förslaget "${tip.title}": ${tip.action}`.slice(0, 400);
}

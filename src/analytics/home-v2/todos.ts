/**
 * "Att göra" på Hem i V2 (byggplanen 2.2): punkterna som inte gäller en automat i drift.
 * Automaterna (påfyllning, tyst automat, larm om en automat) och prisråden står redan i
 * Kräver åtgärd, så de tas bort här. Utbetalningarna slås ihop till en rad. Det som saknas
 * hemma för dagens rutt står först ("Beställ …" / "Packa …", besöksplanens brist).
 *
 * Ren funktion. Ordningen: brist för rutten, sedan nivå (nu, snart, senare) och reglernas
 * egen ordning (brådska). Belopp följer bara med för ekonomiroller (`economy`).
 */

import type { TodoItem, TodoLevel } from "@/analytics/todos";

/** Punkter som gäller automater (står i Kräver åtgärd). */
export const MACHINE_TODO_KINDS: ReadonlySet<string> = new Set([
  "refill",
  "stale-machine",
  "price-advice",
]);

/** Utbetalningar till butikerna (en rad). */
export const PAYOUT_TODO_KINDS: ReadonlySet<string> = new Set([
  "settlement",
  "settlement-create",
  "settlement-drift",
]);

export interface HemTodoExtra {
  readonly key: string;
  readonly level: TodoLevel;
  readonly title: string;
  readonly href: string;
}

export interface HemTodoShort {
  readonly titleId: string;
  readonly titleName: string;
  readonly shortBy: number;
  /** Egen produkt (mystery pack): packas, annars beställs. */
  readonly own: boolean;
}

export interface HemTodo {
  readonly key: string;
  readonly level: TodoLevel;
  readonly title: string;
  readonly detail: string;
  readonly href: string;
  /** Knappens verb ("Packa", "Beställ", "Visa", "Öppna"). */
  readonly verb: string;
}

const LEVEL: Record<TodoLevel, number> = { now: 0, soon: 1, later: 2 };

/** Länken som sidan ska använda ("/x?y" eller "#…" blir en sökväg i appen). */
function href(link: string): string {
  return link.startsWith("/") ? link : `/${link.replace(/^#/, "")}`;
}

function verbOf(t: TodoItem): string {
  const label = t.action?.label?.trim();
  if (label) return label.split(" ")[0] ?? "Öppna";
  if (PAYOUT_TODO_KINDS.has(t.kind)) return "Visa";
  return "Öppna";
}

export function hemTodos(args: {
  readonly items: readonly TodoItem[];
  readonly extras?: readonly HemTodoExtra[];
  readonly short?: readonly HemTodoShort[];
  /** Rollen ser belopp: utbetalningsraden får summan. */
  readonly economy: boolean;
  /** Dagens rutts brist länkar hit (Vårt lager). */
  readonly stockHref?: string;
}): { rows: HemTodo[]; total: number } {
  const shortRows: HemTodo[] = (args.short ?? [])
    .filter((s) => s.shortBy > 0)
    .map((s) => ({
      key: `short:${s.titleId}`,
      level: "now" as const,
      title: `${s.own ? "Packa" : "Beställ"} ${s.titleName}.`,
      detail: `Rutten behöver ${s.shortBy} till än det som finns hemma.`,
      href: args.stockHref ?? "/vart-lager",
      verb: s.own ? "Packa" : "Beställ",
    }));

  const rest = args.items.filter(
    (t) =>
      !MACHINE_TODO_KINDS.has(t.kind) && !(t.kind === "alert" && t.evidence.machineIds.length > 0),
  );
  const payouts = rest.filter((t) => PAYOUT_TODO_KINDS.has(t.kind));
  const others = rest.filter((t) => !PAYOUT_TODO_KINDS.has(t.kind));

  const payoutRow: HemTodo[] =
    payouts.length === 0
      ? []
      : [
          {
            key: "payouts",
            level: payouts.reduce<TodoLevel>(
              (best, t) => (LEVEL[t.level] < LEVEL[best] ? t.level : best),
              "later",
            ),
            title:
              payouts.length === 1
                ? (payouts[0]?.title ?? "Betala butikerna.")
                : `Utbetalningar till butikerna: ${payouts.length} st.`,
            detail: payouts.length === 1 ? (payouts[0]?.detail ?? "") : "Se Butiker → Utbetalning.",
            href:
              payouts.length === 1
                ? href(payouts[0]?.link ?? "/butiker")
                : "/butiker?vy=utbetalning",
            verb: "Visa",
          },
        ];

  const ranked = [
    ...(args.extras ?? []).map((e, i) => ({
      row: { key: e.key, level: e.level, title: e.title, detail: "", href: e.href, verb: "Öppna" },
      i,
    })),
    ...payoutRow.map((row, i) => ({ row, i: 1_000 + i })),
    ...others.map((t, i) => ({
      row: {
        key: t.key,
        level: t.level,
        title: t.title,
        detail: t.detail,
        href: href(t.link),
        verb: verbOf(t),
      },
      i: 2_000 + i,
    })),
  ]
    .sort((a, b) => LEVEL[a.row.level] - LEVEL[b.row.level] || a.i - b.i)
    .map((x) => x.row);

  // Belopp i texten ("12 172 kr") tas bort för roller utan ekonomi (påfyllaren ser inte
  // utbetalningar alls, men texten kontrolleras ändå).
  const clean = (r: HemTodo): HemTodo =>
    args.economy
      ? r
      : {
          ...r,
          title: r.title.replace(/[\d  .,]+\s?kr\b/g, "").trim(),
          detail: r.detail.replace(/[\d  .,]+\s?kr\b/g, "").trim(),
        };
  const rows = [...shortRows, ...ranked].map(clean);
  return { rows, total: rows.length };
}

/**
 * Hems delar som serverkomponenter: Att göra, Värt att veta, topplistan och raden om
 * order utan inköpspris. Allt räknat i modellen; här bara uppställning och text.
 */

import Link from "next/link";
import type { ReactNode } from "react";

import { StatusGlyph, type Status } from "@/components/ui/status-tag";
import { cn } from "@/lib/cn";
import { NBSP, formatInt } from "@/lib/format";

import type { HomeInsight, HomeLostSales, HomeTodo, HomeTopTitles, HomeUnpriced } from "./model";
import { shareText, unpricedShareText } from "./model";
import { kr } from "./text";

// ---------------------------------------------------------------------------
// Gemensamt
// ---------------------------------------------------------------------------

/** Länk med verbet först och pil, i mono (åtgärd eller vägen till underlaget). */
export function ArrowLink({
  href,
  children,
  className,
}: {
  href: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Link
      href={href}
      className={cn(
        "meta inline-flex min-h-7 items-center gap-1.5 rounded-xs text-muted underline-offset-4 transition-colors hover:text-fg hover:underline",
        className,
      )}
    >
      <span>{children}</span>
      <span aria-hidden className="text-subtle">
        →
      </span>
    </Link>
  );
}

// ---------------------------------------------------------------------------
// Att göra
// ---------------------------------------------------------------------------

const LEVEL_TEXT: Record<HomeTodo["level"], string> = {
  now: "Nu",
  soon: "Snart",
  later: "Senare",
};

/**
 * De viktigaste punkterna i Att göra. Bara den första punkten som gäller nu får
 * signalglyfen (en markering per lista); övriga "nu" får varningsglyfen och texten "Nu".
 */
export function TodoList({ todos }: { todos: HomeTodo[] }) {
  const firstNow = todos.findIndex((t) => t.level === "now");
  return (
    <ol className="flex flex-col border-t border-line">
      {todos.map((t, i) => {
        const status: Status =
          t.level === "now"
            ? i === firstNow
              ? "critical"
              : "warning"
            : t.level === "soon"
              ? "warning"
              : "neutral";
        return (
          <li key={t.key} className="border-b border-line">
            <Link
              href={t.href}
              className="group grid grid-cols-[3.5rem_minmax(0,1fr)] gap-x-3 gap-y-1 rounded-xs py-4 transition-colors hover:bg-hover sm:grid-cols-[4.5rem_minmax(0,1fr)_auto]"
            >
              <span className="label row-span-2 flex items-start gap-1.5 pt-1 text-fg">
                <span className="inline-flex h-4 w-2 items-center">
                  <StatusGlyph status={status} />
                </span>
                {status === "critical" ? <span className="sr-only">Kräver åtgärd: </span> : null}
                {LEVEL_TEXT[t.level]}
              </span>
              <span className="text-base font-medium text-balance text-fg">{t.title}</span>
              <span
                aria-hidden
                className="meta hidden self-start pt-0.5 text-subtle transition-colors group-hover:text-fg sm:row-span-2 sm:block"
              >
                →
              </span>
              <span className="col-start-2 text-sm text-muted">
                {t.detail}
                {t.orgWide ? (
                  <span className="meta mt-1 block text-subtle">Gäller hela organisationen</span>
                ) : null}
              </span>
            </Link>
          </li>
        );
      })}
    </ol>
  );
}

// ---------------------------------------------------------------------------
// Värt att veta
// ---------------------------------------------------------------------------

function ToneGlyph({ tone }: { tone: HomeInsight["tone"] }) {
  if (tone === "neutral") {
    return (
      <svg width="8" height="8" viewBox="0 0 8 8" aria-hidden className="shrink-0">
        <rect x="2" y="2" width="4" height="4" fill="currentColor" />
      </svg>
    );
  }
  return (
    <svg width="8" height="8" viewBox="0 0 8 8" aria-hidden className="shrink-0">
      <path
        d={tone === "positive" ? "M4 0.5 L7.5 7 L0.5 7Z" : "M4 7.5 L7.5 1 L0.5 1Z"}
        fill="currentColor"
      />
    </svg>
  );
}

const TONE_TEXT: Record<HomeInsight["tone"], string> = {
  positive: "Bra nyhet: ",
  negative: "Sämre nyhet: ",
  neutral: "",
};

/** Iakttagelserna: mening i fg, talen bakom i grått, och länken till underlaget. */
export function InsightList({ insights }: { insights: HomeInsight[] }) {
  return (
    <ul className="flex flex-col border-t border-line">
      {insights.map((n) => (
        <li key={n.key} className="border-b border-line">
          <Link
            href={n.href}
            className="group grid grid-cols-[1rem_minmax(0,1fr)] gap-x-2 gap-y-1 rounded-xs py-4 transition-colors hover:bg-hover"
          >
            <span className="flex h-6 items-center text-fg">
              <ToneGlyph tone={n.tone} />
            </span>
            <span className="text-base font-medium text-balance text-fg">
              <span className="sr-only">{TONE_TEXT[n.tone]}</span>
              {sentenceOf(n.text)}
            </span>
            <span className="col-start-2 text-sm text-muted">{n.detail}</span>
            <span className="meta col-start-2 mt-1 inline-flex items-center gap-1.5 text-subtle transition-colors group-hover:text-fg">
              Visa underlaget <span aria-hidden>→</span>
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

function sentenceOf(text: string): string {
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

// ---------------------------------------------------------------------------
// Topplistan
// ---------------------------------------------------------------------------

/**
 * Ordertitlarna efter intäkt, med andel av periodens intäkt som 4 px stapel. Störst i fg,
 * övriga i mellangrå. Titlar utan inköpspris får en streckad markering ("ingår inte i
 * vinsten"), inte signal: signalen bärs av nyckeltalet Vinst.
 */
export function TopTitles({ top, caption }: { top: HomeTopTitles; caption: string }) {
  const rows = [
    ...top.rows.map((r, i) => ({
      ...r,
      rank: i + 1,
      rest: false,
      note: r.unpriced ? "utan inköpspris, ingår inte i vinsten" : null,
    })),
    ...(top.rest
      ? [
          {
            id: "rest",
            name: `Övriga ${formatInt(top.rest.titles)} titlar`,
            orders: top.rest.orders,
            revenueOre: top.rest.revenueOre,
            shareBp: top.rest.shareBp,
            unpriced: top.rest.unpricedTitles > 0,
            rank: null,
            rest: true,
            note:
              top.rest.unpricedTitles > 0
                ? `varav ${formatInt(top.rest.unpricedTitles)} utan inköpspris, ingår inte i vinsten`
                : null,
          },
        ]
      : []),
  ];
  return (
    <table className="w-full table-fixed border-collapse">
      <caption className="sr-only">{caption}</caption>
      <thead>
        <tr className="border-b border-line-strong">
          <th scope="col" className="label w-8 py-2 text-left font-normal text-subtle">
            <span className="sr-only">Plats</span>
            <span aria-hidden>#</span>
          </th>
          <th scope="col" className="label py-2 text-left font-normal text-subtle">
            Titel
          </th>
          <th
            scope="col"
            className="label hidden w-20 py-2 text-right font-normal text-subtle sm:table-cell"
          >
            Order
          </th>
          <th scope="col" className="label w-24 py-2 text-right font-normal text-subtle">
            Intäkt
          </th>
          <th scope="col" className="label w-16 py-2 text-right font-normal text-subtle">
            Andel
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => {
          const emph = i === 0 && !r.rest;
          return (
            <tr key={r.id} className="border-b border-line last:border-b-0">
              <td className="meta tnum py-3 align-top text-subtle">
                {r.rank === null ? "" : String(r.rank).padStart(2, "0")}
              </td>
              <td className="py-3 pr-4 align-top">
                <span
                  className={cn(
                    "block truncate text-sm",
                    emph ? "text-fg" : "text-muted",
                    r.rest && "text-subtle",
                  )}
                >
                  {r.name}
                </span>
                <span className="mt-2 flex items-center gap-3">
                  <span aria-hidden className="relative h-1 min-w-0 flex-1 bg-line">
                    <span
                      className={cn(
                        "absolute inset-y-0 left-0",
                        emph ? "bg-data-1" : "bg-data-3",
                        r.unpriced &&
                          !r.rest &&
                          "border border-dashed border-data-1 bg-transparent",
                      )}
                      style={{ width: `${Math.max(0.5, r.shareBp / 100)}%` }}
                    />
                  </span>
                </span>
                {r.note ? <span className="meta mt-1.5 block text-subtle">{r.note}</span> : null}
                <span className="meta mt-1 block text-subtle sm:hidden">
                  {formatInt(r.orders)}
                  {NBSP}order
                </span>
              </td>
              <td className="tnum hidden py-3 text-right align-top text-sm text-muted sm:table-cell">
                {formatInt(r.orders)}
              </td>
              <td className="tnum py-3 text-right align-top text-sm text-muted">
                {kr(r.revenueOre)}
              </td>
              <td
                className={cn(
                  "tnum py-3 text-right align-top text-sm",
                  emph ? "font-medium text-fg" : "text-muted",
                )}
              >
                {shareText(r.shareBp)}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

// ---------------------------------------------------------------------------
// Order utan inköpspris
// ---------------------------------------------------------------------------

function listNames(names: string[], max = 3): string {
  const shown = names.slice(0, max);
  const rest = names.length - shown.length;
  if (rest > 0) return `${shown.join(", ")} och ${formatInt(rest)} till`;
  if (shown.length <= 1) return shown.join("");
  return `${shown.slice(0, -1).join(", ")} och ${shown[shown.length - 1]}`;
}

/**
 * Raden under nyckeltalen: vinsten räknar inte med order utan inköpspris. Andel, antal,
 * vilka titlar och länken dit priset läggs in. Markeringen (signal) sitter på nyckeltalet.
 */
export function UnpricedNote({ unpriced, canEdit }: { unpriced: HomeUnpriced; canEdit: boolean }) {
  const titles = listNames(unpriced.titles.map((t) => t.name));
  return (
    <p className="flex flex-col gap-1 text-sm text-muted sm:flex-row sm:flex-wrap sm:items-baseline sm:gap-x-3">
      <span>
        Vinsten räknar inte med {formatInt(unpriced.orders)}
        {NBSP}
        order ({unpricedShareText(unpriced.shareBp)} av intäkten, {kr(unpriced.revenueOre)}) som
        saknar inköpspris: {titles}.
      </span>
      <ArrowLink href={unpriced.href}>
        {canEdit ? "Lägg in inköpspris" : "Visa inköpspriser"}
      </ArrowLink>
    </p>
  );
}

/**
 * Förlorad försäljning i perioden (Prognos & inköp): "Slutsålt kostade ca 3 200 kr i
 * oktober." med hur många titlar som är slut just nu och länken till underlaget.
 */
export function LostSalesNote({ lost }: { lost: HomeLostSales }) {
  return (
    <p className="flex flex-col gap-1 text-sm text-muted sm:flex-row sm:flex-wrap sm:items-baseline sm:gap-x-3">
      <span>
        <span className="text-fg">{lost.text}</span>
        {lost.ongoing > 0
          ? ` ${formatInt(lost.ongoing)}${NBSP}${lost.ongoing === 1 ? "titel är" : "titlar är"} slut i en automat just nu.`
          : null}
      </span>
      <ArrowLink href={lost.href}>Förlorad försäljning</ArrowLink>
    </p>
  );
}

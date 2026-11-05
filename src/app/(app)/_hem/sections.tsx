/**
 * Hems delar som serverkomponenter: Att göra, Värt att veta, topplistan och raden om
 * order utan inköpspris. Allt räknat i modellen; här bara uppställning och text.
 */

import Link from "next/link";
import type { CSSProperties, ReactNode } from "react";

import { StatusGlyph, type Status } from "@/components/ui/status-tag";
import { cn } from "@/lib/cn";
import { NBSP, formatInt } from "@/lib/format";

import type {
  HomeInsight,
  HomeLostSales,
  HomeStaleImport,
  HomeTodo,
  HomeTopTitles,
  HomeUnpriced,
} from "./model";
import { shareText, unpricedShareText } from "./model";
import { dayText, kr } from "./text";

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
        "meta inline-flex min-h-7 items-center gap-1.5 rounded-xs text-muted underline-offset-4 transition-colors hover:text-fg hover:underline max-md:min-h-11",
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
export function TodoList({
  todos,
  phoneKeys,
}: {
  todos: HomeTodo[];
  /** Under md syns bara dessa punkter (todo-phone.ts); utan: alla. */
  phoneKeys?: ReadonlySet<string>;
}) {
  const firstNow = todos.findIndex((t) => t.level === "now");
  return (
    <ol
      className={cn(
        "flex flex-col border-t border-line",
        phoneKeys && phoneKeys.size === 0 && "max-md:hidden",
      )}
    >
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
          <li
            key={t.key}
            className={cn(
              "rise border-b border-line",
              phoneKeys && !phoneKeys.has(t.key) && "max-md:hidden",
            )}
            style={{ "--i": i + 5 } as CSSProperties}
          >
            <Link
              href={t.href}
              title={t.detail}
              className="group lift grid min-h-11 grid-cols-[3.5rem_minmax(0,1fr)] gap-x-3 gap-y-1 rounded-xs py-3 hover:bg-hover sm:grid-cols-[4.5rem_minmax(0,1fr)_auto]"
            >
              <span className="label flex items-start gap-1.5 pt-1 text-fg">
                <span className="inline-flex h-4 w-2 items-center">
                  <StatusGlyph status={status} />
                </span>
                {status === "critical" ? <span className="sr-only">Kräver åtgärd: </span> : null}
                {LEVEL_TEXT[t.level]}
              </span>
              <span className="text-base font-medium text-balance text-fg">{t.title}</span>
              <span
                aria-hidden
                className="meta hidden self-start pt-0.5 text-subtle transition-colors group-hover:text-fg sm:block"
              >
                →
              </span>
              {t.orgWide ? (
                <span className="meta col-start-2 text-subtle">Hela företaget</span>
              ) : null}
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
export function InsightList({
  insights,
  phoneLimit,
}: {
  insights: HomeInsight[];
  /** Under md: bara de första iakttagelserna. */
  phoneLimit?: number;
}) {
  return (
    <ul className="flex flex-col border-t border-line">
      {insights.map((n, i) => (
        <li
          key={n.key}
          className={cn(
            "rise border-b border-line",
            phoneLimit !== undefined && i >= phoneLimit && "max-md:hidden",
          )}
          style={{ "--i": i + 6 } as CSSProperties}
        >
          <Link
            href={n.href}
            className="group lift grid grid-cols-[1rem_minmax(0,1fr)] gap-x-2 gap-y-1 rounded-xs py-3 hover:bg-hover"
          >
            <span className="flex h-6 items-center text-fg">
              <ToneGlyph tone={n.tone} />
            </span>
            <span className="text-base font-medium text-balance text-fg">
              <span className="sr-only">{TONE_TEXT[n.tone]}</span>
              {sentenceOf(n.text)}
            </span>
            <span className="col-start-2 text-sm text-muted">
              {n.detail}{" "}
              <span aria-hidden className="text-subtle transition-colors group-hover:text-fg">
                →
              </span>
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
export function TopTitles({
  top,
  caption,
  phoneLimit,
}: {
  top: HomeTopTitles;
  caption: string;
  /** Under md: bara de första raderna (resten nås via "Alla titlar"). */
  phoneLimit?: number;
}) {
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
                ? `Varav ${formatInt(top.rest.unpricedTitles)} utan inköpspris, som inte ingår i vinsten.`
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
            <tr
              key={r.id}
              className={cn(
                "border-b border-line last:border-b-0",
                phoneLimit !== undefined && i >= phoneLimit && "max-md:hidden",
                phoneLimit !== undefined && i === phoneLimit - 1 && "max-md:border-b-0",
              )}
            >
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
                {r.note ? <span className="mt-1.5 block text-xs text-subtle">{r.note}</span> : null}
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
// Varningsraden under nyckeltalen
// ---------------------------------------------------------------------------

/**
 * En rad under nyckeltalen: inaktuell import (först, eftersom den gör alla tal ofullständiga),
 * titlar utan inköpspris (vinsten räknar inte med dem) och förlorad försäljning, var och en
 * med sin länk. Markeringen (signal) sitter på nyckeltalet.
 */
export function WarningLine({
  unpriced,
  lost,
  stale = null,
  today,
  canEdit,
}: {
  unpriced: HomeUnpriced | null;
  lost: HomeLostSales | null;
  stale?: HomeStaleImport | null;
  today: string;
  canEdit: boolean;
}) {
  if (!unpriced && !lost && !stale) return null;
  const n = unpriced?.titles.length ?? 0;
  return (
    <p className="flex flex-col gap-1 text-sm text-muted sm:flex-row sm:flex-wrap sm:items-baseline sm:gap-x-6">
      {stale ? <StaleImportText stale={stale} today={today} canEdit={canEdit} /> : null}
      {unpriced ? (
        <span className="inline-flex flex-wrap items-baseline gap-x-3">
          <span>
            {formatInt(n)}
            {NBSP}
            {n === 1 ? "titel" : "titlar"} utan inköpspris ({unpricedShareText(unpriced.shareBp)}).
          </span>
          <ArrowLink href={unpriced.href}>{canEdit ? "Lägg in pris" : "Visa priser"}</ArrowLink>
        </span>
      ) : null}
      {lost ? (
        <span className="inline-flex flex-wrap items-baseline gap-x-3">
          <span className="text-fg">{lost.text}</span>
          <ArrowLink href={lost.href}>Visa</ArrowLink>
        </span>
      ) : null}
    </p>
  );
}

// ---------------------------------------------------------------------------
// Inaktuell import (Hem och Lönsamhet)
// ---------------------------------------------------------------------------

function StaleImportText({
  stale,
  today,
  canEdit,
}: {
  stale: HomeStaleImport;
  today: string;
  canEdit: boolean;
}) {
  return (
    <span className="inline-flex flex-wrap items-baseline gap-x-3">
      <span className="text-fg">{`Senast hämtat från Awish ${dayText(stale.date, today)}`}</span>
      {canEdit ? <ArrowLink href="/datakallor">Kolla Awish</ArrowLink> : null}
    </span>
  );
}

/** Varningen om inaktuell import som egen rad (Lönsamhet). */
export function StaleImportLine(props: {
  stale: HomeStaleImport;
  today: string;
  canEdit: boolean;
}) {
  return (
    <p className="text-sm text-muted">
      <StaleImportText {...props} />
    </p>
  );
}

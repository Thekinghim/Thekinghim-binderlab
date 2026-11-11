import Link from "next/link";
import type { CSSProperties } from "react";

import type { IsoDate } from "@/domain";
import type { Formatters, Messages } from "@/i18n";

import type { SalesFigures } from "../../forsaljning/_lib/model";
import { trendOf, weekWords, type WeeklySummary } from "../_lib/model";

function dateOf(date: IsoDate): Date {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(y, m - 1, d, 12);
}

const rise = (i: number) => ({ "--i": i }) as CSSProperties;

/**
 * Veckosammanfattningen som en kort skärm: förra veckan överst (sålt och vinst, stort), sedan
 * skillnaden mot veckan innan, bästa produkten och Att göra. På personens språk. Används på
 * sidan Veckan och överst på Försäljning i den enkla vyn (dit måndagens notis leder).
 *
 * `today`: dagens affärsdatum. Bara veckan före den som pågår kallas "Förra veckan"; en äldre
 * vecka (notisen öppnad senare) kallas "Den veckan".
 *
 * Att göra visas bara när `summary.todos` är satt (aldrig i den enkla vyn, som inte har
 * listan). `todoHref`: länken dit.
 * `closeHref`: "Stäng" (enkel vy) eller "Till Hem".
 */
export function WeekSummary({
  summary,
  today,
  t,
  f,
  headingLevel = "h1",
  todoHref = null,
  close,
}: {
  summary: WeeklySummary;
  today: IsoDate;
  t: Messages;
  f: Formatters;
  headingLevel?: "h1" | "h2";
  todoHref?: string | null;
  close: { href: string; label: string };
}) {
  const last = summary.lastFigures;
  const prev = summary.previousFigures;
  const range = (p: { start: IsoDate; end: IsoDate }) =>
    t.week.range(
      f.date(dateOf(p.start), { year: "never" }),
      f.date(dateOf(p.end), { year: "never" }),
    );
  const packs = trendOf(last.packs, prev.packs);
  const profit = trendOf(last.profitOre, prev.profitOre);
  const packsLine =
    packs === "up"
      ? t.week.packsMore(last.packs - prev.packs)
      : packs === "down"
        ? t.week.packsFewer(prev.packs - last.packs)
        : t.week.packsSame;
  const profitLine =
    profit === "up"
      ? t.week.profitMore(f.sek((last.profitOre - prev.profitOre) / 100))
      : profit === "down"
        ? t.week.profitLess(f.sek((prev.profitOre - last.profitOre) / 100))
        : t.week.profitSame;
  const Heading = headingLevel;
  const words = weekWords(t, summary.week, today);
  const compared = last.packs > 0 || prev.packs > 0;

  return (
    <section aria-labelledby="veckan" className="flex flex-col gap-4" data-week={summary.week}>
      <header className="rise flex flex-col gap-2" style={rise(0)}>
        <p className="label text-subtle">{`${t.week.title} · ${range(summary.last)}`}</p>
        <Heading id="veckan" className="text-3xl font-medium text-balance text-fg">
          {last.packs === 0
            ? words.headlineNone
            : t.week.headline(last.packs, f.sek(last.profitOre / 100))}
        </Heading>
      </header>

      <div className="rise" style={rise(1)}>
        <WeekCard label={words.label} figures={last} t={t} f={f} strong>
          {compared ? (
            <ul className="flex flex-col gap-1 border-t border-line pt-3 text-base">
              <li
                className={
                  packs === "up" ? "text-up" : packs === "down" ? "text-signal-fg" : "text-muted"
                }
              >
                {packsLine}
              </li>
              <li
                className={
                  profit === "up" ? "text-up" : profit === "down" ? "text-signal-fg" : "text-muted"
                }
              >
                {profitLine}
              </li>
            </ul>
          ) : null}
        </WeekCard>
      </div>

      <div className="rise" style={rise(2)}>
        <WeekCard
          label={`${t.week.weekBefore} · ${range(summary.previous)}`}
          figures={prev}
          t={t}
          f={f}
        />
      </div>

      <section
        aria-label={t.week.best}
        className="rise flex flex-col gap-2 rounded-md border border-line-strong bg-surface p-4"
        style={rise(3)}
      >
        <p className="label text-subtle">{t.week.best}</p>
        {summary.best ? (
          <>
            <p className="text-lg font-medium [overflow-wrap:anywhere] text-fg">
              {summary.best.name}
            </p>
            <p className="tnum text-base text-muted">
              {`${t.common.packs(summary.best.packs)} · ${
                summary.best.profitOre === null
                  ? t.week.bestNoPrice
                  : t.week.bestProfit(f.sek(summary.best.profitOre / 100))
              }`}
            </p>
          </>
        ) : (
          <p className="text-base text-muted">{t.week.noBest}</p>
        )}
      </section>

      {summary.todos !== null ? (
        <section
          aria-label={t.week.todos}
          className="rise flex flex-col gap-2 rounded-md border border-line-strong bg-surface p-4"
          style={rise(4)}
        >
          <p className="label text-subtle">{t.week.todos}</p>
          <p className="tnum text-lg font-medium text-fg">
            {summary.todos > 0 ? t.week.todosCount(summary.todos) : t.week.todosNone}
          </p>
          {todoHref && summary.todos > 0 ? (
            <Link
              href={todoHref}
              className="inline-flex min-h-11 items-center self-start rounded-md border border-line-strong bg-raised px-4 text-md font-medium text-fg active:bg-hover"
            >
              {t.week.todosOpen}
            </Link>
          ) : null}
        </section>
      ) : null}

      <p className="meta text-subtle">
        {t.week.profitHint}
        {last.unpriced > 0 ? ` ${t.sales.unpriced(last.unpriced)}` : ""}
      </p>

      <Link
        href={close.href}
        className="inline-flex min-h-12 items-center justify-center rounded-md border border-line-strong bg-surface px-4 text-lg font-medium text-fg active:bg-hover"
      >
        {close.label}
      </Link>
    </section>
  );
}

function WeekCard({
  label,
  figures,
  t,
  f,
  strong = false,
  children,
}: {
  label: string;
  figures: SalesFigures;
  t: Messages;
  f: Formatters;
  strong?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <section
      aria-label={label}
      className="flex flex-col gap-3 rounded-md border border-line-strong bg-surface p-4"
    >
      <p className="label text-subtle">{label}</p>
      {figures.packs === 0 ? (
        <p className="text-lg text-muted">{t.week.noSales}</p>
      ) : (
        <dl className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-4 gap-y-2">
          <dt className="text-base text-muted">{t.week.sold}</dt>
          <dd className="tnum text-right text-lg text-fg">{t.common.packs(figures.packs)}</dd>
          <dt className="text-base text-muted">{t.week.profit}</dt>
          <dd
            className={
              strong
                ? "tnum text-right text-2xl font-medium text-fg"
                : "tnum text-right text-lg text-fg"
            }
          >
            {f.sek(figures.profitOre / 100)}
          </dd>
        </dl>
      )}
      {children}
    </section>
  );
}

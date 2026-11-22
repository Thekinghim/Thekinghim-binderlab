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

/** Det gamla utseendet (den enkla vyn på Försäljning). */
const OLD_CLASSES = {
  header: "rise flex flex-col gap-2",
  eyebrow: "label text-subtle",
  headline: "text-3xl font-medium text-balance text-fg",
  compare: "flex flex-col gap-1 border-t border-line pt-3 text-base",
  up: "text-up",
  down: "text-signal-fg",
  same: "text-muted",
  card: "rise flex flex-col gap-2 rounded-md border border-line-strong bg-surface p-4",
  weekCard: "flex flex-col gap-3 rounded-md border border-line-strong bg-surface p-4",
  label: "label text-subtle",
  big: "tnum text-lg font-medium [overflow-wrap:anywhere] text-fg",
  text: "tnum text-base text-muted",
  empty: "text-lg text-muted",
  todoLink:
    "inline-flex min-h-11 items-center self-start rounded-md border border-line-strong bg-raised px-4 text-md font-medium text-fg active:bg-hover",
  hint: "meta text-subtle",
  close:
    "inline-flex min-h-12 items-center justify-center rounded-md border border-line-strong bg-surface px-4 text-lg font-medium text-fg active:bg-hover",
  dt: "text-base text-muted",
  dd: "tnum text-right text-lg text-fg",
  ddStrong: "tnum text-right text-2xl font-medium text-fg",
};

/** V2 (sidan Veckan): vita kort med 1 px kant, 14 px etiketter i gemener, V2-knappar. */
const V2_CLASSES: typeof OLD_CLASSES = {
  header: "flex flex-col gap-1 px-0.5",
  eyebrow: "text-v2-sm text-v2-mute",
  headline: "text-v2-xl font-[650] text-balance text-v2-ink",
  compare: "flex flex-col gap-1 border-t border-v2-line2 pt-3 text-v2-sm font-[550]",
  up: "text-v2-profit-text",
  down: "text-v2-crit-text",
  same: "text-v2-mute",
  card: "v2-card flex flex-col gap-1.5 px-[18px] py-4",
  weekCard: "v2-card flex flex-col gap-3 px-[18px] py-4",
  label: "text-v2-sm font-[650] text-v2-ink",
  big: "tnum text-v2-lg font-[650] [overflow-wrap:anywhere] text-v2-ink",
  text: "tnum text-v2-sm text-v2-mute",
  empty: "text-v2-sm text-v2-mute",
  todoLink: "v2-btn touch mt-1 self-start",
  hint: "px-0.5 text-v2-xs text-v2-mute",
  close: "v2-btn lg w-full",
  dt: "text-v2-sm text-v2-mute",
  dd: "tnum text-right text-v2-md font-[550] text-v2-ink",
  ddStrong: "tnum text-right text-v2-2xl font-[650] text-v2-ink",
};

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
  v2 = false,
}: {
  summary: WeeklySummary;
  today: IsoDate;
  t: Messages;
  f: Formatters;
  headingLevel?: "h1" | "h2";
  todoHref?: string | null;
  close: { href: string; label: string };
  /** V2-utseende (sidan Veckan i V2-skalet): kort, 14 px rubriker, V2-knappar. Den enkla vyn
   * (Försäljning) har det gamla. */
  v2?: boolean;
}) {
  const c = v2 ? V2_CLASSES : OLD_CLASSES;
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
    <section
      aria-labelledby="veckan"
      className={v2 ? "flex flex-col gap-3.5" : "flex flex-col gap-4"}
      data-week={summary.week}
    >
      <header className={c.header} style={rise(0)}>
        <p className={c.eyebrow}>{`${t.week.title} · ${range(summary.last)}`}</p>
        <Heading id="veckan" className={c.headline}>
          {last.packs === 0
            ? words.headlineNone
            : t.week.headline(last.packs, f.sek(last.profitOre / 100))}
        </Heading>
      </header>

      <div className="rise" style={rise(1)}>
        <WeekCard label={words.label} figures={last} t={t} f={f} strong v2={v2}>
          {compared ? (
            <ul className={c.compare}>
              <li className={packs === "up" ? c.up : packs === "down" ? c.down : c.same}>
                {packsLine}
              </li>
              <li className={profit === "up" ? c.up : profit === "down" ? c.down : c.same}>
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
          v2={v2}
        />
      </div>

      <section aria-label={t.week.best} className={c.card} style={rise(3)}>
        <p className={c.label}>{t.week.best}</p>
        {summary.best ? (
          <>
            <p className={c.big}>{summary.best.name}</p>
            <p className={c.text}>
              {`${t.common.packs(summary.best.packs)} · ${
                summary.best.profitOre === null
                  ? t.week.bestNoPrice
                  : t.week.bestProfit(f.sek(summary.best.profitOre / 100))
              }`}
            </p>
          </>
        ) : (
          <p className={c.text}>{t.week.noBest}</p>
        )}
      </section>

      {summary.todos !== null ? (
        <section aria-label={t.week.todos} className={c.card} style={rise(4)}>
          <p className={c.label}>{t.week.todos}</p>
          <p className={c.big}>
            {summary.todos > 0 ? t.week.todosCount(summary.todos) : t.week.todosNone}
          </p>
          {todoHref && summary.todos > 0 ? (
            <Link href={todoHref} className={c.todoLink}>
              {t.week.todosOpen}
            </Link>
          ) : null}
        </section>
      ) : null}

      <p className={c.hint}>
        {t.week.profitHint}
        {last.unpriced > 0 ? ` ${t.sales.unpriced(last.unpriced)}` : ""}
      </p>

      <Link href={close.href} className={c.close}>
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
  v2 = false,
  children,
}: {
  label: string;
  figures: SalesFigures;
  t: Messages;
  f: Formatters;
  strong?: boolean;
  v2?: boolean;
  children?: React.ReactNode;
}) {
  const c = v2 ? V2_CLASSES : OLD_CLASSES;
  return (
    <section aria-label={label} className={c.weekCard}>
      <p className={c.label}>{label}</p>
      {figures.packs === 0 ? (
        <p className={c.empty}>{t.week.noSales}</p>
      ) : (
        <dl className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-4 gap-y-2">
          <dt className={c.dt}>{t.week.sold}</dt>
          <dd className={c.dd}>{t.common.packs(figures.packs)}</dd>
          <dt className={c.dt}>{t.week.profit}</dt>
          <dd className={strong ? c.ddStrong : c.dd}>{f.sek(figures.profitOre / 100)}</dd>
        </dl>
      )}
      {children}
    </section>
  );
}

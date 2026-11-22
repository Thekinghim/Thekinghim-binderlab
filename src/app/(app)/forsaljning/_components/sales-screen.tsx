import type { CSSProperties } from "react";

import { profitabilityViews } from "@/domain";
import { formatters, messages, type Formatters, type Messages } from "@/i18n";
import { loadDomainInput, requireViewer, type AppContext } from "@/server/data/core";
import { loadWeeklySummaryFor } from "@/server/weekly/summary";

import { Card } from "@/components/v2/card";
import { PAGE_BODY, PageIntro } from "@/components/v2/page-intro";

import { productProfits } from "../../_enkel/model";
import { PageHead } from "../../vart-lager/_components/page-head";
import { WeekSummary } from "../../veckan/_components/week-summary";
import { weekFromParam } from "../../veckan/_lib/model";
import { daysIn, figuresOf, machineSales, salesPeriods, type SalesFigures } from "../_lib/model";

/** En rad i korten Per automat och Vinst per produkt (V2). */
const ROW =
  "flex min-h-14 items-center justify-between gap-3 border-b border-v2-line2 px-[18px] py-2.5 last:border-b-0";

/**
 * Försäljningen i den enkla vyn: sålt och tjänat i dag, den här veckan och den här månaden,
 * per automat och vinst per produkt den här månaden. Inget annat: inga filter, inga
 * perioder, ingen knapp för butikernas andel. Vinsten är vår vinst före butikernas andel
 * (står i rubriken), även per produkt. Bara för roller som ser ekonomi (sidan kontrollerar
 * det innan).
 */
export async function SalesScreen({
  ctx,
  week: weekParam,
  closeHref = "/",
  v2 = false,
}: {
  ctx: AppContext;
  /** ?vecka=ÅÅÅÅ-MM-DD (måndagens notis): veckosammanfattningen visas överst. */
  week?: string | string[];
  /** Sidan utan sammanfattningen ("Stäng"). */
  closeHref?: string;
  /**
   * I V2-skalet (/forsaljning i full vy): rubrikraden, ett KPI-band och kort som de andra
   * V2-sidorna. Utan (Enkel vy, eget skal): de stora korten som förut.
   */
  v2?: boolean;
}) {
  const t = messages(ctx.locale);
  const f = formatters(ctx.locale);
  const p = salesPeriods(ctx.today);
  // Veckosammanfattningen räknas parallellt med resten (egen läsning av de två veckorna).
  // Bara siffrorna: Att göra finns inte i den enkla vyn och visas inte här.
  const weeklyP =
    weekParam !== undefined
      ? requireViewer().then((viewer) =>
          loadWeeklySummaryFor(viewer, weekFromParam(weekParam, ctx.today), new Date(ctx.now)),
        )
      : null;
  weeklyP?.catch(() => {});

  // En läsning för allt (veckan kan börja förra månaden), utan butikernas andel.
  const input = await loadDomainInput({
    period: p.all,
    compare: null,
    storeId: null,
    machineId: null,
    storeShare: false,
  });
  const views = profitabilityViews(input.current, ["day"]);
  const days = views.day.rows.filter((r) => r.kind === "time");
  const today = figuresOf(daysIn(days, p.today));
  const week = figuresOf(daysIn(days, p.week));
  const month = figuresOf(daysIn(days, p.month));

  // Per automat: bara månadens dagar (en egen beräkning på månadens order).
  const monthOrders = input.current.orders.filter(
    (o) => o.businessDate >= p.month.start && o.businessDate <= p.month.end,
  );
  const monthViews = profitabilityViews(
    { ...input.current, orders: monthOrders, period: p.month },
    ["machine", "title"],
  );
  const perMachine = machineSales(
    monthViews.machine.rows.filter((r) => r.kind === "item"),
    input.machines,
  );
  // Vinst per produkt (som Lönsamhet per titel), alltid före butikernas andel.
  const perProduct = productProfits(monthViews.title.rows, input.titles);
  const unpriced = month.unpriced;
  const weekly = weeklyP ? await weeklyP : null;

  if (v2) {
    const periods = [
      ["today", t.sales.today, today],
      ["week", t.sales.week, week],
      ["month", t.sales.month, month],
    ] as const;
    return (
      <div className={PAGE_BODY}>
        {weekly ? (
          <WeekSummary
            summary={weekly}
            today={ctx.today}
            t={t}
            f={f}
            headingLevel="h2"
            close={{ href: closeHref, label: t.week.close }}
          />
        ) : null}
        <PageIntro
          title={t.sales.headline(f.sek(today.salesOre / 100))}
          aside={t.sales.revenueHint}
        />
        <div className="v2-band-wrap">
          <ul
            className="v2-band"
            style={{ "--cols": 3 } as CSSProperties}
            aria-label={t.sales.title}
          >
            {periods.map(([key, label, fig]) => (
              <li key={key} className="v2-kt pb-3.5" aria-label={label}>
                <span className="kl">{label}</span>
                {fig.packs === 0 ? (
                  <span className="kn text-v2-mute">{t.sales.noSales}</span>
                ) : (
                  <>
                    <span className="kn tnum">{f.sek(fig.profitOre / 100)}</span>
                    <span className="kd">
                      <span>{t.sales.profitShort}</span>
                    </span>
                    <dl className="tnum mt-2 grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-0.5 text-v2-sm">
                      <dt className="text-v2-mute">{t.sales.sold}</dt>
                      <dd className="text-right text-v2-ink">{t.sales.soldPacks(fig.packs)}</dd>
                      <dt className="text-v2-mute">{t.sales.revenue}</dt>
                      <dd className="text-right text-v2-ink">{f.sek(fig.salesOre / 100)}</dd>
                    </dl>
                  </>
                )}
              </li>
            ))}
          </ul>
        </div>
        <div className="grid grid-cols-1 items-start gap-[14px] max-[900px]:gap-3 min-[1101px]:grid-cols-2">
          <Card title={t.sales.perMachine} count={perMachine.length}>
            {perMachine.length === 0 ? (
              <p className="v2-empty">{t.sales.noMachines}</p>
            ) : (
              <ul className="flex flex-col">
                {perMachine.map((m) => (
                  <li key={m.id} className={ROW}>
                    <span className="flex min-w-0 flex-col">
                      <span className="text-v2-md font-[550] [overflow-wrap:anywhere] text-v2-ink">
                        {m.name}
                      </span>
                      <span className="tnum text-v2-xs text-v2-mute">
                        {t.sales.soldPacks(m.packs)}
                      </span>
                    </span>
                    <span className="flex shrink-0 flex-col items-end">
                      <span className="tnum text-v2-md text-v2-ink">{f.sek(m.salesOre / 100)}</span>
                      <span className="tnum text-v2-xs text-v2-mute">
                        {`${t.sales.profitShort} ${f.sek(m.profitOre / 100)}`}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card title={t.sales.perProduct} count={perProduct.length}>
            <p className="border-b border-v2-line2 px-[18px] py-2.5 text-v2-sm text-v2-mute">
              {t.sales.perProductHint}
            </p>
            {perProduct.length === 0 ? (
              <p className="v2-empty">{t.sales.noProducts}</p>
            ) : (
              <ul aria-label={t.sales.perProduct} className="flex flex-col">
                {perProduct.map((r) => (
                  <li key={r.titleId} className={ROW}>
                    <span className="flex min-w-0 flex-col">
                      <span className="text-v2-md font-[550] [overflow-wrap:anywhere] text-v2-ink">
                        {r.name}
                      </span>
                      <span className="tnum text-v2-xs text-v2-mute">
                        {t.sales.soldPacks(r.packs)}
                        {r.perPackOre !== null
                          ? ` · ${t.sales.perPack(f.kronor(r.perPackOre / 100))}`
                          : ""}
                      </span>
                    </span>
                    <span
                      className={
                        r.noPrice
                          ? "shrink-0 text-v2-sm font-[550] text-v2-crit-text"
                          : "tnum shrink-0 text-v2-md font-[550] text-v2-ink"
                      }
                    >
                      {r.noPrice ? t.sales.noPurchasePrice : f.sek(r.profitOre / 100)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
        <p className="text-v2-xs text-v2-mute">
          {t.sales.profitHint}
          {unpriced > 0 ? ` ${t.sales.unpriced(unpriced)}` : ""}
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-[720px] flex-col gap-8 px-4 pt-4 pb-8 md:px-8 md:pt-10">
      {weekly ? (
        <WeekSummary
          summary={weekly}
          today={ctx.today}
          t={t}
          f={f}
          headingLevel="h2"
          close={{ href: closeHref, label: t.week.close }}
        />
      ) : null}
      <PageHead
        eyebrow={t.sales.title}
        title={t.sales.headline(f.sek(today.salesOre / 100))}
        aside={t.sales.revenueHint}
      />

      <ul className="flex flex-col gap-3" aria-label={t.sales.title}>
        {(
          [
            ["today", t.sales.today, today],
            ["week", t.sales.week, week],
            ["month", t.sales.month, month],
          ] as const
        ).map(([key, label, fig], i) => (
          <li key={key} className="rise" style={{ "--i": i + 1 } as CSSProperties}>
            <PeriodCard label={label} figures={fig} t={t} f={f} />
          </li>
        ))}
      </ul>

      <section aria-labelledby="per-automat" className="flex flex-col gap-3">
        <h2 id="per-automat" className="text-lg font-medium text-fg">
          {t.sales.perMachine}
        </h2>
        {perMachine.length === 0 ? (
          <p className="text-base text-muted">{t.sales.noMachines}</p>
        ) : (
          <ul className="flex flex-col divide-y divide-line rounded-md border border-line">
            {perMachine.map((m) => (
              <li key={m.id} className="flex min-h-14 flex-col gap-1 px-4 py-3">
                <span className="flex items-baseline justify-between gap-3">
                  <span className="min-w-0 text-base font-medium [overflow-wrap:anywhere] text-fg">
                    {m.name}
                  </span>
                  <span className="tnum shrink-0 text-base text-fg">{f.sek(m.salesOre / 100)}</span>
                </span>
                <span className="tnum flex items-baseline justify-between gap-3 text-sm text-muted">
                  <span>{t.sales.soldPacks(m.packs)}</span>
                  <span>{`${t.sales.profitShort} ${f.sek(m.profitOre / 100)}`}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="per-produkt" className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <h2 id="per-produkt" className="text-lg font-medium text-fg">
            {t.sales.perProduct}
          </h2>
          <p className="text-sm text-muted">{t.sales.perProductHint}</p>
        </div>
        {perProduct.length === 0 ? (
          <p className="text-base text-muted">{t.sales.noProducts}</p>
        ) : (
          <ul
            aria-label={t.sales.perProduct}
            className="flex flex-col divide-y divide-line rounded-md border border-line"
          >
            {perProduct.map((r) => (
              <li key={r.titleId} className="flex min-h-14 flex-col gap-1 px-4 py-3">
                <span className="flex items-baseline justify-between gap-3">
                  <span className="min-w-0 text-base font-medium [overflow-wrap:anywhere] text-fg">
                    {r.name}
                  </span>
                  <span
                    className={
                      r.noPrice
                        ? "shrink-0 text-sm text-signal-fg"
                        : "tnum shrink-0 text-base font-medium text-fg"
                    }
                  >
                    {r.noPrice ? t.sales.noPurchasePrice : f.sek(r.profitOre / 100)}
                  </span>
                </span>
                <span className="tnum flex items-baseline justify-between gap-3 text-sm text-muted">
                  <span>{t.sales.soldPacks(r.packs)}</span>
                  {r.perPackOre !== null ? (
                    <span>{t.sales.perPack(f.kronor(r.perPackOre / 100))}</span>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <p className="meta text-subtle">
        {t.sales.profitHint}
        {unpriced > 0 ? ` ${t.sales.unpriced(unpriced)}` : ""}
      </p>
    </div>
  );
}

function PeriodCard({
  label,
  figures,
  t,
  f,
}: {
  label: string;
  figures: SalesFigures;
  t: Messages;
  f: Formatters;
}) {
  return (
    <section
      aria-label={label}
      className="flex flex-col gap-3 rounded-md border border-line-strong bg-surface p-4"
    >
      <p className="label text-subtle">{label}</p>
      {figures.packs === 0 ? (
        <p className="text-lg text-muted">{t.sales.noSales}</p>
      ) : (
        <dl className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-4 gap-y-2">
          <dt className="text-base text-muted">{t.sales.sold}</dt>
          <dd className="tnum text-right text-lg text-fg">{t.sales.soldPacks(figures.packs)}</dd>
          <dt className="text-base text-muted">{t.sales.revenue}</dt>
          <dd className="tnum text-right text-lg text-fg">{f.sek(figures.salesOre / 100)}</dd>
          <dt className="text-base text-muted">{t.sales.profit}</dt>
          <dd className="tnum text-right text-2xl font-medium text-fg">
            {f.sek(figures.profitOre / 100)}
          </dd>
        </dl>
      )}
    </section>
  );
}

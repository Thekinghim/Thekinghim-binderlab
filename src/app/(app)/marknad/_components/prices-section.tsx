import Link from "next/link";

import type { TitlePriceTrend } from "@/analytics/pricing";
import { Panel, PanelSection } from "@/components/ui/frame";
import { SectionHeader } from "@/components/ui/section-header";
import { StateMessage } from "@/components/ui/state-message";
import { StatusTag } from "@/components/ui/status-tag";
import { formatInt, NBSP } from "@/lib/format";
import { dayText, deltaOfBp, kronor, periodLabel } from "@/server/market/display";
import type { PricesView } from "@/server/market/model";

import { deleteQuote } from "../actions";
import type { SectionContext } from "../_lib/context";
import { ActionButton } from "./action-button";
import { Evidence } from "./evidence";
import { PriceChart } from "./price-chart";
import { QuoteFormButton } from "./quote-form";
import { Cell, Row, Table } from "./table";

/** Läget för externa marknadspriser, som sidan visar det. */
export interface MarketSourceView {
  readonly kind: "not-configured" | "unavailable" | "ready";
  readonly reason: string | null;
  readonly sourceName: string | null;
  readonly candidates: readonly string[];
  /** Senaste externa pris per titel (bara när en källa är vald). */
  readonly latest: Readonly<
    Record<string, { priceMinor: number; currency: string; observedOn: string; productName: string }>
  >;
  readonly error: string | null;
}

function titleHref(ctx: SectionContext, titleId: string): string {
  const q = new URLSearchParams({ ...ctx.query, pristitel: titleId });
  return `?${q.toString()}#priser`;
}

function SourceStatus({ source }: { source: MarketSourceView }) {
  if (source.kind === "ready") {
    if (source.error) {
      return (
        <StateMessage
          kind="loading-failed"
          compact
          message={`${source.sourceName ?? "Källan"} kunde inte läsas: ${source.error}`}
        />
      );
    }
    return (
      <p className="meta text-subtle">
        Marknadspris: {source.sourceName} · {formatInt(Object.keys(source.latest).length)} titlar med
        pris. Testdata, inte riktiga marknadspriser.
      </p>
    );
  }
  return (
    <StateMessage
      kind="not-configured"
      compact
      message={`${source.reason ?? "Ingen extern källa är vald."} Jämförelsen bygger på egna offerter och inköp.`}
      detail={
        source.candidates.length > 0
          ? `Kandidater som väntar på beslut: ${source.candidates.join(", ")}.`
          : undefined
      }
    />
  );
}

function Trend({
  trend,
  prices,
  ctx,
}: {
  trend: TitlePriceTrend;
  prices: PricesView;
  ctx: SectionContext;
}) {
  const name = ctx.names.title[trend.titleId] ?? trend.titleId;
  const anomalies = prices.anomalies.ok
    ? prices.anomalies.value.filter((a) => a.titleId === trend.titleId)
    : [];
  const expensive = anomalies.filter((a) => a.direction === "expensive").at(-1);
  const markerIndex = expensive
    ? trend.points.findIndex((p) => p.id === expensive.purchaseId)
    : -1;
  return (
    <div className="grid grid-cols-1 gap-x-8 gap-y-8 lg:grid-cols-12">
      <div className="min-w-0 lg:col-span-7">
        <Panel>
          <div className="flex flex-col gap-4">
            <p className="label text-subtle">
              Inköpspris per pack · {name} · {formatInt(trend.purchases)} inköp
            </p>
            {trend.points.length >= 2 ? (
              <PriceChart
                points={trend.points.map((p) => ({ date: p.date, ore: p.unitCostOre }))}
                medianOre={trend.medianOre}
                medianLabel={`MEDIAN ${kronor(trend.medianOre)}`}
                marker={
                  markerIndex >= 0 && expensive
                    ? { index: markerIndex, note: `! Dyrt: ${kronor(expensive.unitCostOre)}` }
                    : null
                }
                summary={`${name}: ${formatInt(trend.purchases)} inköp från ${kronor(trend.minOre)} till ${kronor(trend.maxOre)}, median ${kronor(trend.medianOre)}.`}
              />
            ) : (
              <StateMessage
                kind="empty"
                code="1 inköp"
                compact
                message={`${name} har ett registrerat pris (${kronor(trend.first.unitCostOre)}, ${dayText(trend.first.date, ctx.today)}). Utvecklingen visas från två priser.`}
              />
            )}
            <p className="max-w-3xl text-muted">{trend.text}</p>
            <Evidence evidence={trend.evidence} names={ctx.names} />
          </div>
        </Panel>
      </div>
      <div className="min-w-0 lg:col-span-5">
        <Table
          caption={`Leverantörer för ${name}`}
          head={[
            { label: "Leverantör" },
            { label: "Median", numeric: true },
            { label: "Mot titeln", numeric: true },
            { label: "Senast", numeric: true, hideOnMobile: true },
          ]}
        >
          {trend.suppliers.map((s, i) => (
            <Row key={s.supplierId}>
              <Cell header>
                {ctx.names.supplier[s.supplierId] ?? s.supplierId}
                {i === 0 && trend.suppliers.length > 1 ? (
                  <span className="meta ml-2 text-subtle">billigast</span>
                ) : null}
              </Cell>
              <Cell numeric>{kronor(s.medianOre)}</Cell>
              <Cell numeric className="text-muted">
                {deltaOfBp(s.vsTitleMedianBp)}
              </Cell>
              <Cell numeric hideOnMobile className="text-muted">
                {kronor(s.lastOre)}
                <span className="meta ml-2 text-subtle">{dayText(s.lastDate, ctx.today)}</span>
              </Cell>
            </Row>
          ))}
        </Table>
      </div>
    </div>
  );
}

export function PricesSection({
  prices,
  source,
  selectedTitleId,
  period,
  ctx,
}: {
  prices: PricesView;
  source: MarketSourceView;
  selectedTitleId: string | null;
  period: { start: string; end: string };
  ctx: SectionContext;
}) {
  const trends = prices.trends.ok ? prices.trends.value : [];
  const anomalies = prices.anomalies.ok ? prices.anomalies.value : [];
  const supplierCount = new Set(prices.purchases.map((p) => p.supplierId)).size;
  const selected =
    trends.find((t) => t.titleId === selectedTitleId) ??
    [...trends].sort((a, b) => b.purchases - a.purchases || a.titleId.localeCompare(b.titleId))[0];
  const title =
    trends.length === 0
      ? "Inga inköpspriser registrerade."
      : `Inköpspris för ${formatInt(trends.length)} ${trends.length === 1 ? "titel" : "titlar"} från ${formatInt(supplierCount)} ${supplierCount === 1 ? "leverantör" : "leverantörer"}.`;
  const aside =
    trends.length === 0
      ? "Offerter och inköp per leverantör ger prisutvecklingen per titel."
      : anomalies.length === 0
        ? `Inga avvikande inköp ${periodLabel(period)}.`
        : `${formatInt(anomalies.length)} ${anomalies.length === 1 ? "inköp avviker" : "inköp avviker"} från medianen ${periodLabel(period)}.`;
  const recentQuotes = [...prices.purchases]
    .filter((p) => p.origin === "quote")
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
    .slice(0, 8);

  return (
    <section aria-labelledby="priser-rubrik" className="flex scroll-mt-28 flex-col gap-8" id="priser">
      <SectionHeader
        id="priser-rubrik"
        index={2}
        eyebrow="Marknadspriser"
        title={title}
        aside={aside}
        actions={
          ctx.canEdit ? (
            <QuoteFormButton
              titles={ctx.titleOptions}
              suppliers={ctx.supplierOptions}
              today={ctx.today}
              defaultTitleId={selected?.titleId}
            />
          ) : undefined
        }
      />
      <SourceStatus source={source} />

      {!prices.trends.ok ? (
        <StateMessage kind="error" message={prices.trends.message} />
      ) : null}

      {anomalies.length > 0 ? (
        <ul className="flex flex-col gap-4" aria-label="Avvikande inköp">
          {anomalies
            .slice()
            .reverse()
            .map((a) => (
              <li key={a.key} className="flex min-w-0 flex-col gap-2 border-b border-line pb-4">
                <div className="flex flex-wrap items-center gap-3">
                  <StatusTag status="warning">{a.direction === "expensive" ? "Dyrt" : "Billigt"}</StatusTag>
                  <span className="meta text-subtle">
                    {deltaOfBp(a.deviationBp)} mot medianen · {dayText(a.date, ctx.today)}
                  </span>
                </div>
                <p className="max-w-3xl text-muted">{a.text}</p>
                <Evidence evidence={a.evidence} names={ctx.names} />
              </li>
            ))}
        </ul>
      ) : null}

      {selected ? <Trend trend={selected} prices={prices} ctx={ctx} /> : null}

      {trends.length > 0 ? (
        <PanelSection label={`Alla titlar · ${formatInt(trends.length)}`}>
          <Table
            caption="Inköpspris per titel"
            head={[
              { label: "Titel" },
              { label: "Inköp", numeric: true, hideOnMobile: true },
              { label: "Median", numeric: true },
              { label: "Senast", numeric: true, hideOnMobile: true },
              { label: "Förändring", numeric: true },
              ...(source.kind === "ready" ? [{ label: "Marknadspris", numeric: true }] : []),
            ]}
          >
            {trends.map((t) => {
              const ext = source.latest[t.titleId];
              const isSelected = selected?.titleId === t.titleId;
              return (
                <Row key={t.titleId}>
                  <Cell header>
                    <Link
                      href={titleHref(ctx, t.titleId)}
                      aria-current={isSelected ? "true" : undefined}
                      className="rounded-xs underline decoration-line-strong underline-offset-4 hover:decoration-fg aria-[current=true]:font-medium aria-[current=true]:no-underline"
                    >
                      {ctx.names.title[t.titleId] ?? t.titleId}
                    </Link>
                  </Cell>
                  <Cell numeric hideOnMobile>
                    {formatInt(t.purchases)}
                  </Cell>
                  <Cell numeric>{kronor(t.medianOre)}</Cell>
                  <Cell numeric hideOnMobile className="text-muted">
                    {kronor(t.last.unitCostOre)}
                  </Cell>
                  <Cell numeric>{t.changeBp === null ? "–" : deltaOfBp(t.changeBp)}</Cell>
                  {source.kind === "ready" ? (
                    <Cell numeric className="text-muted">
                      {ext
                        ? ext.currency === "SEK"
                          ? kronor(ext.priceMinor)
                          : `${formatInt(ext.priceMinor / 100)}${NBSP}${ext.currency}`
                        : "–"}
                    </Cell>
                  ) : null}
                </Row>
              );
            })}
          </Table>
        </PanelSection>
      ) : null}

      {recentQuotes.length > 0 ? (
        <PanelSection label="Senast registrerade priser">
          <Table
            caption="Senast registrerade leverantörspriser"
            head={[
              { label: "Datum" },
              { label: "Titel" },
              { label: "Leverantör", hideOnMobile: true },
              { label: "Pris", numeric: true },
              ...(ctx.canEdit ? [{ label: "Åtgärd" }] : []),
            ]}
          >
            {recentQuotes.map((q) => (
              <Row key={q.id}>
                <Cell className="meta whitespace-nowrap text-muted">{dayText(q.date, ctx.today)}</Cell>
                <Cell header>{ctx.names.title[q.titleId] ?? q.titleId}</Cell>
                <Cell hideOnMobile className="text-muted">
                  {ctx.names.supplier[q.supplierId] ?? q.supplierId}
                </Cell>
                <Cell numeric>
                  {kronor(q.unitCostOre)}
                  {q.quantity > 1 ? <span className="meta ml-2 text-subtle">× {formatInt(q.quantity)}</span> : null}
                </Cell>
                {ctx.canEdit ? (
                  <Cell>
                    <ActionButton
                      action={deleteQuote}
                      payload={{ id: q.id }}
                      variant="ghost"
                      success="Priset borttaget"
                      confirm={{
                        title: "Ta bort priset",
                        description: `${ctx.names.title[q.titleId] ?? ""}: ${kronor(q.unitCostOre)} från ${ctx.names.supplier[q.supplierId] ?? ""}, ${dayText(q.date, ctx.today)}. Borttagningen loggas.`,
                        confirmLabel: "Ta bort",
                        danger: true,
                      }}
                    >
                      Ta bort
                    </ActionButton>
                  </Cell>
                ) : null}
              </Row>
            ))}
          </Table>
        </PanelSection>
      ) : null}
    </section>
  );
}

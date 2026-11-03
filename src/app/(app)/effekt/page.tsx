import type { Metadata } from "next";
import Link from "next/link";

import { MerHead } from "@/app/(app)/installningar/_components/mer-head";
import { SectionHeader } from "@/components/ui/section-header";
import type { SearchParamsInput } from "@/components/shell/period-state";
import { daysInMonth } from "@/domain";
import { formatInt } from "@/lib/format";

import { loadEffectPage, type Names } from "../expansion/_lib/data";
import { withOrderCounts } from "../expansion/_lib/slim";
import { BASELINE_METRIC_LABEL, monthLabel } from "../expansion/_lib/display";
import { signedPct } from "@/analytics/expansion";
import { day } from "@/analytics/todos/text";
import { evidenceLinks, monthOfDate } from "../expansion/_lib/model";
import { BaselinesSection, MeasurementsSection, SeriesView } from "./_components/effect-view";

export const metadata: Metadata = { title: "Effekt" };

function lookups(names: Names) {
  return {
    stores: (id: string) => names.stores.find((s) => s.id === id)?.name ?? id,
    machines: (id: string) => {
      const m = names.machines.find((x) => x.id === id);
      return m ? `${m.code} ${m.name}` : id;
    },
  };
}

/**
 * Effekt: förbättringen mot läget före Binderlab (utgångsläget, baselines) per månad, för
 * vinst per automat (räknad ur orderna), slutsålda dagar och tid för påfyllning och
 * administration (mätvärden per månad). Siffrorna kommer från @/analytics/effect.
 * Månaderna är de som perioden i skalet berör.
 */
export default async function EffektPage({
  searchParams,
}: {
  searchParams: Promise<SearchParamsInput>;
}) {
  const data = await loadEffectPage(await searchParams);
  const names = lookups(data.names);
  const scopeOf = (s: { scope: string; scopeId: string | null }) =>
    s.scope === "store"
      ? names.stores(s.scopeId ?? "")
      : s.scope === "machine"
        ? names.machines(s.scopeId ?? "")
        : "Hela flottan";
  const withValues = data.series.filter((s) => s.latest !== null);
  const lead =
    withValues.find((s) => s.metric === "profit_per_machine_month") ?? withValues[0] ?? null;
  const first = data.months[0]!;
  const last = data.months[data.months.length - 1]!;
  const monthsText =
    first === last ? monthLabel(first) : `${monthLabel(first)} – ${monthLabel(last)}`;

  // Rubriken bygger på senaste hela månaden; finns bara en pågående månad står det
  // "hittills" och hur många dagar som mätts.
  const point = lead
    ? ([...lead.points].reverse().find((pt) => pt.value !== null && !pt.partial) ?? lead.latest)
    : null;
  const pointBp = point?.improvementBp ?? null;
  const when = point
    ? point.partial
      ? `hittills i ${monthLabel(point.month)} (${formatInt(point.measuredDays)} av ${formatInt(daysInMonth(point.month))} dagar)`
      : `i ${monthLabel(point.month)}`
    : "";
  const title = lead
    ? pointBp === null
      ? `${BASELINE_METRIC_LABEL[lead.metric]}: ${monthLabel(point!.month)}.`
      : `${BASELINE_METRIC_LABEL[lead.metric]} ${signedPct(pointBp)} mot före Binderlab ${when}.`
    : data.baselines.length === 0
      ? "Inget utgångsläge ännu."
      : "Inga värden att jämföra ännu.";
  const aside = lead
    ? lead.detail ||
      `${withValues.length} av ${data.series.length} mått har värden för ${monthsText}.`
    : data.baselines.length === 0
      ? "Lägg in hur det var före."
      : "Lägg in mätvärden per månad.";

  return (
    <div className="mx-auto flex w-full max-w-[1280px] flex-col gap-12 px-4 pt-8 pb-16 md:gap-16 md:px-8 md:pt-12">
      <div className="flex flex-col gap-4">
        <MerHead
          eyebrow="Effekt"
          title={title}
          line={aside}
          count={false}
          tone={pointBp !== null && pointBp > 0 ? "good" : undefined}
          meta={[{ label: "Månader", value: monthsText }]}
        />
        {data.dataStartInMonth ? (
          <p className="meta break-words text-subtle">
            {/* day() slutar med punkt ("13 okt.") */}
            Data från {day(data.dataStartInMonth)}
          </p>
        ) : null}
      </div>

      <section
        aria-labelledby="forbattring"
        className="rise flex flex-col gap-8"
        style={{ "--i": 1 } as React.CSSProperties}
      >
        <SectionHeader
          id="forbattring"
          title="Förbättring."
          aside={`Per månad, ${monthsText}.`}
          actions={
            data.period.key !== "allt" ? (
              <Link
                href="?period=allt"
                className="meta rounded-xs text-fg underline decoration-line-control underline-offset-4 hover:decoration-fg"
              >
                Visa alla månader →
              </Link>
            ) : undefined
          }
        />
        {data.series.length === 0 ? (
          <p className="text-sm text-muted">Lägg in utgångsläget.</p>
        ) : (
          <div className="flex flex-col gap-10">
            {data.series.map((s) => (
              <SeriesView
                key={s.baselineId}
                series={withOrderCounts(s)}
                scope={scopeOf(s)}
                links={evidenceLinks(s.latest?.evidence ?? s.evidence, names)}
              />
            ))}
          </div>
        )}
      </section>

      <section
        aria-labelledby="utgangslage"
        className="rise flex flex-col gap-8"
        style={{ "--i": 2 } as React.CSSProperties}
      >
        <SectionHeader
          id="utgangslage"
          title={
            data.baselines.length === 0
              ? "Utgångsläge."
              : `Utgångsläge: ${formatInt(data.baselines.length)} mått.`
          }
        />
        <BaselinesSection
          baselines={data.baselines}
          stores={data.names.stores}
          machines={data.names.machines}
          canEdit={data.ctx.canEdit}
        />
      </section>

      <section
        aria-labelledby="matvarden"
        className="rise flex flex-col gap-8"
        style={{ "--i": 3 } as React.CSSProperties}
      >
        <SectionHeader id="matvarden" title="Mätvärden." aside="Per månad." />
        <MeasurementsSection
          measurements={data.measurements}
          settings={data.settings}
          stores={data.names.stores}
          machines={data.names.machines}
          canEdit={data.ctx.canEdit}
          defaultMonth={monthOfDate(data.ctx.today)}
        />
      </section>
    </div>
  );
}

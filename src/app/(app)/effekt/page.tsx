import type { Metadata } from "next";
import Link from "next/link";

import { SectionHeader } from "@/components/ui/section-header";
import type { SearchParamsInput } from "@/components/shell/period-state";
import { formatInt } from "@/lib/format";

import { loadEffectPage, type Names } from "../expansion/_lib/data";
import { BASELINE_METRIC_LABEL, monthLabel } from "../expansion/_lib/display";
import { signedPct } from "@/analytics/expansion";
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

  const latestBp = lead?.latest?.improvementBp ?? null;
  const title = lead
    ? latestBp === null
      ? `${BASELINE_METRIC_LABEL[lead.metric]}: ${monthLabel(lead.latest!.month)}.`
      : `${BASELINE_METRIC_LABEL[lead.metric]} ${signedPct(latestBp)} mot före Binderlab.`
    : data.baselines.length === 0
      ? "Utgångsläget före Binderlab är inte registrerat."
      : "Inga värden att jämföra ännu.";
  const aside = lead
    ? lead.detail ||
      `${withValues.length} av ${data.series.length} mått har värden för ${monthsText}.`
    : data.baselines.length === 0
      ? "Ange hur det var före: vinst per automat, slutsålda dagar och tid, så visas förbättringen per månad."
      : "Lägg in mätvärden per månad för slutsålda dagar och tid.";

  return (
    <div className="mx-auto flex w-full max-w-[1280px] flex-col gap-12 px-4 pt-8 pb-16 md:gap-16 md:px-8 md:pt-12">
      <SectionHeader
        as="h1"
        size="xl"
        eyebrow="Effekt"
        title={title}
        aside={aside}
        meta={[
          { label: "Månader", value: monthsText },
          { label: "Utgångslägen", value: formatInt(data.baselines.length) },
          { label: "Mätvärden", value: formatInt(data.measurements.length) },
        ]}
      />

      <section aria-labelledby="forbattring" className="flex flex-col gap-8">
        <SectionHeader
          id="forbattring"
          index={1}
          eyebrow="Förbättring"
          title="Mot läget före Binderlab."
          aside={`Per månad, ${monthsText}. En pågående månad jämförs med lika många dagar av utgångsläget.`}
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
          <p className="text-sm text-muted">
            Inget utgångsläge ännu. Lägg in det nedan, så räknas förbättringen per månad.
          </p>
        ) : (
          <div className="flex flex-col gap-10">
            {data.series.map((s) => (
              <SeriesView
                key={s.baselineId}
                series={s}
                scope={scopeOf(s)}
                links={evidenceLinks(s.latest?.evidence ?? s.evidence, names)}
              />
            ))}
          </div>
        )}
      </section>

      <section aria-labelledby="utgangslage" className="flex flex-col gap-8">
        <SectionHeader
          id="utgangslage"
          index={2}
          eyebrow="Utgångsläge"
          title={
            data.baselines.length === 0
              ? "Inget registrerat."
              : `${formatInt(data.baselines.length)} ${data.baselines.length === 1 ? "mått" : "mått"} före Binderlab.`
          }
          aside={`Mått: ${Object.values(BASELINE_METRIC_LABEL)
            .map((l) => l.toLowerCase())
            .join(", ")}.`}
        />
        <BaselinesSection
          baselines={data.baselines}
          stores={data.names.stores}
          machines={data.names.machines}
          canEdit={data.ctx.canEdit}
        />
      </section>

      <section aria-labelledby="matvarden" className="flex flex-col gap-8">
        <SectionHeader
          id="matvarden"
          index={3}
          eyebrow="Mätvärden"
          title="Slutsålda dagar och tid per månad."
          aside="Vinst per automat räknas ur orderna; resten mäts och läggs in här."
        />
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

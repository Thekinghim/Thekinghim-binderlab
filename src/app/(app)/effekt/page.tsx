import type { Metadata } from "next";
import Link from "next/link";

import { MobileFold } from "@/components/ui/mobile-fold";
import { Card, CardBody } from "@/components/v2/card";
import { Empty } from "@/components/v2/empty";
import { PAGE_BODY, PageIntro } from "@/components/v2/page-intro";
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
    <div className={PAGE_BODY}>
      <PageIntro
        title={title}
        aside={aside}
        facts={[
          { label: "Månader", value: monthsText },
          // day() slutar med punkt ("13 okt.")
          ...(data.dataStartInMonth
            ? [{ label: "Data från", value: day(data.dataStartInMonth) }]
            : []),
        ]}
      />

      <Card
        as="section"
        title="Förbättring"
        actions={
          data.period.key !== "allt" ? (
            <Link
              href="?period=allt"
              className="inline-flex min-h-7 items-center rounded-v2-sm text-v2-sm font-[550] text-v2-ink hover:underline max-[900px]:min-h-11"
            >
              Visa alla månader →
            </Link>
          ) : undefined
        }
      >
        <CardBody className="flex flex-col gap-5">
          <p id="forbattring" className="text-v2-md text-v2-mute">
            Per månad, {monthsText}.
          </p>
          {data.series.length === 0 ? (
            <Empty title="Lägg in utgångsläget." />
          ) : (
            <div className="flex flex-col divide-y divide-v2-line2 [&>*]:pt-6 [&>*]:pb-6 [&>*:first-child]:pt-0 [&>*:last-child]:pb-0">
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
        </CardBody>
      </Card>

      <div className="v2-stack">
        <Card as="section" title="Utgångsläge" count={data.baselines.length}>
          <CardBody className="flex flex-col gap-4">
            <p id="utgangslage" className="text-v2-md text-v2-mute">
              {data.baselines.length === 0
                ? "Så var det före Binderlab."
                : `Så var det före Binderlab: ${formatInt(data.baselines.length)} mått.`}
            </p>
            {/* Inställningar för mätningen: fällda på mobilen, siffrorna ovan är det viktiga. */}
            <MobileFold summary="Visa och ändra">
              <BaselinesSection
                baselines={data.baselines}
                stores={data.names.stores}
                machines={data.names.machines}
                canEdit={data.ctx.canEdit}
              />
            </MobileFold>
          </CardBody>
        </Card>

        <Card as="section" title="Inmatade siffror">
          <CardBody className="flex flex-col gap-4">
            <p id="matvarden" className="text-v2-md text-v2-mute">
              Per månad.
            </p>
            <MobileFold summary="Visa och ändra">
              <MeasurementsSection
                measurements={data.measurements}
                settings={data.settings}
                stores={data.names.stores}
                machines={data.names.machines}
                canEdit={data.ctx.canEdit}
                defaultMonth={monthOfDate(data.ctx.today)}
              />
            </MobileFold>
          </CardBody>
        </Card>
      </div>
    </div>
  );
}

import type { Metadata } from "next";

import { SectionHeader } from "@/components/ui/section-header";
import type { SearchParamsInput } from "@/components/shell/period-state";
import { formatInt } from "@/lib/format";

import { DataStartNote, EvidenceDetails } from "../../expansion/_components/evidence";
import { loadUnitEconomicsPage } from "../../expansion/_lib/data";
import { kr, paybackShort } from "../../expansion/_lib/display";
import { evidenceLinks } from "../../expansion/_lib/model";
import { periodText } from "@/analytics/todos/text";
import {
  ComparisonTable,
  InvestmentsSection,
  ProfitPerDayChart,
  UnitEconomicsKpis,
} from "./_components/unit-economics-view";

export const metadata: Metadata = { title: "Enhetsekonomi" };

/**
 * Enhetsekonomi per automat: investering (inköp + installation), intäkt och vinst per dag,
 * återbetalningstid och avkastning, sida vid sida. Siffrorna kommer från domänens
 * `unitEconomics` via `compareUnitEconomics` (@/analytics/expansion), för perioden och
 * filtret i skalet. Investeringarna registreras här (ägare och admin).
 */
export default async function EnhetsekonomiPage({
  searchParams,
}: {
  searchParams: Promise<SearchParamsInput>;
}) {
  const data = await loadUnitEconomicsPage(await searchParams);
  const { comparison, period } = data;
  const codes = Object.fromEntries(data.names.machines.map((m) => [m.id, m.code ?? m.name]));
  const names = {
    stores: (id: string) => data.names.stores.find((s) => s.id === id)?.name ?? id,
    machines: (id: string) => {
      const m = data.names.machines.find((x) => x.id === id);
      return m ? `${m.code} ${m.name}` : id;
    },
  };
  const investmentOre = comparison.rows.reduce((s, r) => s + r.investmentOre, 0);
  const bookValueOre = comparison.rows.reduce((s, r) => s + r.bookValueOre, 0);
  const paid = comparison.rows.filter((r) => r.paybackTenths !== null);
  const fastest = [...paid].sort((a, b) => a.paybackTenths! - b.paybackTenths!)[0];
  const best = comparison.rows.find((r) => r.machineId === comparison.bestMachineId);

  const title =
    comparison.averageProfitPerDayOre === null
      ? "Enhetsekonomi per automat."
      : `Vinst ${kr(comparison.averageProfitPerDayOre)} per automat och dag.`;

  return (
    <div className="mx-auto flex w-full max-w-[1280px] flex-col gap-12 px-4 pt-8 pb-16 md:gap-16 md:px-8 md:pt-12">
      <div className="flex flex-col gap-4">
        <SectionHeader
          as="h1"
          size="xl"
          eyebrow="Automater / Enhetsekonomi"
          title={title}
          aside={comparison.text}
          meta={[
            { label: "Period", value: periodText(period.period) },
            { label: "Automater", value: formatInt(comparison.rows.length) },
            {
              label: "Snabbast återbetald",
              value: fastest
                ? `${codes[fastest.machineId] ?? ""} ${paybackShort(fastest.paybackTenths)}`
                : "–",
            },
          ]}
        />
        <DataStartNote clippedFrom={period.clippedFrom} requested={period.requested} />
        <EvidenceDetails
          evidence={comparison.evidence}
          links={evidenceLinks(comparison.evidence, names, 0)}
        />
      </div>

      <UnitEconomicsKpis
        averageProfitPerDayOre={comparison.averageProfitPerDayOre}
        averageRevenuePerDayOre={comparison.averageRevenuePerDayOre}
        investmentOre={investmentOre}
        bookValueOre={bookValueOre}
        comparison={`${periodText(period.period)}, ${formatInt(period.days)} dagar`}
      />

      <section aria-labelledby="per-dag" className="flex flex-col gap-8">
        <SectionHeader
          id="per-dag"
          index={1}
          eyebrow="Vinst per dag"
          title={best ? `${best.name} leder.` : "Vinst per automat och dag."}
          aside={
            comparison.averageProfitPerDayOre === null
              ? "Ingen automat var placerad i perioden."
              : `Snitt ${kr(comparison.averageProfitPerDayOre)}, viktat efter automatdagar.`
          }
        />
        <ProfitPerDayChart rows={comparison.rows} codes={codes} />
      </section>

      <section aria-labelledby="sida-vid-sida" className="flex flex-col gap-8">
        <SectionHeader
          id="sida-vid-sida"
          index={2}
          eyebrow="Sida vid sida"
          title="Investering, vinst och återbetalning."
          aside={
            fastest
              ? `${fastest.name} återbetalas snabbast, på ${paybackShort(fastest.paybackTenths)}.`
              : investmentOre === 0
                ? "Ingen investering registrerad."
                : "Ingen automat återbetalas med nuvarande vinst."
          }
          description="Vinst före avskrivning efter inköp, avgifter, provision och hyra. Återbetalningstid = investering / vinst per månad. Avkastning per år = vinst per månad × 12 / investering."
        />
        <ComparisonTable
          rows={comparison.rows}
          units={data.units}
          codes={codes}
          period={period.period}
        />
        <div className="flex flex-col gap-3">
          <p className="label text-subtle">Underlag per automat</p>
          <ul className="flex flex-col">
            {comparison.rows.map((r) => (
              <li key={r.machineId} className="flex flex-col gap-2 border-t border-line py-3">
                <p className="text-sm text-fg">{r.text}.</p>
                <EvidenceDetails evidence={r.evidence} links={evidenceLinks(r.evidence, names)} />
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section aria-labelledby="investeringar" className="flex flex-col gap-8">
        <SectionHeader
          id="investeringar"
          index={3}
          eyebrow="Investeringar"
          title={`${kr(investmentOre)} investerat.`}
          aside={`${formatInt(data.investments.length)} poster, bokfört värde ${kr(bookValueOre)}.`}
          description={
            data.ctx.canEdit
              ? "Inköp och installation per automat. Avskrivningen är linjär."
              : "Inköp och installation per automat. Bara ägare och administratörer kan ändra."
          }
        />
        <InvestmentsSection
          investments={data.investments}
          machines={data.names.machines}
          canEdit={data.ctx.canEdit}
          today={data.ctx.today}
        />
      </section>
    </div>
  );
}

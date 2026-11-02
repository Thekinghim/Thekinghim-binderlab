import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { day, periodText } from "@/analytics/todos/text";
import { SectionHeader } from "@/components/ui/section-header";
import type { SearchParamsInput } from "@/components/shell/period-state";
import { formatInt } from "@/lib/format";

import { DataStartNote, EstimateTag } from "./_components/evidence";
import { PriceChangeView, SiteEstimateView } from "./_components/estimate-view";
import { GoalsView } from "./_components/goals-view";
import { PipelineView, StoreProfilesView } from "./_components/pipeline-view";
import { NewMachineForm, PriceChangeForm } from "./_components/scenario-forms";
import { loadExpansionPage, type Names } from "./_lib/data";
import { kr, oreToInput, paybackShort, pct } from "./_lib/display";
import { evidenceLinks, monthOfDate, OPEN_STAGES } from "./_lib/model";

export const metadata: Metadata = { title: "Expansion" };

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
 * Expansion: vad en ny automat ger (uppskattning från liknande platser), vad en
 * prisändring ger (känslighetsanalys), mål per månad, pipelinen för nya platser,
 * platsprofilerna som jämförelsen bygger på och säljunderlaget till nya partnerbutiker.
 * Alla siffror kommer från @/analytics (expansion, scenarios, goals) och @/domain.
 */
export default async function ExpansionPage({
  searchParams,
}: {
  searchParams: Promise<SearchParamsInput>;
}) {
  const sp = await searchParams;
  const data = await loadExpansionPage(sp);
  const names = lookups(data.names);
  const { estimate } = data.newMachine;
  const top = data.pipeline.find((p) => p.estimate.status === "ok" && p.estimate.investmentOre > 0);
  const openLeads = data.leads.filter((l) => !l.archived && OPEN_STAGES.includes(l.stage)).length;
  const missingProfiles = data.profiles.filter(
    (p) => !p.archived && (p.storeType === null || p.city === null),
  ).length;
  const periodLabel = periodText(data.period.period);

  // Rubriken: bästa platsen i pipelinen, annars scenariot för en ny automat.
  let title = "Var nästa automat ska stå.";
  // Utan uppskattning: ett faktum ur datan i stället för en instruktion (design.md 4).
  const activeProfiles = data.profiles.filter((p) => !p.archived).length;
  let aside = `${formatInt(openLeads)} ${openLeads === 1 ? "öppen plats" : "öppna platser"} i pipelinen, ${formatInt(activeProfiles)} ${activeProfiles === 1 ? "butik" : "butiker"} att jämföra med.`;
  if (top) {
    title = `${top.name} har bäst potential.`;
    aside = `Uppskattning: ${kr(top.estimate.profitPerMonthOre!.expected)} vinst per månad, återbetald på ${paybackShort(top.estimate.paybackTenths?.expected)}.`;
  } else if (estimate?.status === "ok" && estimate.investmentOre > 0) {
    const like = names.stores(data.newMachine.likeStoreId ?? "");
    title = `En ny automat som i ${like} återbetalas på ${paybackShort(estimate.paybackTenths!.expected)}.`;
    aside = `Uppskattning från ${estimate.basis.length} ${estimate.basis.length === 1 ? "plats" : "platser"}, ${kr(estimate.profitPerMonthOre!.expected)} vinst per månad.`;
  }

  const inv = data.defaultInvestment;
  const invText = inv
    ? `snittet av ${inv.machineIds.length} automater, ${kr(inv.totalOre)}`
    : "ingen investering registrerad";
  const leadLinks = Object.fromEntries(
    data.pipeline.map((p) => [p.leadId, evidenceLinks(p.estimate.evidence, names)]),
  );
  const goalLinks = Object.fromEntries(
    data.goals.progress.map((g) => [g.goalId, evidenceLinks(g.evidence, names)]),
  );
  const storeOptions = data.profiles
    .filter((p) => !p.archived)
    .map((p) => ({ value: p.id, label: p.name }));
  const titleOptions = data.names.titles
    .filter((t) => !t.archived)
    .map((t) => ({ value: t.id, label: t.name }))
    .sort((a, b) => a.label.localeCompare(b.label, "sv"));
  const errs = (list: { field: string; message: string }[]) =>
    Object.fromEntries(list.map((e) => [e.field, e.message]));
  const goalsBehind = data.goals.progress.filter((g) => g.status === "behind").length;

  return (
    <div className="mx-auto flex w-full max-w-[1280px] flex-col gap-12 px-4 pt-8 pb-16 md:gap-16 md:px-8 md:pt-12">
      <div className="flex flex-col gap-4">
        <SectionHeader
          as="h1"
          size="xl"
          eyebrow="Expansion"
          title={title}
          aside={aside}
          meta={[
            { label: "Underlag", value: periodLabel },
            { label: "Öppna platser", value: formatInt(openLeads) },
            { label: "Mål efter", value: formatInt(goalsBehind) },
          ]}
        />
        <DataStartNote clippedFrom={data.period.clippedFrom} requested={data.period.requested} />
      </div>

      <section
        id="ny-automat"
        aria-labelledby="ny-automat-h"
        className="flex scroll-mt-28 flex-col gap-8"
      >
        <SectionHeader
          id="ny-automat-h"
          index={1}
          eyebrow="Scenario · ny automat"
          title="Vad ger en ny automat i en butik som liknar en vi har?"
          aside={`Räknat på ${periodLabel}, hela flottan.`}
          description={`Platserna jämförs på butikstyp, ort, öppettider och yta. Tomma investeringsfält = ${invText}.`}
        />
        <Suspense>
          <NewMachineForm
            stores={storeOptions}
            initial={{
              lik: data.newMachine.likeStoreId ?? "",
              inkop: data.params.purchase,
              installation: data.params.installation,
              provision: data.params.commission,
              hyra: data.params.rent,
            }}
            errors={errs(data.newMachine.errors)}
            placeholders={{
              inkop: inv ? oreToInput(inv.plan.purchaseOre) : "",
              installation: inv ? oreToInput(inv.plan.installationOre) : "",
            }}
          />
        </Suspense>
        {estimate ? (
          <SiteEstimateView
            estimate={estimate}
            links={evidenceLinks(estimate.evidence, names)}
            investmentNote={
              estimate.investmentOre === 0
                ? "Ingen investering är angiven, så återbetalningstiden kan inte räknas."
                : undefined
            }
          />
        ) : (
          <p className="text-sm text-muted">
            Ange investeringen (eller registrera investeringar under{" "}
            <Link className="underline" href="/automater/enhetsekonomi">
              Enhetsekonomi
            </Link>
            ) för att räkna återbetalningstiden.
          </p>
        )}
      </section>

      <section
        id="prisandring"
        aria-labelledby="prisandring-h"
        className="flex scroll-mt-28 flex-col gap-8"
      >
        <SectionHeader
          id="prisandring-h"
          index={2}
          eyebrow="Scenario · prisändring"
          title="Vad händer med vinsten om priset ändras?"
          aside="Känslighetsanalys på periodens sålda pack."
          description="Moms, kortavgift och provision följer det nya priset; inköp och hyra är oförändrade. Elasticiteten är ett antagande, därför visas flera."
        />
        <Suspense>
          <PriceChangeForm
            titles={titleOptions}
            initial={{
              titel: data.price.titleId ?? "",
              andring: data.params.delta || oreToInput(data.price.deltaOre),
              elasticitet: data.params.elasticity || "0",
            }}
            errors={errs(data.price.errors)}
          />
        </Suspense>
        {data.price.scenario ? (
          <PriceChangeView
            scenario={data.price.scenario}
            links={evidenceLinks(data.price.scenario.evidence, names)}
          />
        ) : (
          <p className="text-sm text-muted">Inga titlar har sålts under perioden.</p>
        )}
      </section>

      <section id="mal" aria-labelledby="mal-h" className="flex scroll-mt-28 flex-col gap-8">
        <SectionHeader
          id="mal-h"
          index={3}
          eyebrow="Mål per månad"
          title={
            data.goals.progress.length === 0
              ? "Inga mål satta."
              : goalsBehind === 0
                ? "Alla mål är i fas eller nådda."
                : `${formatInt(goalsBehind)} ${goalsBehind === 1 ? "mål ligger" : "mål ligger"} efter.`
          }
          aside={
            data.goals.progress.length === 0
              ? "Utfall och prognos visas när ett mål finns."
              : `Prognos till och med ${day(data.ctx.today)}: snittet hittills, eller de senaste 28 dagarna tidigt i månaden.`
          }
        />
        <GoalsView
          goals={data.goals.records}
          progress={data.goals.progress}
          links={goalLinks}
          stores={data.names.stores}
          machines={data.names.machines}
          canEdit={data.ctx.canEdit}
          defaultMonth={monthOfDate(data.ctx.today)}
        />
      </section>

      <section
        id="pipeline"
        aria-labelledby="pipeline-h"
        className="flex scroll-mt-28 flex-col gap-8"
      >
        <SectionHeader
          id="pipeline-h"
          index={4}
          eyebrow="Expansionspipeline"
          title={
            openLeads === 0
              ? "Pipelinen är tom."
              : `${formatInt(openLeads)} ${openLeads === 1 ? "öppen plats" : "öppna platser"}.`
          }
          aside="Lead → kontaktad → möte → avtal → installerad. Rangordnade efter uppskattad återbetalningstid."
        />
        <PipelineView
          leads={data.leads}
          pipeline={data.pipeline}
          links={leadLinks}
          stores={data.names.stores}
          canEdit={data.ctx.canEdit}
          today={data.ctx.today}
          defaultInvestmentText={invText}
        />
      </section>

      <section
        id="platsprofiler"
        aria-labelledby="platsprofiler-h"
        className="flex scroll-mt-28 flex-col gap-8"
      >
        <SectionHeader
          id="platsprofiler-h"
          index={5}
          eyebrow="Platsprofiler"
          title="Det jämförelsen bygger på."
          aside={
            missingProfiles === 0
              ? "Alla butiker har typ och ort."
              : `${formatInt(missingProfiles)} ${missingProfiles === 1 ? "butik saknar" : "butiker saknar"} typ eller ort och liknar därför inget.`
          }
        />
        <StoreProfilesView profiles={data.profiles} canEdit={data.ctx.canEdit} />
      </section>

      <section
        id="saljunderlag"
        aria-labelledby="saljunderlag-h"
        className="flex scroll-mt-28 flex-col gap-8"
      >
        <SectionHeader
          id="saljunderlag-h"
          index={6}
          eyebrow="Säljunderlag"
          title={
            data.deck.status === "ok"
              ? `Partnerbutiker tjänar ${kr(data.deck.compensationPerMonthOre!)} per automat och månad.`
              : "Säljunderlaget kräver minst tre butiker."
          }
          aside={
            data.deck.status === "ok"
              ? `Snitt av ${data.deck.stores} butiker, anonymiserat, ${pct(data.deck.compensationShareBp ?? 0)} av försäljningen.`
              : `Underlaget har ${data.deck.stores} ${data.deck.stores === 1 ? "butik" : "butiker"}; med färre än tre går en enskild butiks ersättning att räkna ut.`
          }
          actions={
            <Link
              href={`/expansion/saljunderlag?from=${data.period.period.start}&to=${data.period.period.end}`}
              className="inline-flex h-9 items-center gap-2 rounded-sm border border-line-strong bg-surface px-3.5 text-base font-medium text-fg transition-colors duration-fast ease-instrument hover:border-line-control hover:bg-hover"
            >
              Öppna säljunderlaget (PDF)
            </Link>
          }
        />
        <div className="flex items-center gap-3">
          <EstimateTag>Historiskt snitt</EstimateTag>
          <p className="text-sm text-muted">
            Provision och hyra enligt avtalen under {periodLabel}, delat på automatmånader. Inga
            butiksnamn och inga enskilda belopp.
          </p>
        </div>
      </section>
    </div>
  );
}

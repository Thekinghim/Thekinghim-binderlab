import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { periodText } from "@/analytics/todos/text";
import { SectionHeader } from "@/components/ui/section-header";
import type { SearchParamsInput } from "@/components/shell/period-state";
import { formatInt } from "@/lib/format";

import { DataStartNote } from "./_components/evidence";
import { PriceChangeView, SiteEstimateView } from "./_components/estimate-view";
import { GoalsView } from "./_components/goals-view";
import { PlanView } from "./_components/plan-view";
import { PipelineView, StoreProfilesView } from "./_components/pipeline-view";
import { NewMachineForm, PriceChangeForm } from "./_components/scenario-forms";
import { LEAD_PREFIX, loadExpansionPage, type Names } from "./_lib/data";
import { hoursText, kr, monthLabel, oreToInput, paybackShort } from "./_lib/display";
import { loadGrowthPlanPage } from "./_lib/plan-data";
import { evidenceLinks, LEAD_STAGE_LABEL, monthOfDate, OPEN_STAGES } from "./_lib/model";
import { withOrderCounts } from "./_lib/slim";
import { pickView, ViewTabs } from "../rapporter/_components/view-tabs";

export const metadata: Metadata = { title: "Expansion" };

/** Punkt sist, utan dubbel punkt efter en förkortning ("2 nov."). */
function endSentence(text: string): string {
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

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
  const [data, growth] = await Promise.all([loadExpansionPage(sp), loadGrowthPlanPage()]);
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
  // Den nya platsen: en plats i pipelinen (jämförs med liknande butiker) eller "en till
  // som" en befintlig butik (jämförs med sig själv och butiker som liknar den).
  const storeOptions = [
    ...data.pipeline.map((p) => ({
      value: `${LEAD_PREFIX}${p.leadId}`,
      label: `${p.name} (pipelinen)`,
    })),
    ...data.profiles
      .filter((p) => !p.archived)
      .map((p) => ({ value: p.id, label: `En till som ${p.name}` })),
  ];
  const titleOptions = data.names.titles
    .filter((t) => !t.archived)
    .map((t) => ({ value: t.id, label: t.name }))
    .sort((a, b) => a.label.localeCompare(b.label, "sv"));
  const errs = (list: { field: string; message: string }[]) =>
    Object.fromEntries(list.map((e) => [e.field, e.message]));
  const goalsBehind = data.goals.progress.filter((g) => g.status === "behind").length;
  const VIEWS = ["plan", "pipeline", "scenarier", "mal"] as const;
  const entries: [string, string][] =
    sp instanceof URLSearchParams
      ? [...sp.entries()]
      : Object.entries(sp).flatMap(([k, val]) => {
          const x = Array.isArray(val) ? val[0] : val;
          return typeof x === "string" ? [[k, x] as [string, string]] : [];
        });
  const view = pickView(entries.find(([k]) => k === "vy")?.[1], VIEWS);
  const hrefFor = (v: (typeof VIEWS)[number]) => {
    const q = new URLSearchParams();
    for (const [k, x] of entries) if (x && k !== "vy") q.set(k, x);
    if (v !== "plan") q.set("vy", v);
    const qs = q.toString();
    return qs ? `/expansion?${qs}` : "/expansion";
  };
  const rise = (i: number) => ({ "--i": i }) as React.CSSProperties;

  // Planvyn: målet och när det nås är rubriken (en stor siffra, ett faktum).
  const g = growth.plan;
  if (view === "plan") {
    title =
      g.toAdd === 0
        ? `Målet är nått: ${formatInt(g.machinesNow)} automater.`
        : g.targetMonth
          ? `${formatInt(g.target)} automater ${monthLabel(g.targetMonth)}.`
          : `Plan för ${formatInt(g.target)} automater.`;
    aside =
      g.toAdd === 0
        ? "Höj målet."
        : `Ni har ${formatInt(g.machinesNow)}. ${formatInt(g.perMonth)} ${g.perMonth === 1 ? "ny" : "nya"} i månaden. Vid ${formatInt(g.atTarget.machines)}: ${hoursText(g.atTarget.minutesPerPersonWeek)}/vecka var.`;
  }
  const planLeads = data.leads
    .filter((l) => !l.archived && OPEN_STAGES.includes(l.stage) && l.storeId === null)
    .map((l) => ({
      id: l.id,
      name: l.name,
      stageLabel: LEAD_STAGE_LABEL[l.stage],
      ready: l.stage === "agreement" || l.stage === "meeting",
    }));

  return (
    <div className="mx-auto flex w-full max-w-[1280px] flex-col gap-10 px-4 pt-8 pb-16 md:gap-12 md:px-8 md:pt-12">
      <div className="rise flex flex-col gap-6" style={rise(0)}>
        <SectionHeader
          as="h1"
          size="xl"
          eyebrow="Expansion"
          title={title}
          aside={aside}
          meta={[
            {
              label: "Underlag",
              value:
                view === "plan"
                  ? growth.basisPeriod
                    ? periodText(growth.basisPeriod)
                    : "Ingen data"
                  : periodLabel,
            },
          ]}
          actions={
            <Link
              href={`/expansion/saljunderlag?from=${data.period.period.start}&to=${data.period.period.end}`}
              className="inline-flex h-9 items-center gap-2 rounded-sm border border-line-strong bg-surface px-3.5 text-base font-medium text-fg transition-colors duration-fast ease-instrument hover:border-line-control hover:bg-hover"
            >
              Säljunderlag (PDF)
            </Link>
          }
        />
        {view === "plan" ? null : (
          <DataStartNote clippedFrom={data.period.clippedFrom} requested={data.period.requested} />
        )}
        <ViewTabs
          label="Vy"
          value={view}
          hrefFor={hrefFor}
          tabs={[
            { value: "plan", label: "Plan" },
            { value: "pipeline", label: "Pipeline", count: openLeads },
            { value: "scenarier", label: "Scenarier" },
            { value: "mal", label: "Mål", count: data.goals.progress.length },
          ]}
        />
      </div>

      {view === "plan" ? (
        <section aria-label="Plan" className="flex flex-col gap-6">
          <PlanView
            plan={g}
            saved={growth.saved}
            canEdit={growth.canEdit}
            leads={planLeads}
            openLeads={openLeads}
            pipelineHref={hrefFor("pipeline")}
          />
        </section>
      ) : null}

      {view === "scenarier" ? (
        <>
          <section
            id="ny-automat"
            aria-labelledby="ny-automat-h"
            className="rise flex scroll-mt-28 flex-col gap-6"
            style={rise(1)}
          >
            <SectionHeader
              id="ny-automat-h"
              size="md"
              title="Ny automat på ny plats."
              aside={
                data.newMachine.lead
                  ? endSentence(
                      `${data.newMachine.lead.name} i pipelinen, räknat på liknande butiker ${periodLabel}`,
                    )
                  : `Räknat på ${periodLabel}, hela flottan.`
              }
              description={`Tomma investeringsfält = ${invText}.`}
            />
            <Suspense>
              <NewMachineForm
                stores={storeOptions}
                initial={{
                  lik: data.newMachine.likeStoreId ?? "",
                  inkop: data.params.purchase,
                  installation: data.params.installation,
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
                    ? "Ange investeringen för återbetalningstid."
                    : undefined
                }
              />
            ) : (
              <p className="text-sm text-muted">
                Ange investeringen.{" "}
                <Link className="underline underline-offset-4" href="/automater/enhetsekonomi">
                  Enhetsekonomi →
                </Link>
              </p>
            )}
          </section>

          <section
            id="prisandring"
            aria-labelledby="prisandring-h"
            className="rise flex scroll-mt-28 flex-col gap-6"
            style={rise(2)}
          >
            <SectionHeader
              id="prisandring-h"
              size="md"
              title="Prisändring."
              aside="På periodens sålda pack."
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
              <p className="text-sm text-muted">Ingen försäljning i perioden.</p>
            )}
          </section>
        </>
      ) : null}

      {view === "mal" ? (
        <section
          id="mal"
          aria-labelledby="mal-h"
          className="rise flex scroll-mt-28 flex-col gap-6"
          style={rise(1)}
        >
          <SectionHeader
            id="mal-h"
            size="md"
            title={
              data.goals.progress.length === 0
                ? "Inga mål satta."
                : goalsBehind === 0
                  ? "Alla mål är i fas eller nådda."
                  : `${formatInt(goalsBehind)} ${goalsBehind === 1 ? "mål ligger" : "mål ligger"} efter.`
            }
            aside={goalsFact(data.goals.progress, monthOfDate(data.ctx.today))}
          />
          <GoalsView
            goals={data.goals.records}
            progress={withOrderCounts(data.goals.progress)}
            links={goalLinks}
            stores={data.names.stores}
            machines={data.names.machines}
            canEdit={data.ctx.canEdit}
            defaultMonth={monthOfDate(data.ctx.today)}
          />
        </section>
      ) : null}

      {view === "pipeline" ? (
        <>
          <section
            id="pipeline"
            aria-labelledby="pipeline-h"
            className="rise flex scroll-mt-28 flex-col gap-6"
            style={rise(1)}
          >
            <SectionHeader
              id="pipeline-h"
              size="md"
              title={
                openLeads === 0
                  ? "Pipelinen är tom."
                  : `${formatInt(openLeads)} ${openLeads === 1 ? "öppen plats" : "öppna platser"}.`
              }
              aside={pipelineFact(
                data.leads,
                top ? { name: top.name, payback: top.estimate.paybackTenths?.expected } : null,
              )}
            />
            <PipelineView
              leads={data.leads}
              pipeline={withOrderCounts(data.pipeline)}
              links={leadLinks}
              stores={data.names.stores}
              canEdit={data.ctx.canEdit}
              today={data.ctx.today}
              defaultInvestmentText={invText}
            />
          </section>

          <details
            id="platsprofiler"
            className="rise group flex scroll-mt-28 flex-col gap-6 rounded-md border border-line bg-surface p-4 md:p-5"
            style={rise(2)}
          >
            <summary className="flex cursor-pointer list-none items-baseline justify-between gap-4">
              <h2 className="text-md font-medium text-fg">Platsprofiler</h2>
              <span className="meta text-subtle">
                {missingProfiles === 0
                  ? "Alla har typ och ort"
                  : `${formatInt(missingProfiles)} saknar typ eller ort`}
              </span>
            </summary>
            <div className="mt-6">
              <StoreProfilesView profiles={data.profiles} canEdit={data.ctx.canEdit} />
            </div>
          </details>
        </>
      ) : null}
    </div>
  );
}

/** Ett faktum om målen: innevarande månads prognos mot målet, annars antalet mål. */
function goalsFact(
  progress: readonly {
    month: string;
    metric: "revenue" | "profit" | "active_machines";
    target: number;
    forecast: number;
    status: string;
  }[],
  thisMonth: string,
): string {
  if (progress.length === 0) return "Utfall och prognos visas när ett mål finns.";
  const now =
    progress.find((g) => g.month === thisMonth && g.metric === "revenue") ??
    progress.find((g) => g.month === thisMonth);
  if (!now) {
    return `${formatInt(progress.length)} ${progress.length === 1 ? "mål" : "mål"}, inget för ${monthLabel(thisMonth)}.`;
  }
  const v = (x: number) => (now.metric === "active_machines" ? formatInt(x) : kr(x));
  return `${capitalize(monthLabel(thisMonth))}: prognos ${v(now.forecast)} mot målet ${v(now.target)}.`;
}

/** Ett faktum om pipelinen: platsen med kortast återbetalning, annars platser per steg. */
function pipelineFact(
  leads: readonly { archived: boolean; stage: (typeof OPEN_STAGES)[number] | string }[],
  top: { name: string; payback: number | null | undefined } | null,
): string {
  if (top && top.payback !== null && top.payback !== undefined) {
    return `Kortast återbetalning: ${top.name}, ${paybackShort(top.payback)}.`;
  }
  const open = leads.filter(
    (l) => !l.archived && (OPEN_STAGES as readonly string[]).includes(l.stage),
  );
  if (open.length === 0) return "Inga platser under bearbetning.";
  const counts = OPEN_STAGES.map((s) => [s, open.filter((l) => l.stage === s).length] as const)
    .filter(([, n]) => n > 0)
    .map(([s, n]) => `${formatInt(n)} ${LEAD_STAGE_LABEL[s].toLowerCase()}`);
  return `${counts.join(", ")}.`;
}

function capitalize(text: string): string {
  return text.charAt(0).toLocaleUpperCase("sv-SE") + text.slice(1);
}

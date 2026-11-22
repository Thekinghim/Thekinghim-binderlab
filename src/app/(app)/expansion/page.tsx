import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { periodText } from "@/analytics/todos/text";
import { ButtonLink } from "@/components/v2/button";
import { PAGE_BODY, PageIntro } from "@/components/v2/page-intro";
import type { SearchParamsInput } from "@/components/shell/period-state";
import { formatInt } from "@/lib/format";

import { DataStartNote } from "./_components/evidence";
import { PriceChangeView, SiteEstimateView } from "./_components/estimate-view";
import { GoalsView } from "./_components/goals-view";
import { PlanView } from "./_components/plan-view";
import { PipelineView, StoreProfilesView } from "./_components/pipeline-view";
import { NewMachineForm, PriceChangeForm } from "./_components/scenario-forms";
import { LEAD_PREFIX, loadExpansionPage, type Names } from "./_lib/data";
import { kr, monthLabel, oreToInput, paybackShort } from "./_lib/display";
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
        : `Ni har ${formatInt(g.machinesNow)} automater i dag och planerar ${formatInt(g.perMonth)} ${g.perMonth === 1 ? "ny" : "nya"} i månaden.`;
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
    <div className={PAGE_BODY}>
      <div className="flex flex-col gap-3">
        <PageIntro
          title={title}
          aside={aside}
          facts={
            view === "plan" && growth.basisPeriod
              ? [{ label: "Underlag", value: periodText(growth.basisPeriod) }]
              : undefined
          }
          actions={
            <ButtonLink
              href={`/expansion/saljunderlag?from=${data.period.period.start}&to=${data.period.period.end}`}
              touch
            >
              Säljunderlag (PDF)
            </ButtonLink>
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
            { value: "pipeline", label: "Nya platser", count: openLeads },
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
            refillMeasurement={growth.refillMeasurement}
          />
        </section>
      ) : null}

      {view === "scenarier" ? (
        <>
          <section id="ny-automat" aria-labelledby="ny-automat-h" className="v2-card scroll-mt-28">
            <div className="v2-card-body flex min-w-0 flex-col gap-5">
              <SectionLead
                id="ny-automat-h"
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
                <p className="text-v2-sm text-v2-mute">
                  Ange investeringen.{" "}
                  <Link className="underline underline-offset-4" href="/automater/enhetsekonomi">
                    Enhetsekonomi →
                  </Link>
                </p>
              )}
            </div>
          </section>

          <section
            id="prisandring"
            aria-labelledby="prisandring-h"
            className="v2-card scroll-mt-28"
          >
            <div className="v2-card-body flex min-w-0 flex-col gap-5">
              <SectionLead
                id="prisandring-h"
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
                <p className="text-v2-sm text-v2-mute">Ingen försäljning i perioden.</p>
              )}
            </div>
          </section>
        </>
      ) : null}

      {view === "mal" ? (
        <section id="mal" aria-labelledby="mal-h" className="v2-card scroll-mt-28">
          <div className="v2-card-body flex min-w-0 flex-col gap-5">
            <SectionLead
              id="mal-h"
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
          </div>
        </section>
      ) : null}

      {view === "pipeline" ? (
        <>
          <section id="pipeline" aria-labelledby="pipeline-h" className="v2-card scroll-mt-28">
            <div className="v2-card-body flex min-w-0 flex-col gap-5">
              <SectionLead
                id="pipeline-h"
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
            </div>
          </section>

          <details id="platsprofiler" className="v2-card group scroll-mt-28">
            <summary className="v2-card-hd cursor-pointer list-none [&::-webkit-details-marker]:hidden">
              <h2>Platsprofiler</h2>
              <span className="meta text-v2-mute">
                {missingProfiles === 0
                  ? "Alla har typ och ort"
                  : `${formatInt(missingProfiles)} saknar typ eller ort`}
              </span>
            </summary>
            <div className="v2-card-body">
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

/** Rubriken i ett kort: en mening (16 px halvfet), en grå rad och en valfri förklaring. */
function SectionLead({
  id,
  title,
  aside,
  description,
}: {
  id: string;
  title: string;
  aside?: string;
  description?: string;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <h2 id={id} className="text-v2-lg font-[550] text-balance text-v2-ink">
        {title}
      </h2>
      {aside ? <p className="text-v2-md text-v2-mute">{aside}</p> : null}
      {description ? <p className="text-v2-sm text-v2-mute">{description}</p> : null}
    </div>
  );
}

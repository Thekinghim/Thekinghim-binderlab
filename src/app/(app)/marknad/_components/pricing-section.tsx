import type { PriceChangeEffect, PriceEffectVerdict } from "@/analytics/pricing";
import { Panel, PanelSection } from "@/components/ui/frame";
import { SectionHeader } from "@/components/ui/section-header";
import { StateMessage } from "@/components/ui/state-message";
import { StatusTag, type Status } from "@/components/ui/status-tag";
import { formatInt, formatNumber } from "@/lib/format";
import {
  dayText,
  deltaOfBp,
  kronor,
  percentOfBp,
  periodLabel,
  signedKronorWhole,
  tenthsNumber,
} from "@/server/market/display";
import type { ExperimentView, PricingView } from "@/server/market/model";

import { startExperiment, stopExperiment } from "../actions";
import type { SectionContext } from "../_lib/context";
import { ActionButton } from "./action-button";
import { Evidence } from "./evidence";

const VERDICT: Record<PriceEffectVerdict, { label: string; status: Status }> = {
  clear: { label: "Tydlig effekt", status: "ok" },
  uncertain: { label: "Osäker", status: "neutral" },
  "too-early": { label: "För tidigt", status: "neutral" },
  "no-data": { label: "Underlag saknas", status: "offline" },
};

function EffectFigures({ effect }: { effect: PriceChangeEffect }) {
  return (
    <dl className="grid grid-cols-2 gap-x-8 gap-y-3 sm:grid-cols-4">
      <div className="flex flex-col gap-1">
        <dt className="label text-subtle">Pack före / efter</dt>
        <dd className="tnum text-lg">
          {formatInt(effect.unitsBefore)} / {formatInt(effect.unitsAfter)}
        </dd>
      </div>
      <div className="flex flex-col gap-1">
        <dt className="label text-subtle">Väntat utan ändring</dt>
        <dd className="tnum text-lg">
          {effect.expectedUnitsAfterTenths === null
            ? "–"
            : tenthsNumber(effect.expectedUnitsAfterTenths)}
        </dd>
      </div>
      <div className="flex flex-col gap-1">
        <dt className="label text-subtle">Effekt på volym</dt>
        <dd className="tnum text-lg">
          {effect.effectBp === null ? "–" : deltaOfBp(effect.effectBp)}
        </dd>
      </div>
      <div className="flex flex-col gap-1">
        <dt className="label text-subtle">Bidrag/vecka</dt>
        <dd className="tnum text-lg">
          {effect.contributionEffectPerWeekOre === null
            ? "–"
            : signedKronorWhole(effect.contributionEffectPerWeekOre)}
        </dd>
      </div>
    </dl>
  );
}

function EffectBlock({ effect, ctx }: { effect: PriceChangeEffect; ctx: SectionContext }) {
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <EffectFigures effect={effect} />
      <p className="max-w-3xl text-muted">{effect.text}</p>
      {effect.elasticityHundredths !== null ? (
        <p className="meta text-subtle">
          Elasticitet {formatNumber(effect.elasticityHundredths / 100, 2)}
          {effect.noiseBp !== null
            ? ` · vanlig variation upp till ${percentOfBp(effect.noiseBp, 0)}`
            : ""}
        </p>
      ) : null}
      <Evidence evidence={effect.evidence} names={ctx.names} />
      {effect.control !== "none" ? (
        <Evidence
          label={effect.control === "machines" ? "Kontrollautomater" : "Jämförelsegrupp"}
          evidence={effect.controlEvidence}
          names={ctx.names}
        />
      ) : null}
    </div>
  );
}

/** Syns testpriset i testautomaternas order? Visas före utvärderingen, med underlag. */
function PriceCheck({ view, ctx }: { view: ExperimentView; ctx: SectionContext }) {
  const check = view.priceCheck;
  if (check === null) {
    if (view.status === "stopped") return null;
    return (
      <StateMessage
        kind="empty"
        compact
        code="Ej mätt"
        message={`Testet startar ${dayText(view.row.startedOn, ctx.today)}. Mätningen börjar när den dagen är slut; då kontrolleras också att testpriset syns i orderna.`}
      />
    );
  }
  const evidence = {
    rule: `Testautomaternas order för titeln från startdagen till och med ${dayText(check.period.end, ctx.today)}; en order räknas till testpriset när beloppet är exakt ${kronor(view.row.toOre)}. Utvärderingen visas först när testpriset syns i orderna.`,
    period: check.period,
    orderIds: check.orderIds,
    dates: [],
    titleIds: [view.row.titleId],
    machineIds: view.row.testMachineIds,
    figures: [
      { key: "orders", label: "Order i testautomaterna", value: check.orders, unit: "count" },
      { key: "atTest", label: "Varav till testpriset", value: check.atTestPrice, unit: "count" },
      { key: "toOre", label: "Testpris", value: view.row.toOre, unit: "ore" },
    ] as const,
  };
  return (
    <div className="flex min-w-0 flex-col gap-2">
      {check.status === "missing" ? (
        <StateMessage
          kind="not-configured"
          code="Testpriset syns inte"
          compact
          message={check.text}
        />
      ) : (
        <p className={check.status === "partial" ? "max-w-3xl text-fg" : "meta text-subtle"}>
          {check.text}
        </p>
      )}
      <Evidence label="Kontroll av testpriset" evidence={evidence} names={ctx.names} />
    </div>
  );
}

const EXPERIMENT_STATUS: Record<ExperimentView["status"], { label: string; status: Status }> = {
  planned: { label: "Startar", status: "neutral" },
  running: { label: "Pågår", status: "ok" },
  done: { label: "Klart", status: "neutral" },
  stopped: { label: "Stoppat", status: "offline" },
};

export function PricingSection({
  pricing,
  period,
  ctx,
}: {
  pricing: PricingView;
  period: { start: string; end: string };
  ctx: SectionContext;
}) {
  const changes = pricing.changes.ok ? pricing.changes.value : [];
  const proposals = pricing.proposals.ok ? pricing.proposals.value : [];
  const clear = changes.find((c) => c.effect.ok && c.effect.value.verdict === "clear");
  const title =
    changes.length === 0
      ? `Ingen prisändring ${periodLabel(period)}.`
      : `${formatInt(changes.length + pricing.moreChanges)} ${changes.length + pricing.moreChanges === 1 ? "prisändring" : "prisändringar"} ${periodLabel(period)}.`;
  const aside =
    clear && clear.effect.ok && clear.effect.value.effectBp !== null
      ? `${ctx.names.title[clear.change.titleId] ?? ""} ${dayText(clear.change.date, ctx.today)}: volymen ${deltaOfBp(clear.effect.value.effectBp)} mot väntat.`
      : proposals.length > 0
        ? `${formatInt(proposals.length)} ${proposals.length === 1 ? "pristest föreslås" : "pristester föreslås"} som experiment.`
        : changes.length > 0
          ? "Ingen effekt är tydligare än den vanliga variationen."
          : "Inga pristester föreslås just nu.";

  return (
    <section
      aria-labelledby="prissattning-rubrik"
      className="flex scroll-mt-28 flex-col gap-8"
      id="prissattning"
    >
      <SectionHeader
        id="prissattning-rubrik"
        index={4}
        eyebrow="Prissättning"
        title={title}
        aside={aside}
      />

      {!pricing.changes.ok ? <StateMessage kind="error" message={pricing.changes.message} /> : null}

      {changes.length > 0 ? (
        <div className="flex flex-col gap-6">
          {changes.map(({ change, effect }) => (
            <Panel key={change.key}>
              <article className="flex min-w-0 flex-col gap-4" aria-label={change.text}>
                <header className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                  <div className="flex min-w-0 flex-col gap-1">
                    <p className="label text-subtle">
                      {dayText(change.date, ctx.today)} · {kronor(change.fromOre)} →{" "}
                      {kronor(change.toOre)}
                    </p>
                    <h3 className="text-lg font-medium text-balance">{change.text}</h3>
                  </div>
                  {effect.ok ? (
                    <StatusTag status={VERDICT[effect.value.verdict].status}>
                      {VERDICT[effect.value.verdict].label}
                    </StatusTag>
                  ) : null}
                </header>
                {effect.ok ? (
                  <EffectBlock effect={effect.value} ctx={ctx} />
                ) : (
                  <StateMessage kind="error" compact message={effect.message} />
                )}
                <Evidence
                  label="Hur ändringen hittades"
                  evidence={change.evidence}
                  names={ctx.names}
                />
              </article>
            </Panel>
          ))}
          {pricing.moreChanges > 0 ? (
            <p className="text-sm text-subtle">
              och {formatInt(pricing.moreChanges)} äldre i perioden.
            </p>
          ) : null}
        </div>
      ) : (
        <StateMessage
          kind="empty"
          message={`Inget pris har ändrats ${periodLabel(period)} enligt orderna (vanligaste beloppet per dag, tre dagar i rad).`}
        />
      )}

      <PanelSection label={`Pristester · experiment`}>
        {!pricing.proposals.ok ? (
          <StateMessage kind="error" compact message={pricing.proposals.message} />
        ) : proposals.length === 0 ? (
          <StateMessage
            kind="empty"
            compact
            code="0 förslag"
            message="Ingen titel uppfyller villkoren för ett pristest: minst två automater, känt bidrag, tillräcklig volym och inget nytt pris de senaste 90 dagarna."
          />
        ) : (
          <ul className="flex flex-col gap-6">
            {proposals.map((p) => (
              <li key={p.key} className="flex min-w-0 flex-col gap-3 border-b border-line pb-4">
                <div className="flex flex-wrap items-center gap-3">
                  <span className="label border border-dashed border-line-control px-2 py-0.5 text-fg">
                    {p.label}
                  </span>
                  <span className="meta text-subtle">
                    {ctx.names.title[p.titleId] ?? p.titleId} · {kronor(p.fromOre)} →{" "}
                    {kronor(p.toOre)} · {periodLabel(p.period)}
                  </span>
                </div>
                <p className="max-w-3xl text-muted">{p.text}</p>
                <dl className="meta flex flex-wrap gap-x-6 gap-y-1 text-subtle">
                  <div>
                    <dt className="inline">Test: </dt>
                    <dd className="inline text-muted">
                      {p.testMachineIds.map((id) => ctx.names.machine[id] ?? id).join(", ")}
                    </dd>
                  </div>
                  <div>
                    <dt className="inline">Kontroll: </dt>
                    <dd className="inline text-muted">
                      {p.controlMachineIds.map((id) => ctx.names.machine[id] ?? id).join(", ")}
                    </dd>
                  </div>
                  <div>
                    <dt className="inline">Väntade pack: </dt>
                    <dd className="inline text-muted">
                      {formatInt(p.expectedTestUnits)} / {formatInt(p.expectedControlUnits)}
                    </dd>
                  </div>
                </dl>
                <Evidence evidence={p.evidence} names={ctx.names} />
                {ctx.canEdit ? (
                  <div>
                    <ActionButton
                      action={startExperiment}
                      payload={{ proposalKey: p.key }}
                      success="Pristestet är planerat"
                      confirm={{
                        eyebrow: "Experiment",
                        title: `Starta pristest för ${ctx.names.title[p.titleId] ?? "titeln"}`,
                        description: `Ändra priset till ${kronor(p.toOre)} i testautomaterna från ${dayText(p.period.start, ctx.today)}. Priset ändras i Awish, inte här. Panelen kontrollerar i orderna att testpriset tagits i bruk och mäter effekten mot kontrollautomaterna från första hela dagen.`,
                        confirmLabel: "Starta",
                      }}
                    >
                      Starta pristest
                    </ActionButton>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </PanelSection>

      {pricing.experiments.length > 0 ? (
        <PanelSection label={`Startade pristester · ${formatInt(pricing.experiments.length)}`}>
          <ul className="flex flex-col gap-6">
            {pricing.experiments.map((e) => (
              <li key={e.row.id} className="flex min-w-0 flex-col gap-3 border-b border-line pb-4">
                <div className="flex flex-wrap items-center gap-3">
                  <StatusTag status={EXPERIMENT_STATUS[e.status].status}>
                    {EXPERIMENT_STATUS[e.status].label}
                  </StatusTag>
                  <span className="meta text-subtle">
                    {ctx.names.title[e.row.titleId] ?? e.row.titleId} · {kronor(e.row.fromOre)} →{" "}
                    {kronor(e.row.toOre)} · {dayText(e.row.startedOn, ctx.today)}–
                    {dayText(e.row.stoppedOn ?? e.endsOn, ctx.today)}
                  </span>
                </div>
                {e.row.text ? <p className="max-w-3xl text-muted">{e.row.text}</p> : null}
                <PriceCheck view={e} ctx={ctx} />
                {e.evaluation === null ? null : e.evaluation.ok ? (
                  <EffectBlock effect={e.evaluation.value} ctx={ctx} />
                ) : (
                  <StateMessage kind="error" compact message={e.evaluation.message} />
                )}
                {ctx.canEdit && (e.status === "planned" || e.status === "running") ? (
                  <div>
                    <ActionButton
                      action={stopExperiment}
                      payload={{ id: e.row.id }}
                      variant="ghost"
                      success={
                        e.status === "planned" ? "Pristestet borttaget" : "Pristestet stoppat"
                      }
                      confirm={{
                        eyebrow: "Experiment",
                        title: e.status === "planned" ? "Ta bort pristestet" : "Stoppa pristestet",
                        description:
                          e.status === "planned"
                            ? "Testet har inte mätts någon hel dag och tas bort. Har priset redan ändrats i automaterna, återställ det i Awish."
                            : "Testet mäts till och med i går, sista hela dagen. Återställ priset i testautomaterna i Awish.",
                        confirmLabel: e.status === "planned" ? "Ta bort" : "Stoppa",
                        danger: true,
                      }}
                    >
                      {e.status === "planned" ? "Ta bort" : "Stoppa"}
                    </ActionButton>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        </PanelSection>
      ) : null}
    </section>
  );
}

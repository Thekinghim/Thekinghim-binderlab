import Link from "next/link";

import type { AssortmentChange } from "@/analytics/assortment";
import { Panel, PanelSection } from "@/components/ui/frame";
import { SectionHeader } from "@/components/ui/section-header";
import { StateMessage } from "@/components/ui/state-message";
import { StatusTag } from "@/components/ui/status-tag";
import { formatInt } from "@/lib/format";
import {
  dayText,
  kronor,
  periodLabel,
  percentOfBp,
  signedKronorWhole,
  tenthsNumber,
} from "@/server/market/display";
import type { AssortmentMachineView, AssortmentView } from "@/server/market/model";

import type { SectionContext } from "../_lib/context";
import { Evidence } from "./evidence";
import { ImplementButton } from "./implement-button";
import { SlotsEditorButton, type SlotLine } from "./slots-editor";
import { Cell, Row, Table } from "./table";

/** Fackfördelning i dag och förifyllning per automat. */
export type SlotInfo = Readonly<
  Record<string, { current: readonly SlotLine[]; prefill: readonly SlotLine[] }>
>;

function changeWord(c: AssortmentChange): string {
  switch (c.kind) {
    case "add":
      return "Lägg till";
    case "remove":
      return "Ta bort";
    case "increase":
      return "Fler fack";
    case "decrease":
      return "Färre fack";
  }
}

function MachineCard({
  view,
  slots,
  ctx,
  period,
}: {
  view: AssortmentMachineView;
  slots: SlotInfo;
  ctx: SectionContext;
  period: { start: string; end: string };
}) {
  const rec = view.recommendation;
  const info = slots[view.machineId] ?? { current: [], prefill: [] };
  const headingId = `sortiment-${view.machineId}`;
  return (
    <Panel>
      <article aria-labelledby={headingId} className="flex min-w-0 flex-col gap-5">
        <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex min-w-0 flex-col gap-1">
            <p className="label text-subtle">
              {formatInt(view.currentSlots)} av {formatInt(view.capacity)} fack
            </p>
            <h3 id={headingId} className="text-lg font-medium text-balance">
              <span className="meta text-fg">{view.code}</span>
              {rec
                ? rec.action === "change"
                  ? ` · ${signedKronorWhole(rec.effectPerWeekOre)}/vecka med nytt sortiment.`
                  : " · behåll sortimentet."
                : "."}
            </h3>
          </div>
          <div className="shrink-0">
            {rec?.action === "change" ? (
              view.implemented ? (
                <StatusTag status="ok">
                  Genomförd {dayText(view.implemented.implementedOn, ctx.today)}
                </StatusTag>
              ) : (
                <StatusTag status="warning">Ändring föreslås</StatusTag>
              )
            ) : (
              <StatusTag status="ok">Behåll</StatusTag>
            )}
          </div>
        </header>

        {rec ? (
          <>
            <p className="max-w-3xl text-muted">{rec.text}</p>
            {rec.changes.length > 0 ? (
              <ul className="flex flex-col gap-1" aria-label={`Ändringar i ${view.code}`}>
                {rec.changes.map((c) => (
                  <li key={c.titleId} className="flex flex-wrap items-baseline justify-between gap-x-4">
                    <span>
                      <span className="label mr-2 text-subtle">{changeWord(c)}</span>
                      {ctx.names.title[c.titleId] ?? c.titleId}{" "}
                      <span className="meta text-subtle">
                        {formatInt(c.fromSlots)} → {formatInt(c.toSlots)} fack
                      </span>
                    </span>
                    <span className="tnum">{signedKronorWhole(c.effectPerWeekOre)}/vecka</span>
                  </li>
                ))}
              </ul>
            ) : null}
            <Table
              caption={`Sortiment i ${view.code}`}
              head={[
                { label: "Titel" },
                { label: "Fack", numeric: true },
                { label: "Pack/vecka", numeric: true },
                { label: "Bidrag/pack", numeric: true, hideOnMobile: true },
                { label: "Bidrag/vecka", numeric: true, hideOnMobile: true },
                { label: "Underlag", hideOnMobile: true },
              ]}
            >
              {rec.lines.map((l) => (
                <Row key={l.titleId}>
                  <Cell header>{ctx.names.title[l.titleId] ?? l.titleId}</Cell>
                  <Cell numeric>
                    {l.currentSlots === l.recommendedSlots
                      ? formatInt(l.currentSlots)
                      : `${formatInt(l.currentSlots)} → ${formatInt(l.recommendedSlots)}`}
                  </Cell>
                  <Cell numeric className="text-muted">
                    {l.demandPerWeekTenths === null ? "–" : tenthsNumber(l.demandPerWeekTenths)}
                  </Cell>
                  <Cell numeric hideOnMobile className="text-muted">
                    {l.contributionPerPackOre === null ? "–" : kronor(l.contributionPerPackOre)}
                  </Cell>
                  <Cell numeric hideOnMobile>
                    {l.recommendedContributionPerWeekOre === null
                      ? "–"
                      : kronor(l.recommendedContributionPerWeekOre)}
                  </Cell>
                  <Cell hideOnMobile className="text-sm text-muted">
                    {l.locked === "missing-price"
                      ? "Saknar inköpspris, låst"
                      : l.locked === "too-little-data"
                        ? "För få dagar, låst"
                        : l.source === "similar"
                          ? `Liknande automater: ${l.basisMachineIds.map((id) => ctx.names.machine[id] ?? id).join(", ")}`
                          : "Egen försäljning"}
                  </Cell>
                </Row>
              ))}
            </Table>
            {rec.action === "keep" && rec.potentialEffectPerWeekOre > 0 ? (
              <p className="meta text-subtle">
                Bästa omfördelningen ger {signedKronorWhole(rec.potentialEffectPerWeekOre)}/vecka,
                under gränsen för att föreslå en ändring.
              </p>
            ) : null}
            <Evidence evidence={rec.evidence} names={ctx.names} />
          </>
        ) : (
          <StateMessage
            kind="empty"
            compact
            message={`${view.code} har fackfördelning men ingen rekommendation för ${periodLabel(period)}.`}
          />
        )}

        {ctx.canEdit ? (
          <div className="flex flex-wrap gap-2 border-t border-line pt-4">
            {rec?.action === "change" && !view.implemented ? (
              <ImplementButton
                machineId={view.machineId}
                machineCode={view.code}
                fingerprint={rec.fingerprint}
                periodStart={period.start}
                periodEnd={period.end}
                today={ctx.today}
                summary={rec.changes
                  .map((c) => `${changeWord(c)} ${ctx.names.title[c.titleId] ?? c.titleId} (${c.fromSlots} → ${c.toSlots}).`)
                  .join(" ")}
                effectText={`${signedKronorWhole(rec.effectPerWeekOre)}/vecka`}
              />
            ) : null}
            <SlotsEditorButton
              machineId={view.machineId}
              machineCode={view.code}
              titles={ctx.titleOptions}
              current={info.current}
              prefill={info.prefill}
              prefillNote={null}
              today={ctx.today}
              capacity={view.capacity}
              label="Ändra fack"
            />
          </div>
        ) : null}
      </article>
    </Panel>
  );
}

export function AssortmentSection({
  assortment,
  slots,
  ctx,
  capacity,
}: {
  assortment: AssortmentView;
  slots: SlotInfo;
  ctx: SectionContext;
  /** Fack per automat när fackfördelning saknas. */
  capacity: number;
}) {
  const machines = assortment.machines.ok ? assortment.machines.value : [];
  const changes = machines.filter(
    (m) => m.recommendation?.action === "change" && m.implemented === null,
  );
  const effect = changes.reduce((s, m) => s + (m.recommendation?.effectPerWeekOre ?? 0), 0);
  const days =
    Math.round(
      (Date.parse(assortment.period.end) - Date.parse(assortment.period.start)) / 86_400_000,
    ) + 1;
  const title =
    machines.length === 0
      ? "Ingen automat har fackfördelning."
      : changes.length > 0
        ? `${formatInt(changes.length)} av ${formatInt(machines.length)} automater kan ge ${signedKronorWhole(effect)}/vecka.`
        : `Behåll sortimentet i ${machines.length === 1 ? "automaten" : `alla ${formatInt(machines.length)} automater`}.`;
  const asideParts = [`Mätt ${periodLabel(assortment.period)}.`];
  if (assortment.withoutSlots.length > 0) {
    asideParts.push(
      `${formatInt(assortment.withoutSlots.length)} ${assortment.withoutSlots.length === 1 ? "automat saknar" : "automater saknar"} fackfördelning.`,
    );
  }
  const followUps = assortment.followUps;
  const periodQuery = new URLSearchParams({ ...ctx.query, period: "30d" });
  periodQuery.delete("from");
  periodQuery.delete("to");

  return (
    <section
      aria-labelledby="sortiment-rubrik"
      className="flex scroll-mt-28 flex-col gap-8"
      id="sortiment"
    >
      <SectionHeader
        id="sortiment-rubrik"
        index={3}
        eyebrow="Sortiment"
        title={title}
        aside={asideParts.join(" ")}
      />

      {assortment.tooShort ? (
        <StateMessage
          kind="empty"
          code={`${formatInt(days)} d`}
          message={`Perioden är ${formatInt(days)} dagar. Efterfrågan per fack kräver minst 14 dagar.`}
          action={
            <Link
              href={`?${periodQuery.toString()}#sortiment`}
              className="rounded-xs text-fg underline underline-offset-4"
            >
              Visa 30 dagar →
            </Link>
          }
        />
      ) : null}

      {!assortment.machines.ok ? (
        <StateMessage kind="error" message={assortment.machines.message} />
      ) : null}

      {assortment.withoutSlots.length > 0 ? (
        <ul className="flex flex-col gap-2" aria-label="Automater utan fackfördelning">
          {assortment.withoutSlots.map((m) => {
            const info = slots[m.id] ?? { current: [], prefill: [] };
            return (
              <li
                key={m.id}
                className="flex flex-wrap items-center justify-between gap-3 border-b border-line pb-2"
              >
                <StateMessage
                  kind="not-configured"
                  compact
                  message={`${m.code} saknar fackfördelning, så sortimentet kan inte räknas.`}
                />
                {ctx.canEdit ? (
                  <SlotsEditorButton
                    machineId={m.id}
                    machineCode={m.code}
                    titles={ctx.titleOptions}
                    current={info.current}
                    prefill={info.prefill}
                    prefillNote={
                      info.prefill.length > 0
                        ? "Förifyllt med titlarna som sålt mest i automaten under perioden, ett fack var. Stäm av mot automaten innan du sparar."
                        : null
                    }
                    today={ctx.today}
                    capacity={capacity}
                    label="Registrera fack"
                  />
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}

      {machines.length > 0 ? (
        <div className="flex flex-col gap-6">
          {machines.map((m) => (
            <MachineCard
              key={m.machineId}
              view={m}
              slots={slots}
              ctx={ctx}
              period={assortment.period}
            />
          ))}
        </div>
      ) : null}

      {followUps.length > 0 ? (
        <PanelSection label={`Uppföljning · ${formatInt(followUps.length)} genomförda`}>
          <ul className="flex flex-col gap-6">
            {followUps.map(({ change, followUp }) => (
              <li key={change.id} className="flex min-w-0 flex-col gap-3 border-b border-line pb-4">
                <div className="flex flex-wrap items-center gap-3">
                  <span className="meta text-fg">{ctx.names.machine[change.machineId] ?? change.machineId}</span>
                  <span className="meta text-subtle">
                    Genomförd {dayText(change.implementedOn, ctx.today)} · väntat{" "}
                    {signedKronorWhole(change.expectedEffectPerWeekOre)}/vecka
                  </span>
                  {followUp.ok ? (
                    <StatusTag status="neutral">
                      {followUp.value.status === "done"
                        ? "Klar"
                        : followUp.value.status === "running"
                          ? "Pågår"
                          : "För tidigt"}
                    </StatusTag>
                  ) : null}
                </div>
                {followUp.ok ? (
                  <>
                    <dl className="grid grid-cols-2 gap-x-8 gap-y-3 sm:grid-cols-4">
                      <div className="flex flex-col gap-1">
                        <dt className="label text-subtle">Bidrag/vecka före</dt>
                        <dd className="tnum text-lg">
                          {kronor(followUp.value.contributionPerWeekBeforeOre)}
                        </dd>
                      </div>
                      <div className="flex flex-col gap-1">
                        <dt className="label text-subtle">Efter</dt>
                        <dd className="tnum text-lg">
                          {kronor(followUp.value.contributionPerWeekAfterOre)}
                        </dd>
                      </div>
                      <div className="flex flex-col gap-1">
                        <dt className="label text-subtle">Justerad förändring</dt>
                        <dd className="tnum text-lg">
                          {signedKronorWhole(followUp.value.adjustedChangePerWeekOre)}
                        </dd>
                      </div>
                      <div className="flex flex-col gap-1">
                        <dt className="label text-subtle">Av väntad effekt</dt>
                        <dd className="tnum text-lg">
                          {followUp.value.achievedBp === null
                            ? "–"
                            : percentOfBp(followUp.value.achievedBp, 0)}
                        </dd>
                      </div>
                    </dl>
                    <p className="max-w-3xl text-muted">{followUp.value.text}</p>
                    <Evidence evidence={followUp.value.evidence} names={ctx.names} />
                    {followUp.value.control.machineIds.length > 0 ? (
                      <Evidence
                        label="Jämförelsegrupp"
                        evidence={followUp.value.controlEvidence}
                        names={ctx.names}
                      />
                    ) : null}
                  </>
                ) : (
                  <StateMessage kind="error" compact message={followUp.message} />
                )}
              </li>
            ))}
          </ul>
        </PanelSection>
      ) : null}
    </section>
  );
}

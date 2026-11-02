import { Panel, PanelSection } from "@/components/ui/frame";
import { SectionHeader } from "@/components/ui/section-header";
import { StateMessage } from "@/components/ui/state-message";
import { StatusTag } from "@/components/ui/status-tag";
import { formatInt, NBSP } from "@/lib/format";
import { dayText, deltaOfBp, packs, tenthsNumber } from "@/server/market/display";
import type { ReleaseView } from "@/server/market/model";

import { deleteRelease, lockReleasePlan, unlockReleasePlan } from "../actions";
import type { SectionContext } from "../_lib/context";
import { ActionButton } from "./action-button";
import { Evidence } from "./evidence";
import { ReleaseFormButton, type ReleaseFormValues } from "./release-form";
import { Cell, Row, Table } from "./table";

function daysText(n: number): string {
  return `${formatInt(n)}${NBSP}${n === 1 ? "dag" : "dagar"}`;
}

function statusTag(view: ReleaseView) {
  if (view.status === "upcoming") {
    if (view.needsAction) {
      return <StatusTag status="critical">Förslaget ej fastställt</StatusTag>;
    }
    return (
      <StatusTag status="neutral">
        {view.daysUntil === 1 ? "I morgon" : `Om ${daysText(view.daysUntil)}`}
      </StatusTag>
    );
  }
  if (view.status === "running") {
    return (
      <StatusTag status="ok">
        Dag {formatInt(-view.daysUntil + 1)} av {formatInt(view.row.horizonDays)}
      </StatusTag>
    );
  }
  return <StatusTag status="neutral">Avslutat</StatusTag>;
}

function formValues(view: ReleaseView): ReleaseFormValues {
  const r = view.row;
  return {
    id: r.id,
    name: r.name,
    series: r.series ?? "",
    releaseDate: r.releaseDate,
    titleId: r.titleId ?? "",
    supplierId: r.supplierId ?? "",
    scalePercent: String(r.scaleBp / 100).replace(".", ","),
    horizonDays: String(r.horizonDays),
    boxSize: String(r.boxSize),
    minOrderQty: String(r.minOrderQty),
    note: r.note ?? "",
    locked: r.planLockedAt !== null,
  };
}

function paceText(pace: string | null): string {
  if (pace === "ahead") return "Före förslaget";
  if (pace === "behind") return "Efter förslaget";
  if (pace === "on-track") return "I linje";
  return "–";
}

function Suggestion({ view, ctx }: { view: ReleaseView; ctx: SectionContext }) {
  if (!view.suggestion) return null;
  if (!view.suggestion.ok) {
    return <StateMessage kind="error" compact message={view.suggestion.message} />;
  }
  const s = view.suggestion.value;
  if (s.status !== "ok") {
    return <StateMessage kind="empty" code="Inget förslag" compact message={s.text} />;
  }
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1">
        <p className="text-2xl font-medium tnum">Köp {packs(s.purchaseUnits)}</p>
        <p className="meta text-subtle">
          {s.boxSize > 1 ? `${formatInt(s.boxes)} lådor à ${formatInt(s.boxSize)} · ` : ""}
          {formatInt(s.machineUnits)} till automaterna
          {s.warehouseUnits > 0 ? ` · ${formatInt(s.warehouseUnits)} till lagret` : ""}
        </p>
      </div>
      <p className="max-w-3xl text-muted">{s.text}</p>
      <Table
        caption={`Fördelning per automat för ${view.row.name}`}
        head={[
          { label: "Automat" },
          { label: "Pack", numeric: true },
          { label: "Väntat", numeric: true },
          { label: "Underlag", hideOnMobile: true },
        ]}
      >
        {s.allocations.map((a) => (
          <Row key={a.machineId}>
            <Cell header className="meta text-fg">
              {ctx.names.machine[a.machineId] ?? a.machineId}
            </Cell>
            <Cell numeric>{formatInt(a.units)}</Cell>
            <Cell numeric className="text-muted">
              {tenthsNumber(a.expectedTenths)}
            </Cell>
            <Cell hideOnMobile className="text-sm text-muted">
              {a.source === "history"
                ? `Median av egna släpp: ${a.historyUnits.join(", ")} pack`
                : "Typisk automat (ingen egen släpphistorik)"}
            </Cell>
          </Row>
        ))}
      </Table>
      {s.weeklyUnits.length > 0 ? (
        <p className="meta text-subtle">
          Väntad försäljning per vecka:{" "}
          {s.weeklyUnits.map((u, i) => `v${i + 1} ${formatInt(u)}`).join(" · ")}
        </p>
      ) : null}
      <Evidence
        evidence={s.evidence}
        names={ctx.names}
        extra={
          view.suggestionAsOf < ctx.today ? (
            <p className="meta text-subtle">
              Förslaget räknat per {dayText(view.suggestionAsOf, ctx.today)}, dagen före släppet.
            </p>
          ) : null
        }
      />
    </div>
  );
}

function Plan({ view, ctx }: { view: ReleaseView; ctx: SectionContext }) {
  const plan = view.plan!;
  const r = view.row;
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1">
        <p className="text-2xl font-medium tnum">Köp {packs(r.planPurchaseUnits ?? 0)}</p>
        <p className="meta text-subtle">
          Fastställt {r.planLockedAt ? dayText(r.planLockedAt.slice(0, 10), ctx.today) : ""} ·{" "}
          {formatInt(plan.reduce((sum, a) => sum + a.units, 0))} till automaterna
        </p>
      </div>
      {r.planText ? <p className="max-w-3xl text-muted">{r.planText}</p> : null}
      <Table
        caption={`Fastställd fördelning för ${r.name}`}
        head={[{ label: "Automat" }, { label: "Pack", numeric: true }]}
      >
        {plan.map((a) => (
          <Row key={a.id}>
            <Cell header className="meta text-fg">
              {ctx.names.machine[a.machineId] ?? a.machineId}
            </Cell>
            <Cell numeric>{formatInt(a.units)}</Cell>
          </Row>
        ))}
      </Table>
    </div>
  );
}

function Outcome({ view, ctx }: { view: ReleaseView; ctx: SectionContext }) {
  if (view.outcomeMissing) {
    return <StateMessage kind="empty" code="Utfall saknas" compact message={view.outcomeMissing} />;
  }
  if (!view.outcome) return null;
  if (!view.outcome.ok) {
    return <StateMessage kind="error" compact message={view.outcome.message} />;
  }
  const o = view.outcome.value;
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <dl className="grid grid-cols-2 gap-x-8 gap-y-3 sm:grid-cols-4">
        <div className="flex flex-col gap-1">
          <dt className="label text-subtle">Sålt</dt>
          <dd className="text-xl font-medium tnum">{packs(o.actual)}</dd>
        </div>
        <div className="flex flex-col gap-1">
          <dt className="label text-subtle">Väntat hittills</dt>
          <dd className="text-xl font-medium tnum">{tenthsNumber(o.expectedByNowTenths)}</dd>
        </div>
        <div className="flex flex-col gap-1">
          <dt className="label text-subtle">Lika mot lika</dt>
          <dd className="text-xl font-medium tnum">
            {o.plannedDiffBp === null ? "–" : deltaOfBp(o.plannedDiffBp)}
          </dd>
        </div>
        <div className="flex flex-col gap-1">
          <dt className="label text-subtle">Läge</dt>
          <dd className="text-xl font-medium">{paceText(o.pace)}</dd>
        </div>
      </dl>
      <p className="max-w-3xl text-muted">{o.text}</p>
      {view.outcomeBasis === "suggestion" ? (
        <p className="meta text-subtle">
          Förslaget fastställdes inte; utfallet jämförs med förslaget per{" "}
          {dayText(view.suggestionAsOf, ctx.today)}.
        </p>
      ) : null}
      {o.machines.length > 0 ? (
        <Table
          caption={`Utfall per automat för ${view.row.name}`}
          head={[
            { label: "Automat" },
            { label: "Föreslaget", numeric: true },
            { label: "Väntat", numeric: true },
            { label: "Sålt", numeric: true },
            { label: "Avvikelse", numeric: true, hideOnMobile: true },
            { label: "Slutsålt", hideOnMobile: true },
          ]}
        >
          {o.machines.map((m) => (
            <Row key={m.machineId}>
              <Cell header className="meta text-fg">
                {ctx.names.machine[m.machineId] ?? m.machineId}
              </Cell>
              <Cell numeric>{formatInt(m.allocated)}</Cell>
              <Cell numeric className="text-muted">
                {tenthsNumber(m.expectedByNowTenths)}
              </Cell>
              <Cell numeric>{formatInt(m.actual)}</Cell>
              <Cell numeric hideOnMobile>
                {m.diffBp === null ? "–" : deltaOfBp(m.diffBp)}
              </Cell>
              <Cell hideOnMobile className="text-sm text-muted">
                {m.soldOutDate ? dayText(m.soldOutDate, ctx.today) : "–"}
              </Cell>
            </Row>
          ))}
        </Table>
      ) : null}
      <Evidence evidence={o.evidence} names={ctx.names} />
    </div>
  );
}

function ReleaseCard({ view, ctx }: { view: ReleaseView; ctx: SectionContext }) {
  const r = view.row;
  const locked = r.planLockedAt !== null;
  const canLock =
    ctx.canEdit &&
    !locked &&
    view.status === "upcoming" &&
    view.suggestion?.ok === true &&
    view.suggestion.value.status === "ok";
  const headingId = `slapp-${r.id}`;
  return (
    <Panel>
      <article aria-labelledby={headingId} className="flex min-w-0 flex-col gap-5">
        <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex min-w-0 flex-col gap-1">
            <p className="label text-subtle">
              {dayText(r.releaseDate, ctx.today)}
              {r.series ? ` · ${r.series}` : ""}
            </p>
            <h3 id={headingId} className="text-lg font-medium text-balance">
              {r.name}.
            </h3>
            <p className="meta text-subtle">
              {view.titleName ? `Titel: ${view.titleName}` : "Ingen titel kopplad"}
              {view.supplierName ? ` · ${view.supplierName}` : ""}
              {r.scaleBp !== 10_000 ? ` · storlek ${formatInt(r.scaleBp / 100)}${NBSP}%` : ""}
            </p>
          </div>
          <div className="shrink-0">{statusTag(view)}</div>
        </header>

        {view.status === "upcoming" ? (
          locked ? (
            <Plan view={view} ctx={ctx} />
          ) : (
            <Suggestion view={view} ctx={ctx} />
          )
        ) : (
          <>
            {locked ? (
              <PanelSection label="Fastställt förslag">
                <Plan view={view} ctx={ctx} />
              </PanelSection>
            ) : null}
            <PanelSection label={`Utfall · ${daysText(Math.min(-view.daysUntil + 1, r.horizonDays))}`}>
              <Outcome view={view} ctx={ctx} />
            </PanelSection>
          </>
        )}

        {ctx.canEdit ? (
          <div className="flex flex-wrap gap-2 border-t border-line pt-4">
            {canLock ? (
              <ActionButton
                action={lockReleasePlan}
                payload={{ releaseId: r.id }}
                variant="primary"
                success="Förslaget fastställt"
                confirm={{
                  eyebrow: r.name,
                  title: "Fastställ förslaget",
                  description:
                    "Inköpsmängden och fördelningen sparas som de står. Utfallet efter släppet mäts mot det sparade förslaget.",
                  confirmLabel: "Fastställ",
                }}
              >
                Fastställ förslag
              </ActionButton>
            ) : null}
            {locked && view.status === "upcoming" ? (
              <ActionButton
                action={unlockReleasePlan}
                payload={{ releaseId: r.id }}
                success="Förslaget upplåst"
                confirm={{
                  eyebrow: r.name,
                  title: "Lås upp förslaget",
                  description:
                    "Den sparade fördelningen tas bort och förslaget räknas om från dagens underlag.",
                  confirmLabel: "Lås upp",
                }}
              >
                Lås upp
              </ActionButton>
            ) : null}
            <ReleaseFormButton
              label="Ändra"
              variant="ghost"
              titles={ctx.titleOptions}
              suppliers={ctx.supplierOptions}
              supplierItems={ctx.supplierItems}
              initial={formValues(view)}
            />
            <ActionButton
              action={deleteRelease}
              payload={{ id: r.id }}
              variant="ghost"
              success="Släppet borttaget"
              confirm={{
                eyebrow: r.name,
                title: "Ta bort släppet",
                description:
                  "Släppet och en eventuell fastställd fördelning tas bort. Order och lager påverkas inte.",
                confirmLabel: "Ta bort",
                danger: true,
              }}
            >
              Ta bort
            </ActionButton>
          </div>
        ) : null}
      </article>
    </Panel>
  );
}

export function ReleasesSection({
  releases,
  ctx,
}: {
  releases: readonly ReleaseView[];
  ctx: SectionContext;
}) {
  const upcoming = releases.filter((r) => r.status === "upcoming");
  const running = releases.filter((r) => r.status === "running");
  const done = releases.filter((r) => r.status === "done").reverse();
  const next = upcoming[0];
  const title =
    upcoming.length === 0
      ? "Inga kommande släpp."
      : `${formatInt(upcoming.length)} ${upcoming.length === 1 ? "kommande släpp" : "kommande släpp"}.`;
  let aside: string;
  if (next) {
    const s = next.suggestion;
    aside =
      next.plan !== null
        ? `Närmast: ${next.row.name} om ${daysText(next.daysUntil)}, fastställt ${packs(next.row.planPurchaseUnits ?? 0)}.`
        : s?.ok && s.value.status === "ok"
          ? `Närmast: ${next.row.name} om ${daysText(next.daysUntil)}, förslaget är ${packs(s.value.purchaseUnits)}.`
          : `Närmast: ${next.row.name} om ${daysText(next.daysUntil)}, inget förslag ännu.`;
  } else if (running.length > 0) {
    aside = `${formatInt(running.length)} släpp följs upp just nu.`;
  } else {
    aside =
      releases.length === 0
        ? "Ingen release är inlagd."
        : `${formatInt(done.length)} avslutade släpp.`;
  }
  const visible = [...upcoming, ...running, ...done];
  return (
    <section aria-labelledby="releaser-rubrik" className="flex scroll-mt-28 flex-col gap-8" id="releaser">
      <SectionHeader
        id="releaser-rubrik"
        index={1}
        eyebrow="Releasekalender"
        title={title}
        aside={aside}
        actions={
          ctx.canEdit ? (
            <ReleaseFormButton
              label="Nytt släpp"
              titles={ctx.titleOptions}
              suppliers={ctx.supplierOptions}
              supplierItems={ctx.supplierItems}
            />
          ) : undefined
        }
      />
      {visible.length === 0 ? (
        <StateMessage
          kind="empty"
          message="Ingen release är inlagd. Med släppdag och serie räknas förslag på inköp och fördelning per automat fram från tidigare släpp."
        />
      ) : (
        <div className="flex flex-col gap-6">
          {visible.map((v) => (
            <ReleaseCard key={v.row.id} view={v} ctx={ctx} />
          ))}
        </div>
      )}
    </section>
  );
}

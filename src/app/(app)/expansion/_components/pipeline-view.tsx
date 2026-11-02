"use client";

import { useMemo, useState } from "react";

import type { LeadPotential } from "@/analytics/expansion";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/field";
import { StateMessage } from "@/components/ui/state-message";
import { cn } from "@/lib/cn";
import { formatInt, MISSING } from "@/lib/format";

import { deleteLead, saveLead, saveStoreProfile, setLeadArchived, setLeadStage } from "../actions";
import { bpToInput, kr, oreToInput, paybackShort } from "../_lib/display";
import type { Named } from "../_lib/data";
import {
  LEAD_STAGE_LABEL,
  LEAD_STAGES,
  OPEN_STAGES,
  type EvidenceLink,
  type LeadRecord,
  type LeadStageKey,
} from "../_lib/model";
import type { StoreProfileRecord } from "../_lib/service";
import { EstimateTag, EvidenceDetails } from "./evidence";
import { DeleteButton, FormModal, useActionRunner, type FieldSpec } from "./form-kit";

const STAGE_OPTIONS = LEAD_STAGES.map((s) => ({ value: s, label: LEAD_STAGE_LABEL[s] }));

const ATTRIBUTE_FIELDS: FieldSpec[] = [
  {
    name: "storeType",
    label: "Butikstyp",
    type: "text",
    placeholder: "livs, kiosk, bensinstation …",
  },
  { name: "city", label: "Ort", type: "text" },
  { name: "openHoursPerWeek", label: "Öppettimmar per vecka", type: "integer", suffix: "h" },
  { name: "areaSqm", label: "Yta", type: "integer", suffix: "m²" },
];

function LeadStageSelect({ lead, disabled }: { lead: LeadRecord; disabled: boolean }) {
  const { pending, run } = useActionRunner();
  return (
    <Select
      label="Steg"
      value={lead.stage}
      disabled={disabled || pending}
      options={STAGE_OPTIONS}
      onChange={(e) =>
        run(
          setLeadStage,
          { id: lead.id, stage: e.target.value },
          {
            success: `${lead.name}: ${LEAD_STAGE_LABEL[e.target.value as LeadStageKey].toLowerCase()}`,
          },
        )
      }
      wrapperClassName="w-40"
    />
  );
}

/** Pipelinen: öppna platser i rangordning efter uppskattad återbetalningstid, sedan avslutade. */
/** Arkivera en avslutad plats, eller ta tillbaka en arkiverad. */
function ArchiveButton({ lead }: { lead: LeadRecord }) {
  const { pending, run } = useActionRunner();
  const archive = !lead.archived;
  return (
    <Button
      type="button"
      size="sm"
      variant="ghost"
      disabled={pending}
      aria-label={archive ? `Arkivera ${lead.name}` : `Ta tillbaka ${lead.name}`}
      onClick={() =>
        run(
          setLeadArchived,
          { id: lead.id, archived: archive },
          { success: archive ? `${lead.name} är arkiverad` : `${lead.name} är tillbaka` },
        )
      }
    >
      {archive ? "Arkivera" : "Ta tillbaka"}
    </Button>
  );
}

export function PipelineView({
  leads,
  pipeline,
  links,
  stores,
  canEdit,
  today,
  defaultInvestmentText,
}: {
  leads: ReadonlyArray<LeadRecord>;
  pipeline: ReadonlyArray<LeadPotential>;
  links: Record<string, EvidenceLink[]>;
  stores: ReadonlyArray<Named>;
  canEdit: boolean;
  today: string;
  defaultInvestmentText: string;
}) {
  const [editing, setEditing] = useState<LeadRecord | "new" | null>(null);
  const byId = useMemo(() => new Map(leads.map((l) => [l.id, l])), [leads]);
  const active = leads.filter((l) => !l.archived);
  const closed = active.filter((l) => !OPEN_STAGES.includes(l.stage));
  const archived = leads.filter((l) => l.archived);
  const counts = LEAD_STAGES.map((s) => ({ s, n: active.filter((l) => l.stage === s).length }));

  const fields = useMemo<FieldSpec[]>(
    () => [
      { name: "name", label: "Plats", type: "text", required: true, span: 2 },
      { name: "stage", label: "Steg", type: "select", required: true, options: STAGE_OPTIONS },
      { name: "nextStepOn", label: "Datum för nästa steg", type: "date" },
      { name: "nextStep", label: "Nästa steg", type: "text", span: 2 },
      ...ATTRIBUTE_FIELDS,
      { name: "address", label: "Adress", type: "text", span: 2 },
      { name: "contactName", label: "Kontaktperson", type: "text" },
      { name: "contactPhone", label: "Telefon", type: "tel" },
      { name: "contactEmail", label: "E-post", type: "email", span: 2 },
      {
        name: "commissionBp",
        label: "Erbjuden provision",
        type: "decimal",
        suffix: "%",
        hint: "Tomt = som liknande platsers avtal.",
      },
      { name: "monthlyRentOre", label: "Erbjuden hyra per månad", type: "decimal", suffix: "kr" },
      {
        name: "purchaseOre",
        label: "Automat",
        type: "decimal",
        suffix: "kr",
        hint: `Tomt = ${defaultInvestmentText}.`,
      },
      { name: "installationOre", label: "Installation", type: "decimal", suffix: "kr" },
      {
        name: "storeId",
        label: "Befintlig butik",
        type: "select",
        options: [
          { value: "", label: "Ingen (ny plats)" },
          ...stores.filter((s) => !s.archived).map((s) => ({ value: s.id, label: s.name })),
        ],
        hint: "För en andra automat i en butik vi redan har. Butiken används då inte som underlag.",
        span: 2,
      },
      { name: "notes", label: "Anteckningar", type: "textarea" },
    ],
    [stores, defaultInvestmentText],
  );

  const l = editing && editing !== "new" ? editing : null;
  const initial = {
    name: l?.name ?? "",
    stage: l?.stage ?? "lead",
    nextStepOn: l?.nextStepOn ?? "",
    nextStep: l?.nextStep ?? "",
    storeType: l?.storeType ?? "",
    city: l?.city ?? "",
    openHoursPerWeek: l?.openHoursPerWeek?.toString() ?? "",
    areaSqm: l?.areaSqm?.toString() ?? "",
    address: l?.address ?? "",
    contactName: l?.contactName ?? "",
    contactPhone: l?.contactPhone ?? "",
    contactEmail: l?.contactEmail ?? "",
    commissionBp: bpToInput(l?.commissionBp),
    monthlyRentOre: oreToInput(l?.monthlyRentOre),
    purchaseOre: oreToInput(l?.purchaseOre),
    installationOre: oreToInput(l?.installationOre),
    storeId: l?.storeId ?? "",
    notes: l?.notes ?? "",
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <ol className="flex flex-wrap gap-x-5 gap-y-2" aria-label="Platser per steg">
          {counts.map(({ s, n }, i) => (
            <li key={s} className="meta tnum flex items-center gap-1.5 text-muted">
              {i > 0 ? (
                <span aria-hidden className="text-faint">
                  →
                </span>
              ) : null}
              <span className="text-fg">{formatInt(n)}</span> {LEAD_STAGE_LABEL[s].toLowerCase()}
            </li>
          ))}
        </ol>
        {canEdit ? (
          <Button type="button" iconLeft="plus" onClick={() => setEditing("new")}>
            Ny plats
          </Button>
        ) : null}
      </div>

      {pipeline.length === 0 ? (
        <StateMessage
          kind="empty"
          message="Inga öppna platser i pipelinen."
          detail="Lägg in tänkbara platser med butikstyp, ort, öppettider och yta, så uppskattas potentialen från liknande befintliga platser."
        />
      ) : (
        <ol className="flex flex-col">
          {pipeline.map((p) => {
            const lead = byId.get(p.leadId)!;
            const e = p.estimate;
            const ok = e.status === "ok";
            const overdue = lead.nextStepOn !== null && lead.nextStepOn < today;
            return (
              <li
                key={p.leadId}
                className="flex flex-col gap-3 border-t border-line py-4 last:border-b"
              >
                <div className="grid grid-cols-1 gap-4 lg:grid-cols-12 lg:items-start">
                  <div className="flex min-w-0 flex-col gap-1 lg:col-span-5">
                    <p className="label flex items-center gap-2 text-subtle">
                      <span className="tnum text-fg">{String(p.rank).padStart(2, "0")}</span>
                      <span aria-hidden className="text-faint">
                        /
                      </span>
                      <span>{LEAD_STAGE_LABEL[lead.stage]}</span>
                    </p>
                    <p className="text-md text-fg">{lead.name}</p>
                    <p className="text-sm text-muted">
                      {[
                        lead.storeType,
                        lead.city,
                        lead.openHoursPerWeek !== null ? `${lead.openHoursPerWeek} h/vecka` : null,
                        lead.areaSqm !== null ? `${formatInt(lead.areaSqm)} m²` : null,
                      ]
                        .filter(Boolean)
                        .join(" · ") || "Attribut saknas"}
                    </p>
                    {lead.contactName || lead.contactPhone || lead.contactEmail ? (
                      <p className="text-sm text-muted">
                        {[lead.contactName, lead.contactPhone, lead.contactEmail]
                          .filter(Boolean)
                          .join(" · ")}
                      </p>
                    ) : null}
                    {lead.nextStep || lead.nextStepOn ? (
                      <p className={cn("text-sm", overdue ? "text-fg" : "text-muted")}>
                        Nästa steg: {lead.nextStep ?? "–"}
                        {lead.nextStepOn ? (
                          <span className="meta tnum">
                            {" "}
                            · {lead.nextStepOn}
                            {overdue ? " · passerat" : ""}
                          </span>
                        ) : null}
                      </p>
                    ) : null}
                  </div>
                  <dl className="grid grid-cols-3 gap-4 lg:col-span-4">
                    <div className="flex flex-col gap-1">
                      <dt className="label text-subtle">Vinst/mån</dt>
                      <dd className="tnum text-lg text-fg">
                        {ok ? kr(e.profitPerMonthOre!.expected) : MISSING}
                      </dd>
                    </div>
                    <div className="flex flex-col gap-1">
                      <dt className="label text-subtle">Återbet.</dt>
                      <dd className="tnum text-lg text-fg">
                        {ok && e.investmentOre > 0
                          ? paybackShort(e.paybackTenths?.expected)
                          : MISSING}
                      </dd>
                    </div>
                    <div className="flex flex-col gap-1">
                      <dt className="label text-subtle">Investering</dt>
                      <dd className="tnum text-lg text-fg">
                        {e.investmentOre > 0 ? kr(e.investmentOre) : MISSING}
                      </dd>
                    </div>
                  </dl>
                  <div className="flex flex-wrap items-end gap-2 lg:col-span-3 lg:justify-end">
                    {canEdit ? (
                      <>
                        <LeadStageSelect lead={lead} disabled={!canEdit} />
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          onClick={() => setEditing(lead)}
                        >
                          Ändra
                        </Button>
                      </>
                    ) : null}
                  </div>
                </div>
                <div className="flex flex-wrap items-start gap-3">
                  <EstimateTag />
                  <p className="min-w-0 flex-1 text-sm text-muted">{e.text}</p>
                </div>
                <EvidenceDetails evidence={e.evidence} links={links[p.leadId] ?? []} />
              </li>
            );
          })}
        </ol>
      )}

      {closed.length > 0 ? (
        <details className="group">
          <summary className="meta cursor-pointer list-none text-muted hover:text-fg [&::-webkit-details-marker]:hidden">
            <span aria-hidden className="text-faint">
              ›{" "}
            </span>
            Avslutade platser · {formatInt(closed.length)}
          </summary>
          <ul className="mt-3 flex flex-col">
            {closed.map((c) => (
              <li
                key={c.id}
                className="flex flex-wrap items-center justify-between gap-3 border-t border-line py-2"
              >
                <span className="text-sm text-fg">
                  {c.name} <span className="text-muted">· {LEAD_STAGE_LABEL[c.stage]}</span>
                </span>
                {canEdit ? (
                  <span className="flex gap-1">
                    <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(c)}>
                      Ändra
                    </Button>
                    <ArchiveButton lead={c} />
                    <DeleteButton
                      action={deleteLead}
                      id={c.id}
                      what="platsen"
                      success="Platsen är borttagen"
                    />
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {archived.length > 0 ? (
        <details className="group">
          <summary className="meta cursor-pointer list-none text-muted hover:text-fg [&::-webkit-details-marker]:hidden">
            <span aria-hidden className="text-faint">
              ›{" "}
            </span>
            Arkiverade platser · {formatInt(archived.length)}
          </summary>
          <ul className="mt-3 flex flex-col">
            {archived.map((c) => (
              <li
                key={c.id}
                className="flex flex-wrap items-center justify-between gap-3 border-t border-line py-2"
              >
                <span className="text-sm text-fg">
                  {c.name} <span className="text-muted">· {LEAD_STAGE_LABEL[c.stage]}</span>
                </span>
                {canEdit ? (
                  <span className="flex gap-1">
                    <ArchiveButton lead={c} />
                    <DeleteButton
                      action={deleteLead}
                      id={c.id}
                      what="platsen"
                      success="Platsen är borttagen"
                    />
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      <FormModal
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={editing === "new" ? "Ny plats" : `Ändra ${l?.name ?? "plats"}`}
        eyebrow="Expansionspipeline"
        description="Attributen avgör vilka befintliga platser uppskattningen bygger på."
        fields={fields}
        initial={initial}
        fixed={{ id: l?.id ?? null }}
        action={saveLead}
        success={editing === "new" ? "Platsen är tillagd" : "Platsen är ändrad"}
        extraFooter={
          l ? (
            <span className="sm:mr-auto">
              <DeleteButton
                action={deleteLead}
                id={l.id}
                what="platsen"
                success="Platsen är borttagen"
              />
            </span>
          ) : null
        }
      />
    </div>
  );
}

/** Platsprofiler: attributen för befintliga butiker (butikstyp, ort, öppettider, yta). */
export function StoreProfilesView({
  profiles,
  canEdit,
}: {
  profiles: ReadonlyArray<StoreProfileRecord>;
  canEdit: boolean;
}) {
  const [editing, setEditing] = useState<StoreProfileRecord | null>(null);
  const active = profiles.filter((p) => !p.archived);
  if (active.length === 0) {
    return <StateMessage kind="empty" message="Inga butiker ännu." />;
  }
  return (
    <div className="min-w-0">
      <div className="relative min-w-0 overflow-x-auto">
        <table className="w-full min-w-[560px] border-collapse text-base">
          <caption className="sr-only">Platsprofiler för befintliga butiker</caption>
          <thead>
            <tr className="border-b border-line-strong">
              {["Butik", "Typ", "Ort", "Öppet/vecka", "Yta", ""].map((h, i) => (
                <th
                  key={h || "x"}
                  scope="col"
                  className={cn(
                    "label h-9 font-normal text-subtle",
                    i >= 3 ? "pl-4 text-right" : "text-left",
                  )}
                >
                  {h || <span className="sr-only">Åtgärd</span>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {active.map((p) => (
              <tr key={p.id} className="h-11 border-b border-line">
                <td className="pr-4 text-fg">{p.name}</td>
                <td className="pr-4 text-muted">{p.storeType ?? MISSING}</td>
                <td className="pr-4 text-muted">{p.city ?? MISSING}</td>
                <td className="tnum pl-4 text-right">
                  {p.openHoursPerWeek === null ? MISSING : `${p.openHoursPerWeek} h`}
                </td>
                <td className="tnum pl-4 text-right">
                  {p.areaSqm === null ? MISSING : `${formatInt(p.areaSqm)} m²`}
                </td>
                <td className="text-right">
                  {canEdit ? (
                    <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(p)}>
                      Ändra
                    </Button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <FormModal
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={editing ? `Platsprofil: ${editing.name}` : "Platsprofil"}
        eyebrow="Expansion"
        description="Okända värden lämnas tomma; de räknas som olika vid jämförelsen."
        fields={ATTRIBUTE_FIELDS}
        initial={{
          storeType: editing?.storeType ?? "",
          city: editing?.city ?? "",
          openHoursPerWeek: editing?.openHoursPerWeek?.toString() ?? "",
          areaSqm: editing?.areaSqm?.toString() ?? "",
        }}
        fixed={{ storeId: editing?.id ?? null }}
        action={saveStoreProfile}
        success="Platsprofilen är sparad"
      />
    </div>
  );
}

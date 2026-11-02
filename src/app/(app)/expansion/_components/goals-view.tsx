"use client";

import { useMemo, useState } from "react";

import type { GoalProgress } from "@/analytics/goals";
import { Button } from "@/components/ui/button";
import { StateMessage } from "@/components/ui/state-message";
import { StatusTag } from "@/components/ui/status-tag";
import { cn } from "@/lib/cn";

import { deleteGoal, saveGoal } from "../actions";
import { kr, monthLabel, oreToInput, pct } from "../_lib/display";
import type { Named } from "../_lib/data";
import type { EvidenceLink } from "../_lib/model";
import type { GoalRecord } from "../_lib/service";
import { EvidenceDetails } from "./evidence";
import { DeleteButton, FormModal, type FieldSpec } from "./form-kit";

const METRIC_LABEL: Record<GoalRecord["metric"], string> = {
  revenue: "Intäkt",
  profit: "Vinst",
  active_machines: "Automater i drift",
};

const STATUS: Record<
  GoalProgress["status"],
  { status: "ok" | "warning" | "neutral"; text: string }
> = {
  "on-track": { status: "ok", text: "I fas" },
  behind: { status: "warning", text: "Efter" },
  met: { status: "ok", text: "Nått" },
  missed: { status: "warning", text: "Missat" },
};

function value(metric: GoalRecord["metric"], v: number) {
  return metric === "active_machines" ? String(v) : kr(v);
}

/** Utfall mot mål med prognos, en rad per mål, och formulär för att lägga till och ändra. */
export function GoalsView({
  goals,
  progress,
  links,
  stores,
  machines,
  canEdit,
  defaultMonth,
}: {
  goals: ReadonlyArray<GoalRecord>;
  progress: ReadonlyArray<GoalProgress>;
  links: Record<string, EvidenceLink[]>;
  stores: ReadonlyArray<Named>;
  machines: ReadonlyArray<Named>;
  canEdit: boolean;
  defaultMonth: string;
}) {
  const [editing, setEditing] = useState<GoalRecord | "new" | null>(null);
  const byId = useMemo(() => new Map(goals.map((g) => [g.id, g])), [goals]);

  const fields = useMemo<FieldSpec[]>(
    () => [
      { name: "month", label: "Månad", type: "month", required: true, placeholder: "ÅÅÅÅ-MM" },
      {
        name: "metric",
        label: "Mått",
        type: "select",
        required: true,
        options: [
          { value: "revenue", label: "Intäkt" },
          { value: "profit", label: "Vinst" },
          { value: "active_machines", label: "Automater i drift" },
        ],
      },
      {
        name: "target",
        label: "Mål",
        type: "decimal",
        required: true,
        suffix: "kr",
        when: (v) => v.metric !== "active_machines",
      },
      {
        name: "target",
        label: "Mål",
        type: "integer",
        required: true,
        suffix: "st",
        when: (v) => v.metric === "active_machines",
      },
      {
        name: "scope",
        label: "Gäller",
        type: "select",
        required: true,
        options: [
          { value: "organization", label: "Hela flottan" },
          { value: "store", label: "En butik" },
          { value: "machine", label: "En automat" },
        ],
      },
      {
        name: "storeId",
        label: "Butik",
        type: "select",
        required: true,
        options: stores.filter((s) => !s.archived).map((s) => ({ value: s.id, label: s.name })),
        when: (v) => v.scope === "store",
      },
      {
        name: "machineId",
        label: "Automat",
        type: "select",
        required: true,
        options: machines
          .filter((m) => !m.archived)
          .map((m) => ({ value: m.id, label: `${m.code ?? ""} ${m.name}`.trim() })),
        when: (v) => v.scope === "machine",
      },
    ],
    [stores, machines],
  );

  const initial =
    editing && editing !== "new"
      ? {
          month: editing.month,
          metric: editing.metric,
          target:
            editing.metric === "active_machines"
              ? String(editing.target)
              : oreToInput(editing.target),
          scope: editing.scope,
          storeId: editing.storeId ?? stores[0]?.id ?? "",
          machineId: editing.machineId ?? machines[0]?.id ?? "",
        }
      : {
          month: defaultMonth,
          metric: "revenue",
          target: "",
          scope: "organization",
          storeId: stores[0]?.id ?? "",
          machineId: machines[0]?.id ?? "",
        };

  return (
    <div className="flex flex-col gap-4">
      {canEdit ? (
        <div className="flex justify-end">
          <Button type="button" iconLeft="plus" onClick={() => setEditing("new")}>
            Nytt mål
          </Button>
        </div>
      ) : null}
      {progress.length === 0 ? (
        <StateMessage
          kind="empty"
          message="Inga mål är satta. Sätt ett mål för intäkt, vinst eller antal automater per månad."
          detail="Utfallet räknas ur orderna och prognosen visar om målet nås."
        />
      ) : (
        <ul className="flex flex-col">
          {progress.map((g) => {
            const share =
              g.target > 0 ? Math.max(0, Math.min(1, g.actual / g.target)) : g.actual > 0 ? 1 : 0;
            const forecastShare =
              g.target > 0 ? Math.max(0, Math.min(1, g.forecast / g.target)) : 0;
            const st = STATUS[g.status];
            const rec = byId.get(g.goalId);
            return (
              <li
                key={g.goalId}
                className="flex flex-col gap-3 border-t border-line py-4 last:border-b"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="flex min-w-0 flex-col gap-1">
                    <p className="label text-subtle">
                      {monthLabel(g.month)} · {METRIC_LABEL[g.metric]}
                    </p>
                    <p className="text-base text-fg">{g.text}</p>
                    <p className="text-sm text-muted">{g.detail}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <StatusTag status={st.status}>{st.text}</StatusTag>
                    {canEdit && rec ? (
                      <>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          onClick={() => setEditing(rec)}
                        >
                          Ändra
                        </Button>
                        <DeleteButton
                          action={deleteGoal}
                          id={rec.id}
                          what="målet"
                          success="Målet är borttaget"
                        />
                      </>
                    ) : null}
                  </div>
                </div>
                <div
                  className="relative h-2 w-full border border-line"
                  role="img"
                  aria-label={`Utfall ${value(g.metric, g.actual)}, prognos ${value(g.metric, g.forecast)}, mål ${value(g.metric, g.target)}`}
                >
                  <span
                    className="absolute inset-y-0 left-0 border-r border-dashed border-line-control"
                    style={{ width: `${forecastShare * 100}%` }}
                  />
                  <span
                    className={cn("absolute inset-y-0 left-0 bg-data-1")}
                    style={{ width: `${share * 100}%` }}
                  />
                </div>
                <div className="meta tnum flex flex-wrap justify-between gap-x-4 text-subtle">
                  <span>
                    Utfall {value(g.metric, g.actual)}
                    {g.progressBp !== null ? ` (${pct(g.progressBp)})` : ""}
                  </span>
                  <span>Prognos {value(g.metric, g.forecast)}</span>
                  <span>Mål {value(g.metric, g.target)}</span>
                </div>
                <EvidenceDetails evidence={g.evidence} links={links[g.goalId] ?? []} />
              </li>
            );
          })}
        </ul>
      )}
      <FormModal
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={editing === "new" ? "Nytt mål" : "Ändra mål"}
        eyebrow="Mål per månad"
        description="Ett mål per månad, mått och omfattning. Belopp i kronor exklusive moms."
        fields={fields}
        initial={initial}
        fixed={{ id: editing && editing !== "new" ? editing.id : null }}
        action={saveGoal}
        success={editing === "new" ? "Målet är sparat" : "Målet är ändrat"}
      />
    </div>
  );
}

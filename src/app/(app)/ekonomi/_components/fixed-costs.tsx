"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import { DataTable, type Column } from "@/components/ui/data-table";
import { Input, Select } from "@/components/ui/field";
import { Modal } from "@/components/ui/modal";
import { StatusTag } from "@/components/ui/status-tag";
import { useToast } from "@/components/ui/toast";
import { formatCsvNumber, formatDate } from "@/lib/format";

import { archiveFixedCost, saveFixedCost } from "../actions";
import { FIXED_COST_CATEGORY_LABEL, INTERVAL_LABEL, isoToDate, kr } from "../_lib/view";
import { DialogButtons, FormError, TextArea } from "./bits";

export type FixedCostRow = {
  id: string;
  name: string;
  category: keyof typeof FIXED_COST_CATEGORY_LABEL;
  amountOre: number;
  interval: keyof typeof INTERVAL_LABEL;
  startsOn: string;
  endsOn: string | null;
  machineId: string | null;
  machineCode: string | null;
  note: string | null;
  archived: boolean;
  /** Periodens del (periodiserad), från @/analytics/cashflow. */
  accruedOre: number;
};

type Draft = {
  id: string | null;
  name: string;
  category: FixedCostRow["category"];
  amount: string;
  interval: FixedCostRow["interval"];
  startsOn: string;
  endsOn: string;
  machineId: string;
  note: string;
};

function oreToInput(ore: number): string {
  const kr = Math.trunc(ore / 100);
  const rest = Math.abs(ore % 100);
  return rest === 0 ? String(kr) : `${kr},${String(rest).padStart(2, "0")}`;
}

const EMPTY = (today: string): Draft => ({
  id: null,
  name: "",
  category: "insurance",
  amount: "",
  interval: "month",
  startsOn: `${today.slice(0, 7)}-01`,
  endsOn: "",
  machineId: "",
  note: "",
});

/** Tabell över fasta kostnader med dialog för ny och ändrad kostnad, och arkivering. */
export function FixedCosts({
  rows,
  machines,
  canEdit,
  today,
  periodLabel,
}: {
  rows: FixedCostRow[];
  machines: { id: string; code: string; name: string }[];
  canEdit: boolean;
  today: string;
  periodLabel: string;
}) {
  const router = useRouter();
  const toast = useToast();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [errors, setErrors] = useState<Partial<Record<keyof Draft, string>>>({});
  const [error, setError] = useState<string>();
  const [showArchived, setShowArchived] = useState(false);
  const [pending, startTransition] = useTransition();

  const close = () => {
    setDraft(null);
    setErrors({});
    setError(undefined);
  };

  const edit = (r: FixedCostRow) =>
    setDraft({
      id: r.id,
      name: r.name,
      category: r.category,
      amount: oreToInput(r.amountOre),
      interval: r.interval,
      startsOn: r.startsOn,
      endsOn: r.endsOn ?? "",
      machineId: r.machineId ?? "",
      note: r.note ?? "",
    });

  const archive = (r: FixedCostRow) =>
    startTransition(async () => {
      const res = await archiveFixedCost({ id: r.id, archived: !r.archived });
      toast(
        res.ok
          ? { title: r.archived ? `${r.name} återställd` : `${r.name} arkiverad`, tone: "ok" }
          : { title: "Kunde inte ändra kostnaden", description: res.error, tone: "critical" },
      );
      if (res.ok) router.refresh();
    });

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!draft) return;
    const errs: Partial<Record<keyof Draft, string>> = {};
    if (!draft.name.trim()) errs.name = "Ange ett namn.";
    if (!draft.amount.trim()) errs.amount = "Ange ett belopp.";
    if (!draft.startsOn) errs.startsOn = "Ange första betalningsdag.";
    if (draft.endsOn && draft.endsOn < draft.startsOn)
      errs.endsOn = "Slutdagen ligger före startdagen.";
    setErrors(errs);
    if (Object.keys(errs).length > 0) return;
    setError(undefined);
    startTransition(async () => {
      const res = await saveFixedCost({
        id: draft.id,
        name: draft.name,
        category: draft.category,
        amount: draft.amount,
        interval: draft.interval,
        startsOn: draft.startsOn,
        endsOn: draft.endsOn,
        machineId: draft.machineId,
        note: draft.note,
      });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      toast({
        title: draft.id ? "Kostnaden ändrad" : "Kostnaden sparad",
        description: draft.name,
        tone: "ok",
      });
      close();
      router.refresh();
    });
  };

  const columns = useMemo<ReadonlyArray<Column<FixedCostRow>>>(
    () => [
      {
        key: "namn",
        header: "Kostnad",
        sortValue: (r) => r.name,
        render: (r) => (
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="text-fg">{r.name}</span>
            <span className="meta text-subtle">
              {FIXED_COST_CATEGORY_LABEL[r.category]}
              {r.machineCode ? ` · ${r.machineCode}` : " · alla automater"}
            </span>
          </span>
        ),
        csv: (r) => r.name,
      },
      {
        key: "belopp",
        header: "Belopp",
        numeric: true,
        sortValue: (r) => r.amountOre,
        render: (r) => (
          <span className="flex flex-col items-end gap-0.5">
            <span>{kr(r.amountOre)}</span>
            <span className="meta text-subtle">{INTERVAL_LABEL[r.interval]}</span>
          </span>
        ),
        csv: (r) => formatCsvNumber(r.amountOre / 100),
      },
      {
        key: "giltig",
        header: "Gäller",
        hideOnMobile: true,
        sortValue: (r) => r.startsOn,
        render: (r) => (
          <span className="meta text-muted">
            {formatDate(isoToDate(r.startsOn), { year: "always" })}
            {" – "}
            {r.endsOn ? formatDate(isoToDate(r.endsOn), { year: "always" }) : "tills vidare"}
          </span>
        ),
        csv: (r) => `${r.startsOn}–${r.endsOn ?? ""}`,
      },
      {
        key: "period",
        header: `Del av ${periodLabel}`,
        numeric: true,
        sortValue: (r) => r.accruedOre,
        render: (r) =>
          r.archived ? <StatusTag status="offline">Arkiverad</StatusTag> : kr(r.accruedOre),
        csv: (r) => formatCsvNumber(r.accruedOre / 100),
      },
      ...(canEdit
        ? [
            {
              key: "atgard",
              header: "Åtgärd",
              render: (r: FixedCostRow) => (
                <span className="flex justify-end gap-1">
                  {!r.archived ? (
                    <Button size="sm" variant="ghost" onClick={() => edit(r)}>
                      Ändra
                    </Button>
                  ) : null}
                  <Button size="sm" variant="ghost" onClick={() => archive(r)} disabled={pending}>
                    {r.archived ? "Återställ" : "Arkivera"}
                  </Button>
                </span>
              ),
            } satisfies Column<FixedCostRow>,
          ]
        : []),
    ],
    // edit/archive är stabila nog: de läser bara props via closure.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [canEdit, periodLabel, pending],
  );

  const visible = rows.filter((r) => showArchived || !r.archived);
  const archivedCount = rows.filter((r) => r.archived).length;

  return (
    <div className="flex flex-col gap-4">
      {canEdit || archivedCount > 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          {archivedCount > 0 ? (
            <Button size="sm" variant="ghost" onClick={() => setShowArchived((v) => !v)}>
              {showArchived ? "Dölj arkiverade" : `Visa arkiverade (${archivedCount})`}
            </Button>
          ) : (
            <span />
          )}
          {canEdit ? (
            <Button variant="primary" iconLeft="plus" onClick={() => setDraft(EMPTY(today))}>
              Ny fast kostnad
            </Button>
          ) : null}
        </div>
      ) : null}
      {visible.length > 0 ? (
        <DataTable
          columns={columns}
          rows={visible}
          rowKey={(r) => r.id}
          caption="Fasta kostnader"
          exportFileName="fasta-kostnader"
        />
      ) : null}
      <Modal
        open={draft !== null}
        onClose={close}
        eyebrow="Fasta kostnader"
        title={draft?.id ? "Ändra fast kostnad" : "Ny fast kostnad"}
        description="Betalas i förskott på startdagen och sedan varje månad, kvartal eller år på samma dag."
      >
        {draft ? (
          <form onSubmit={submit} noValidate className="flex flex-col gap-5">
            <Input
              label="Namn"
              value={draft.name}
              maxLength={200}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              error={errors.name}
              autoFocus
            />
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Select
                label="Kategori"
                value={draft.category}
                options={Object.entries(FIXED_COST_CATEGORY_LABEL).map(([value, label]) => ({
                  value,
                  label,
                }))}
                onChange={(e) =>
                  setDraft({ ...draft, category: e.target.value as FixedCostRow["category"] })
                }
              />
              <Select
                label="Automat"
                value={draft.machineId}
                options={[
                  { value: "", label: "Alla automater (delas efter intäkt)" },
                  ...machines.map((m) => ({ value: m.id, label: `${m.code} ${m.name}` })),
                ]}
                onChange={(e) => setDraft({ ...draft, machineId: e.target.value })}
              />
              <Input
                label="Belopp"
                inputMode="decimal"
                suffix="kr"
                value={draft.amount}
                onChange={(e) => setDraft({ ...draft, amount: e.target.value })}
                error={errors.amount}
              />
              <Select
                label="Betalas"
                value={draft.interval}
                options={Object.entries(INTERVAL_LABEL).map(([value, label]) => ({ value, label }))}
                onChange={(e) =>
                  setDraft({ ...draft, interval: e.target.value as FixedCostRow["interval"] })
                }
              />
              <Input
                label="Första betalning"
                type="date"
                value={draft.startsOn}
                onChange={(e) => setDraft({ ...draft, startsOn: e.target.value })}
                error={errors.startsOn}
              />
              <Input
                label="Sista dag"
                type="date"
                hint="Tomt = tills vidare."
                value={draft.endsOn}
                onChange={(e) => setDraft({ ...draft, endsOn: e.target.value })}
                error={errors.endsOn}
              />
            </div>
            <TextArea
              label="Anteckning"
              value={draft.note}
              maxLength={2000}
              onChange={(e) => setDraft({ ...draft, note: e.target.value })}
            />
            <FormError message={error} />
            <DialogButtons>
              <Button type="button" onClick={close}>
                Avbryt
              </Button>
              <Button type="submit" variant="primary" loading={pending}>
                Spara
              </Button>
            </DialogButtons>
          </form>
        ) : null}
      </Modal>
    </div>
  );
}

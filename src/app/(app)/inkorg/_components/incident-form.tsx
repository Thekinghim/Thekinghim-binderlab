"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/field";
import { useToast } from "@/components/ui/toast";
import { wallClockIn } from "@/components/shell/period-state";
import { formatCsvNumber, formatKronor, formatTime } from "@/lib/format";

import { findOrders, saveIncident, type OrderCandidate } from "../actions";
import {
  INCIDENT_KINDS,
  INCIDENT_STATUSES,
  KIND_LABEL,
  STATUS_LABEL,
  type IncidentErrors,
  type IncidentInput,
} from "../_lib/model";

export interface IncidentFormProps {
  readonly initial: IncidentInput;
  readonly machines: { id: string; label: string }[];
  readonly titles: { id: string; name: string }[];
  readonly members: { userId: string; name: string }[];
  readonly timeZone: string;
  /** Ordern som redan är kopplad (visas i listan även om den ligger utanför sökfönstret). */
  readonly currentOrder: OrderCandidate | null;
  readonly readOnly?: boolean;
}

/** Formulär för ett kundärende: automat, tid, typ, order, titel, status, åtgärd och återbetalning. */
export function IncidentForm({
  initial,
  machines,
  titles,
  members,
  timeZone,
  currentOrder,
  readOnly = false,
}: IncidentFormProps) {
  const router = useRouter();
  const toast = useToast();
  const [v, setV] = useState<IncidentInput>(initial);
  const [errors, setErrors] = useState<IncidentErrors>({});
  const [pending, start] = useTransition();
  const [searching, startSearch] = useTransition();
  const [candidates, setCandidates] = useState<OrderCandidate[] | null>(
    currentOrder ? [currentOrder] : null,
  );
  const set = <K extends keyof IncidentInput>(k: K, value: IncidentInput[K]) =>
    setV((prev) => ({ ...prev, [k]: value }));

  const search = () =>
    startSearch(async () => {
      const found = await findOrders(v.machineId, v.occurredAt);
      const merged =
        currentOrder && !found.some((o) => o.id === currentOrder.id)
          ? [currentOrder, ...found]
          : found;
      setCandidates(merged);
    });

  const pickOrder = (id: string) => {
    const o = candidates?.find((c) => c.id === id);
    setV((prev) => ({
      ...prev,
      orderId: id,
      titleId: o?.titleId ?? prev.titleId,
      refunded:
        prev.refunded === "" &&
        o &&
        (prev.kind === "not_delivered" || prev.kind === "refund_request")
          ? formatCsvNumber(o.amountOre / 100)
          : prev.refunded,
    }));
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    start(async () => {
      const r = await saveIncident(v);
      setErrors(r.errors ?? {});
      if (r.ok && r.id) {
        toast({ title: initial.id ? "Ärendet sparat" : "Ärendet registrerat", tone: "ok" });
        if (!initial.id) router.push(`/inkorg/${r.id}`);
        else router.refresh();
      } else {
        toast({ title: r.errors?.form ?? "Rätta fälten som är markerade", tone: "critical" });
      }
    });
  };

  const orderLabel = (o: OrderCandidate) =>
    `${formatTime(wallClockIn(new Date(o.orderedAt), timeZone))} · ${o.titleName ?? "okänd titel"} · ${formatKronor(o.amountOre)} · order ${o.externalId}`;

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-8" aria-label="Kundärende">
      <fieldset disabled={readOnly} className="grid min-w-0 gap-5 sm:grid-cols-2">
        <legend className="label mb-4 text-muted">Vad hände</legend>
        <Select
          label="Automat"
          value={v.machineId}
          onChange={(e) => set("machineId", e.target.value)}
          error={errors.machineId}
          options={[
            { value: "", label: "Välj automat" },
            ...machines.map((m) => ({ value: m.id, label: m.label })),
          ]}
        />
        <Input
          label="Tidpunkt"
          type="datetime-local"
          value={v.occurredAt}
          onChange={(e) => set("occurredAt", e.target.value)}
          error={errors.occurredAt}
        />
        <Select
          label="Typ"
          value={v.kind}
          onChange={(e) => set("kind", e.target.value)}
          error={errors.kind}
          options={INCIDENT_KINDS.map((k) => ({ value: k, label: KIND_LABEL[k] ?? k }))}
        />
        <Input
          label="Kundens kontaktuppgift"
          value={v.customerContact}
          onChange={(e) => set("customerContact", e.target.value)}
          error={errors.customerContact}
          hint="Telefon eller Swish-referens för återbetalningen. Spara bara det som behövs."
          maxLength={200}
        />
        <label className="flex flex-col gap-1.5 sm:col-span-2">
          <span className="label text-muted">Beskrivning</span>
          <textarea
            value={v.description}
            onChange={(e) => set("description", e.target.value)}
            rows={3}
            maxLength={2000}
            className="min-h-20 w-full rounded-sm border border-line-control bg-bg px-3 py-2 text-base text-fg placeholder:text-subtle"
          />
          {errors.description ? (
            <span className="text-xs text-signal-fg">{errors.description}</span>
          ) : null}
        </label>
      </fieldset>

      <fieldset
        disabled={readOnly}
        className="flex min-w-0 flex-col gap-4 border-t border-line pt-4"
      >
        <legend className="label float-left mb-4 w-full text-muted">Order och titel</legend>
        <div className="flex flex-wrap items-end gap-3">
          <Button
            type="button"
            onClick={search}
            loading={searching}
            disabled={!v.machineId || !v.occurredAt}
          >
            Sök order runt tidpunkten
          </Button>
          <span className="text-xs text-subtle">Två timmar före och efter, i samma automat.</span>
        </div>
        {candidates ? (
          candidates.length === 0 ? (
            <p className="text-sm text-muted">
              Ingen order i automaten två timmar före eller efter tidpunkten.
            </p>
          ) : (
            <Select
              label="Order"
              value={v.orderId}
              onChange={(e) => pickOrder(e.target.value)}
              error={errors.orderId}
              options={[
                { value: "", label: "Ingen order kopplad" },
                ...candidates.map((o) => ({ value: o.id, label: orderLabel(o) })),
              ]}
            />
          )
        ) : null}
        <Select
          label="Titel"
          value={v.titleId}
          onChange={(e) => set("titleId", e.target.value)}
          error={errors.titleId}
          wrapperClassName="max-w-md"
          options={[
            { value: "", label: "Ingen titel" },
            ...titles.map((t) => ({ value: t.id, label: t.name })),
          ]}
        />
      </fieldset>

      <fieldset
        disabled={readOnly}
        className="grid min-w-0 gap-5 border-t border-line pt-4 sm:grid-cols-2"
      >
        <legend className="label float-left mb-4 w-full text-muted">Hantering</legend>
        <Select
          label="Status"
          value={v.status}
          onChange={(e) => set("status", e.target.value)}
          error={errors.status}
          options={INCIDENT_STATUSES.map((st) => ({ value: st, label: STATUS_LABEL[st] }))}
        />
        <Select
          label="Ansvarig"
          value={v.assigneeId}
          onChange={(e) => set("assigneeId", e.target.value)}
          error={errors.assigneeId}
          options={[
            { value: "", label: "Ingen" },
            ...members.map((m) => ({ value: m.userId, label: m.name })),
          ]}
        />
        <Input
          label="Återbetalt"
          inputMode="decimal"
          value={v.refunded}
          onChange={(e) => set("refunded", e.target.value)}
          error={errors.refunded}
          suffix="kr"
          hint="Dras från vinsten på återbetalningsdagen."
        />
        <Input
          label="Återbetald den"
          type="date"
          value={v.refundedOn}
          onChange={(e) => set("refundedOn", e.target.value)}
          error={errors.refundedOn}
        />
        <label className="flex flex-col gap-1.5 sm:col-span-2">
          <span className="label text-muted">Åtgärd</span>
          <textarea
            value={v.actionTaken}
            onChange={(e) => set("actionTaken", e.target.value)}
            rows={3}
            maxLength={2000}
            aria-invalid={errors.actionTaken ? true : undefined}
            className={
              errors.actionTaken
                ? "min-h-20 w-full rounded-sm border border-signal bg-bg px-3 py-2 text-base text-fg"
                : "min-h-20 w-full rounded-sm border border-line-control bg-bg px-3 py-2 text-base text-fg"
            }
          />
          {errors.actionTaken ? (
            <span className="text-xs text-signal-fg">{errors.actionTaken}</span>
          ) : null}
        </label>
      </fieldset>

      {errors.form ? <p className="text-sm text-signal-fg">{errors.form}</p> : null}
      {readOnly ? null : (
        <div className="flex gap-2">
          <Button type="submit" variant="primary" loading={pending}>
            {initial.id ? "Spara ärendet" : "Registrera ärendet"}
          </Button>
        </div>
      )}
    </form>
  );
}

"use client";

import { useRouter } from "next/navigation";
import { useId, useState, useTransition } from "react";

import { Icon } from "@/components/ui/icon";
import { Button } from "@/components/v2/button";
import { Field, Select, Textarea } from "@/components/v2/field";
import { reportFault, type PortalActionResult } from "@/server/portal/actions";
import { FAULT_KINDS, FAULT_LABEL, type FaultKind } from "@/server/portal/faults";

type Machine = { machineId: string; code: string; name: string };

/**
 * Felanmälan: automat, vad som är fel och en valfri beskrivning (krävs för
 * "Annat"). Skickas med server action reportFault; databasen kontrollerar att
 * automaten står i butiken och att användaren är butikens.
 */
export function FaultForm({
  storeId,
  machines,
  initialMachineId,
}: {
  storeId: string;
  machines: Machine[];
  initialMachineId?: string;
}) {
  const router = useRouter();
  const ids = useId();
  const [pending, startTransition] = useTransition();
  const [machineId, setMachineId] = useState(
    machines.some((m) => m.machineId === initialMachineId)
      ? initialMachineId!
      : machines.length === 1
        ? machines[0]!.machineId
        : "",
  );
  const [kind, setKind] = useState<FaultKind | "">("");
  const [description, setDescription] = useState("");
  const [result, setResult] = useState<PortalActionResult | null>(null);

  const error = result && !result.ok ? result : null;
  const descId = `${ids}-desc`;
  const descError = error?.field === "description" ? error.error : undefined;

  function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    startTransition(async () => {
      const res = await reportFault({ storeId, machineId, kind, description });
      setResult(res);
      if (res.ok) {
        setKind("");
        setDescription("");
        router.refresh();
      }
    });
  }

  const machineError = error?.field === "machine" ? error.error : undefined;
  return (
    <form onSubmit={submit} className="flex flex-col gap-5" noValidate>
      <Field label="Automat" error={machineError}>
        {(p) => (
          <Select {...p} value={machineId} onChange={(e) => setMachineId(e.target.value)} required>
            {machineId === "" ? <option value="">Välj automat</option> : null}
            {machines.map((m) => (
              <option key={m.machineId} value={m.machineId}>
                {`${m.code} · ${m.name}`}
              </option>
            ))}
          </Select>
        )}
      </Field>

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1.5 text-v2-sm font-[550] text-v2-ink">Vad är fel?</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {FAULT_KINDS.map((k) => (
            <label key={k} className="pt-choice" data-on={kind === k}>
              <input
                type="radio"
                name="kind"
                value={k}
                checked={kind === k}
                onChange={() => setKind(k)}
                className="sr-only"
              />
              <span aria-hidden className="r" />
              {FAULT_LABEL[k]}
            </label>
          ))}
        </div>
        {error?.field === "kind" ? (
          <p className="flex items-center gap-1.5 text-v2-sm text-v2-crit-text">
            <Icon name="alert" size={12} />
            {error.error}
          </p>
        ) : null}
      </fieldset>

      <Field
        id={descId}
        label={`Beskrivning ${kind === "store_other" ? "" : "(valfri)"}`}
        error={descError}
        hint={`${description.length} av 1 000 tecken. Operatören ser det ni skriver.`}
      >
        {(p) => (
          <Textarea
            {...p}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            maxLength={1000}
            rows={4}
            placeholder="Till exempel: kortläsaren svarar inte sedan i morse."
          />
        )}
      </Field>

      <div className="flex flex-wrap items-center gap-4">
        <Button type="submit" variant="act" size="lg" pending={pending} className="max-sm:w-full">
          Skicka felanmälan
        </Button>
        <p role="status" aria-live="polite" className="text-v2-sm">
          {result?.ok ? (
            <span className="text-v2-profit-text">
              Tack. Felanmälan är skickad till operatören.
            </span>
          ) : error && !error.field ? (
            <span className="flex items-center gap-1.5 text-v2-crit-text">
              <Icon name="alert" size={12} />
              {error.error}
            </span>
          ) : null}
        </p>
      </div>
    </form>
  );
}

"use client";

import { useRouter } from "next/navigation";
import { useId, useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/field";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/cn";
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

  return (
    <form onSubmit={submit} className="flex flex-col gap-6" noValidate>
      <Select
        label="Automat"
        value={machineId}
        onChange={(e) => setMachineId(e.target.value)}
        error={error?.field === "machine" ? error.error : undefined}
        options={[
          ...(machineId === "" ? [{ value: "", label: "Välj automat" }] : []),
          ...machines.map((m) => ({ value: m.machineId, label: `${m.code} · ${m.name}` })),
        ]}
        required
      />

      <fieldset className="flex flex-col gap-2">
        <legend className="label mb-1.5 text-muted">Vad är fel?</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {FAULT_KINDS.map((k) => (
            <label
              key={k}
              className={cn(
                "flex min-h-11 cursor-pointer items-center gap-3 rounded-sm border px-3 py-2 text-base transition-colors duration-fast ease-instrument has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-focus",
                kind === k
                  ? "border-fg bg-hover text-fg"
                  : "border-line-control text-muted hover:border-muted hover:text-fg",
              )}
            >
              <input
                type="radio"
                name="kind"
                value={k}
                checked={kind === k}
                onChange={() => setKind(k)}
                className="sr-only"
              />
              <span
                aria-hidden
                className={cn(
                  "inline-block size-3 shrink-0 border",
                  kind === k ? "border-fg bg-fg" : "border-line-control",
                )}
              />
              {FAULT_LABEL[k]}
            </label>
          ))}
        </div>
        {error?.field === "kind" ? (
          <p className="flex items-center gap-1.5 text-xs text-signal-fg">
            <Icon name="alert" size={12} />
            {error.error}
          </p>
        ) : null}
      </fieldset>

      <div className="flex flex-col gap-1.5">
        <label htmlFor={descId} className="label text-muted">
          Beskrivning {kind === "store_other" ? "" : "(valfri)"}
        </label>
        <textarea
          id={descId}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          maxLength={1000}
          rows={4}
          aria-invalid={descError ? true : undefined}
          aria-describedby={`${descId}-msg`}
          placeholder="Till exempel: kortläsaren svarar inte sedan i morse."
          className={cn(
            "w-full min-w-0 rounded-sm border bg-bg px-3 py-2 text-base text-fg placeholder:text-subtle",
            descError ? "border-signal-line" : "border-line-control hover:border-muted",
          )}
        />
        <p
          id={`${descId}-msg`}
          className={cn("text-xs", descError ? "text-signal-fg" : "text-subtle")}
        >
          {descError ?? `${description.length} av 1 000 tecken. Operatören ser det ni skriver.`}
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-4">
        <Button type="submit" variant="primary" loading={pending}>
          Skicka felanmälan
        </Button>
        <p role="status" aria-live="polite" className="text-sm">
          {result?.ok ? (
            <span className="text-fg">Tack. Felanmälan är skickad till operatören.</span>
          ) : error && !error.field ? (
            <span className="flex items-center gap-1.5 text-signal-fg">
              <Icon name="alert" size={12} />
              {error.error}
            </span>
          ) : null}
        </p>
      </div>
    </form>
  );
}

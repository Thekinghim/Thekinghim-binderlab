"use client";

import { useRouter } from "next/navigation";
import { useId, useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/field";
import { Panel } from "@/components/ui/frame";
import { StateMessage } from "@/components/ui/state-message";
import { useToast } from "@/components/ui/toast";
import { EN_DASH, formatInt, NBSP } from "@/lib/format";

import { mapSourceMachine } from "../actions";
import { formatWhen } from "../_lib/display";
import type { MachineOption, QueueEntry } from "../_lib/types";

/**
 * Kön för okända automater: namn från Awish ("Order Machine") som inte är kopplade
 * till någon av våra automater. Orderna är sparade men räknas inte på någon automat
 * förrän namnet kopplas; då får de automaten direkt.
 */
export function MachineQueue({
  queue,
  machines,
  timeZone,
}: {
  queue: readonly QueueEntry[];
  machines: readonly MachineOption[];
  timeZone: string;
}) {
  if (queue.length === 0) {
    return (
      <StateMessage
        kind="empty"
        code="0 i kön"
        message="Inga okända automater."
        detail="Om Awish skickar ett automatnamn som inte är kopplat hamnar det här. Orderna sparas ändå."
        compact
      />
    );
  }
  if (machines.length === 0) {
    return (
      <StateMessage
        kind="not-configured"
        message="Det finns inga automater att koppla till."
        detail="Lägg till automaterna under Automater först."
        action={{ label: "Till Automater", href: "/automater" }}
        className="rounded-md border border-line bg-surface"
      />
    );
  }
  return (
    <ul className="flex flex-col gap-3" aria-label="Okända automater">
      {queue.map((entry) => (
        <li key={entry.id}>
          <QueueRow entry={entry} machines={machines} timeZone={timeZone} />
        </li>
      ))}
    </ul>
  );
}

function QueueRow({
  entry,
  machines,
  timeZone,
}: {
  entry: QueueEntry;
  machines: readonly MachineOption[];
  timeZone: string;
}) {
  const router = useRouter();
  const toast = useToast();
  const headingId = useId();
  const [machineId, setMachineId] = useState(entry.suggestedMachineId ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const name = entry.externalName ?? entry.externalId;

  const options = [
    { value: "", label: "Välj automat" },
    ...machines.map((m) => ({
      value: m.id,
      label: `${m.code} · ${m.name}${m.storeName ? ` (${m.storeName})` : ""}`,
    })),
  ];

  const connect = () =>
    startTransition(async () => {
      setError(null);
      if (!machineId) {
        setError("Välj vilken automat namnet avser.");
        return;
      }
      const result = await mapSourceMachine({ sourceMachineId: entry.id, machineId });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      toast({
        title: `${name} är kopplad till ${result.data.machineCode}`,
        description: `${formatInt(result.data.orders)} order fick automaten. Lönsamhet och lager räknas om.`,
        tone: "ok",
      });
      router.refresh();
    });

  return (
    <Panel className="grid min-w-0 gap-4 md:grid-cols-12 md:items-end" aria-labelledby={headingId}>
      <div className="flex min-w-0 flex-col gap-1 md:col-span-5">
        <p className="label text-subtle">Namn i Awish · {entry.dataSourceName}</p>
        <p id={headingId} className="truncate text-md font-medium text-fg">
          {name}
        </p>
        <p className="tnum text-sm text-muted">
          {formatInt(entry.pendingOrders)}
          {NBSP}order väntar
          {entry.firstOrderAt
            ? ` · ${formatWhen(entry.firstOrderAt, timeZone)}${NBSP}${EN_DASH}${NBSP}${formatWhen(entry.lastOrderAt, timeZone)}`
            : ""}
        </p>
      </div>
      <form
        className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-end md:col-span-7"
        onSubmit={(e) => {
          e.preventDefault();
          connect();
        }}
      >
        <Select
          label="Koppla till"
          value={machineId}
          options={options}
          onChange={(e) => setMachineId(e.target.value)}
          error={error ?? undefined}
          hint={
            entry.suggestedMachineId && machineId === entry.suggestedMachineId
              ? "Förslag: koden står i namnet."
              : undefined
          }
          wrapperClassName="min-w-0 flex-1"
        />
        <Button type="submit" variant="primary" loading={pending} className="sm:mb-[22px]">
          Koppla
        </Button>
      </form>
    </Panel>
  );
}

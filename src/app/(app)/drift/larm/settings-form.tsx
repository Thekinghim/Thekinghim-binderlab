"use client";

import { useRouter } from "next/navigation";
import { useId, useState, useTransition, type FormEvent, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/field";
import { useToast } from "@/components/ui/toast";

import type {
  FieldErrors,
  SubscriptionInput,
  SubscriptionRow,
} from "@/server/alerts/subscriptions";

import { saveAlertSubscription } from "../actions";

export interface KindOption {
  readonly value: string;
  readonly label: string;
  readonly hint: string;
}

const DAYS = [
  { value: 1, label: "Mån" },
  { value: 2, label: "Tis" },
  { value: 3, label: "Ons" },
  { value: 4, label: "Tor" },
  { value: 5, label: "Fre" },
  { value: 6, label: "Lör" },
  { value: 7, label: "Sön" },
];

function Check({
  checked,
  onChange,
  children,
  hint,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  children: ReactNode;
  hint?: string;
}) {
  const id = useId();
  return (
    <div className="flex items-start gap-2">
      <input
        id={id}
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 size-4 shrink-0 accent-current"
        aria-describedby={hint ? `${id}-hint` : undefined}
      />
      <label htmlFor={id} className="flex flex-col gap-0.5 text-sm text-fg">
        {children}
        {hint ? (
          <span id={`${id}-hint`} className="text-xs text-subtle">
            {hint}
          </span>
        ) : null}
      </label>
    </div>
  );
}

function Group({
  legend,
  error,
  children,
}: {
  legend: string;
  error?: string;
  children: ReactNode;
}) {
  return (
    <fieldset className="flex min-w-0 flex-col gap-3 border-t border-line pt-4">
      <legend className="label float-left mb-3 w-full text-muted">{legend}</legend>
      {children}
      {error ? <p className="text-xs text-signal-fg">{error}</p> : null}
    </fieldset>
  );
}

/** Larminställningar för den inloggade: vilka larm, vilka automater, när och i vilka kanaler. */
export function SettingsForm({
  initial,
  kinds,
  machines,
  channels,
}: {
  initial: SubscriptionRow;
  kinds: KindOption[];
  machines: { id: string; label: string }[];
  channels: { value: "push" | "email" | "sms"; label: string; hint: string }[];
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  const [errors, setErrors] = useState<FieldErrors>({});
  const w = initial.deliveryWindows?.[0];
  const [v, setV] = useState<SubscriptionInput>({
    allKinds: initial.kinds === null,
    kinds: initial.kinds ?? kinds.map((k) => k.value),
    allMachines: initial.machineIds === null,
    machineIds: initial.machineIds ?? machines.map((m) => m.id),
    minSeverity: initial.minSeverity,
    channels: initial.channels,
    phone: initial.phone ?? "",
    quiet: initial.quietStart !== null,
    quietStart: initial.quietStart ?? "22:00",
    quietEnd: initial.quietEnd ?? "07:00",
    window: Boolean(w),
    windowDays: w?.days ?? [1, 2, 3, 4, 5],
    windowStart: w?.start ?? "07:00",
    windowEnd: w?.end ?? "18:00",
    criticalDuringQuiet: initial.criticalDuringQuiet,
    notifyResolved: initial.notifyResolved,
    reminders: initial.reminders,
    active: initial.active,
  });
  const set = <K extends keyof SubscriptionInput>(k: K, value: SubscriptionInput[K]) =>
    setV((prev) => ({ ...prev, [k]: value }));
  const toggle = <T,>(list: readonly T[], item: T, on: boolean): T[] =>
    on ? [...new Set([...list, item])] : list.filter((x) => x !== item);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    start(async () => {
      const r = await saveAlertSubscription(v);
      setErrors(r.errors ?? {});
      if (r.ok) {
        toast({ title: "Larminställningarna sparade", tone: "ok" });
        router.refresh();
      } else {
        toast({ title: r.errors?.form ?? "Rätta fälten som är markerade", tone: "critical" });
      }
    });
  };

  return (
    <form
      onSubmit={submit}
      noValidate
      className="flex flex-col gap-8"
      aria-label="Larminställningar"
    >
      <Check checked={v.active} onChange={(x) => set("active", x)}>
        Ta emot larm
      </Check>

      <div className="flex flex-col gap-8">
        <Group legend="Larm" error={errors.kinds}>
          <Check checked={v.allKinds} onChange={(x) => set("allKinds", x)}>
            Alla typer jag får se
          </Check>
          {!v.allKinds ? (
            <div className="grid gap-3 sm:grid-cols-2">
              {kinds.map((k) => (
                <Check
                  key={k.value}
                  checked={v.kinds.includes(k.value)}
                  onChange={(x) => set("kinds", toggle(v.kinds, k.value, x))}
                  hint={k.hint}
                >
                  {k.label}
                </Check>
              ))}
            </div>
          ) : null}
          <Select
            label="Lägsta allvar"
            value={v.minSeverity}
            onChange={(e) => set("minSeverity", e.target.value)}
            error={errors.minSeverity}
            wrapperClassName="max-w-xs"
            options={[
              { value: "critical", label: "Bara kritiska" },
              { value: "warning", label: "Varningar och kritiska" },
              { value: "info", label: "Allt, även information" },
            ]}
          />
        </Group>

        <Group legend="Automater" error={errors.machineIds}>
          <Check checked={v.allMachines} onChange={(x) => set("allMachines", x)}>
            Alla automater
          </Check>
          {!v.allMachines ? (
            <div className="grid gap-3 sm:grid-cols-2">
              {machines.map((m) => (
                <Check
                  key={m.id}
                  checked={v.machineIds.includes(m.id)}
                  onChange={(x) => set("machineIds", toggle(v.machineIds, m.id, x))}
                >
                  {m.label}
                </Check>
              ))}
            </div>
          ) : null}
        </Group>

        <Group legend="Kanaler" error={errors.channels}>
          <div className="grid gap-3 sm:grid-cols-3">
            {channels.map((c) => (
              <Check
                key={c.value}
                checked={v.channels.includes(c.value)}
                onChange={(x) => set("channels", toggle(v.channels, c.value, x))}
                hint={c.hint}
              >
                {c.label}
              </Check>
            ))}
          </div>
          {v.channels.includes("sms") ? (
            <Input
              label="Mobilnummer för sms"
              type="tel"
              autoComplete="tel"
              value={v.phone}
              onChange={(e) => set("phone", e.target.value)}
              error={errors.phone}
              wrapperClassName="max-w-xs"
            />
          ) : null}
        </Group>

        <Group legend="Tider" error={errors.windowDays ?? errors.windowStart ?? errors.quietStart}>
          <Check
            checked={v.quiet}
            onChange={(x) => set("quiet", x)}
            hint="Skickas när tiden är slut."
          >
            Tysta timmar
          </Check>
          {v.quiet ? (
            <div className="grid max-w-sm grid-cols-2 gap-3">
              <Input
                label="Från"
                type="time"
                value={v.quietStart}
                onChange={(e) => set("quietStart", e.target.value)}
              />
              <Input
                label="Till"
                type="time"
                value={v.quietEnd}
                onChange={(e) => set("quietEnd", e.target.value)}
              />
            </div>
          ) : null}
          <Check
            checked={v.window}
            onChange={(x) => set("window", x)}
            hint="Skjuts upp utanför tiderna."
          >
            Bara vissa dagar och tider
          </Check>
          {v.window ? (
            <div className="flex flex-col gap-3">
              <div className="flex flex-wrap gap-3" role="group" aria-label="Veckodagar">
                {DAYS.map((d) => (
                  <Check
                    key={d.value}
                    checked={v.windowDays.includes(d.value)}
                    onChange={(x) => set("windowDays", toggle(v.windowDays, d.value, x))}
                  >
                    {d.label}
                  </Check>
                ))}
              </div>
              <div className="grid max-w-sm grid-cols-2 gap-3">
                <Input
                  label="Från"
                  type="time"
                  value={v.windowStart}
                  onChange={(e) => set("windowStart", e.target.value)}
                />
                <Input
                  label="Till"
                  type="time"
                  value={v.windowEnd}
                  onChange={(e) => set("windowEnd", e.target.value)}
                />
              </div>
            </div>
          ) : null}
          <Check
            checked={v.criticalDuringQuiet}
            onChange={(x) => set("criticalDuringQuiet", x)}
            hint="Ur drift, fel och slut kommer direkt."
          >
            Kritiska larm alltid direkt
          </Check>
        </Group>

        <Group legend="Uppföljning">
          <Check
            checked={v.reminders}
            onChange={(x) => set("reminders", x)}
            hint="Kritiska efter 4 h, varningar efter 24 h."
          >
            Påminnelser om olösta larm
          </Check>
          <Check checked={v.notifyResolved} onChange={(x) => set("notifyResolved", x)}>
            Meddela när problemet är löst
          </Check>
        </Group>
      </div>

      {errors.form ? <p className="text-sm text-signal-fg">{errors.form}</p> : null}
      <div>
        <Button type="submit" variant="primary" loading={pending}>
          Spara larminställningar
        </Button>
      </div>
    </form>
  );
}

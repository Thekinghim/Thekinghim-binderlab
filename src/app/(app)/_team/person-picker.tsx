"use client";

import { useId, useState, useTransition } from "react";

import type { PersonOption } from "@/analytics/team";
import { Icon } from "@/components/ui/icon";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/cn";

import { assignTodo, setMachineResponsible } from "./actions";

/** Vad valet sparas på: en automat (ansvarig) eller en punkt i Att göra (tilldelad). */
export type PersonTarget =
  | { readonly kind: "machine"; readonly machineId: string }
  | { readonly kind: "todo"; readonly key: string };

/**
 * Litet val "Ansvarig: Jag ▾" som sparar direkt. Utan `editable` visas bara texten.
 * Ändringen syns direkt och backas om servern säger nej.
 */
export function PersonPicker({
  target,
  value,
  options,
  label = "Ansvarig",
  editable = true,
  hideLabel = false,
  className,
}: {
  target: PersonTarget;
  /** "" = Båda. */
  value: string;
  options: readonly PersonOption[];
  label?: string;
  editable?: boolean;
  /** Etiketten bara för skärmläsare (när raden redan säger vad valet är). */
  hideLabel?: boolean;
  className?: string;
}) {
  const id = useId();
  const toast = useToast();
  const [current, setCurrent] = useState(value);
  const [pending, startTransition] = useTransition();
  const text = options.find((o) => o.value === current)?.label ?? "Båda";

  if (!editable) {
    return (
      <span className={cn("label text-subtle", className)}>
        <span className={hideLabel ? "sr-only" : undefined}>{label}: </span>
        <span className="text-muted">{text}</span>
      </span>
    );
  }

  const change = (next: string) => {
    const before = current;
    setCurrent(next);
    startTransition(async () => {
      const result =
        target.kind === "machine"
          ? await setMachineResponsible({ machineId: target.machineId, userId: next })
          : await assignTodo({ key: target.key, userId: next });
      if (!result.ok) {
        setCurrent(before);
        toast({ title: "Kunde inte spara", description: result.error, tone: "critical" });
        return;
      }
      toast({
        title: `${label}: ${options.find((o) => o.value === next)?.label ?? "Båda"}`,
        tone: "ok",
      });
    });
  };

  return (
    <span
      className={cn(
        "relative inline-flex h-7 items-center gap-1 rounded-sm border border-line-strong pr-6 pl-2 transition-colors duration-fast hover:border-line-control hover:bg-hover max-md:h-11",
        pending && "opacity-70",
        className,
      )}
    >
      <label htmlFor={id} className={hideLabel ? "sr-only" : "label text-subtle"}>
        {label}
      </label>
      <select
        id={id}
        value={current}
        disabled={pending}
        onChange={(e) => change(e.target.value)}
        className="label cursor-pointer appearance-none bg-transparent pr-1 text-fg focus-visible:outline-none max-md:h-11 max-md:min-w-24 max-md:font-sans max-md:tracking-normal max-md:normal-case"
      >
        {options.map((o) => (
          <option key={o.value || "bada"} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <Icon
        name="chevronDown"
        size={12}
        className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 text-subtle"
      />
    </span>
  );
}

"use client";

import { useEffect, useId, useRef, useState } from "react";
import { cn } from "@/lib/cn";
import { Icon } from "@/components/ui/icon";
import { Segmented } from "@/components/ui/segmented";
import { DateRangePicker } from "./date-range-picker";
import { periodChoices, type PeriodKey } from "./period-state";
import { usePeriod, useScope } from "./use-period";

export type ShellStore = { id: string; name: string };
export type ShellMachine = {
  id: string;
  /** Visningsnamn, t.ex. "Helsingborg C". */
  name: string;
  /** Kort id i mono, t.ex. "BL-006". */
  code?: string;
  storeId?: string;
};

const longOptions = periodChoices.map((c) => ({ value: c.key, label: c.label }));
const shortOptions = periodChoices.map((c) => ({ value: c.key, label: c.short }));

/* ------------------------------------------------------------------ */
/* Period                                                              */
/* ------------------------------------------------------------------ */

/**
 * Periodväljare kopplad till URL:en. "Eget intervall" öppnar en
 * datumväljare; förvalen skrivs direkt.
 */
export function PeriodControl({ earliest, className }: { earliest?: Date; className?: string }) {
  const period = usePeriod({ earliest });
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        wrapRef.current
          ?.querySelector<HTMLButtonElement>('[role="radio"][aria-checked="true"]')
          ?.focus();
      }
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    // Fokus till den förvalda dagen i rutnätet.
    requestAnimationFrame(() =>
      wrapRef.current
        ?.querySelector<HTMLButtonElement>('[role="grid"] button[tabindex="0"]')
        ?.focus(),
    );
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const choose = (key: PeriodKey) => {
    if (key === "eget") {
      setOpen(true);
      return;
    }
    setOpen(false);
    period.setPeriod({ key });
  };

  return (
    <div ref={wrapRef} className={cn("relative min-w-0", className)}>
      <div className="hidden 2xl:block">
        <Segmented
          label="Period"
          options={longOptions}
          value={period.key}
          onChange={choose}
          size="sm"
        />
      </div>
      <div className="2xl:hidden">
        <Segmented
          label="Period"
          options={shortOptions}
          value={period.key}
          onChange={choose}
          size="sm"
        />
      </div>

      {open ? (
        <div
          id={panelId}
          role="dialog"
          aria-label="Eget intervall"
          className="absolute top-full left-0 z-40 mt-2 w-[min(352px,calc(100vw-32px))] animate-enter rounded-md border border-line-strong bg-surface p-4"
        >
          <DateRangePicker
            value={period.range}
            max={period.today}
            min={earliest}
            onCancel={() => setOpen(false)}
            onApply={(range) => {
              setOpen(false);
              period.setPeriod({ key: "eget", range });
            }}
          />
        </div>
      ) : null}
    </div>
  );
}

/** Mono-raden: vald period och jämförelseperioden, t.ex. "4 okt. – 2 nov. mot 4 sep. – 3 okt.". */
export function PeriodReadout({ earliest, className }: { earliest?: Date; className?: string }) {
  const p = usePeriod({ earliest });
  return (
    <p
      className={cn(
        "meta tnum flex min-w-0 flex-wrap items-baseline gap-x-2 text-muted",
        className,
      )}
    >
      <span className="sr-only">Vald period: </span>
      <span className="text-fg">{p.rangeLabel}</span>
      {p.comparisonLabel ? (
        <>
          <span className="text-subtle">mot</span>
          <span>{p.comparisonLabel}</span>
        </>
      ) : (
        <span className="text-subtle">ingen jämförelse</span>
      )}
    </p>
  );
}

/** Platshållare med samma mått medan URL:en läses (Suspense). */
export function PeriodControlFallback() {
  return (
    <div className="flex items-center gap-4" aria-hidden>
      <div className="h-7 w-[280px] max-w-full rounded-sm border border-line-strong 2xl:w-[480px]" />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Filter                                                              */
/* ------------------------------------------------------------------ */

function CompactSelect({
  label,
  value,
  onChange,
  options,
  allLabel,
  className,
}: {
  label: string;
  value: string | null;
  onChange: (v: string | null) => void;
  options: Array<{ value: string; label: string }>;
  allLabel: string;
  className?: string;
}) {
  const id = useId();
  return (
    <div className={cn("flex min-w-0 items-center gap-2", className)}>
      <label htmlFor={id} className="label shrink-0 text-subtle">
        {label}
      </label>
      <div className="relative min-w-0 flex-1">
        <select
          id={id}
          value={value ?? ""}
          onChange={(e) => onChange(e.target.value || null)}
          className={cn(
            "h-7 w-full min-w-0 appearance-none truncate rounded-sm border border-line-control bg-bg pr-7 pl-2 text-sm transition-colors hover:border-muted",
            value ? "text-fg" : "text-muted",
          )}
        >
          <option value="">{allLabel}</option>
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <Icon
          name="chevronDown"
          size={12}
          className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 text-subtle"
        />
      </div>
    </div>
  );
}

/**
 * Globalt filter på butik och automat. Val av butik begränsar
 * automatlistan; val av automat sätter dess butik.
 */
export function ScopeFilter({
  stores,
  machines,
  className,
}: {
  stores: ShellStore[];
  machines: ShellMachine[];
  className?: string;
}) {
  const scope = useScope();
  const visibleMachines = scope.butik
    ? machines.filter((m) => m.storeId === scope.butik)
    : machines;
  return (
    <div className={cn("flex min-w-0 items-center gap-4", className)}>
      {stores.length > 0 ? (
        <CompactSelect
          label="Butik"
          value={scope.butik}
          allLabel="Alla butiker"
          options={stores.map((s) => ({ value: s.id, label: s.name }))}
          onChange={(butik) => {
            const keep = butik && machines.find((m) => m.id === scope.automat)?.storeId === butik;
            scope.setScope({ butik, automat: keep ? scope.automat : null });
          }}
          className="sm:max-w-[200px]"
        />
      ) : null}
      {machines.length > 0 ? (
        <CompactSelect
          label="Automat"
          value={scope.automat}
          allLabel="Alla automater"
          options={visibleMachines.map((m) => ({
            value: m.id,
            label: m.code ? `${m.code} ${m.name}` : m.name,
          }))}
          onChange={(automat) => {
            const storeId = machines.find((m) => m.id === automat)?.storeId;
            scope.setScope(automat && storeId ? { automat, butik: storeId } : { automat });
          }}
          className="sm:max-w-[220px]"
        />
      ) : null}
    </div>
  );
}

/** Antal aktiva filter, för mobilens filterknapp. */
export function useActiveFilterCount(): number {
  const s = useScope();
  return (s.butik ? 1 : 0) + (s.automat ? 1 : 0);
}

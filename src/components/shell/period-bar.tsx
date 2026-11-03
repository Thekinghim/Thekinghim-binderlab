"use client";

import { useEffect, useId, useRef, useState } from "react";
import { cn } from "@/lib/cn";
import { Icon } from "@/components/ui/icon";
import { Segmented } from "@/components/ui/segmented";
import { DateRangePicker } from "./date-range-picker";
import { periodChoices, type PeriodKey } from "./period-state";
import { usePeriod, useScope } from "./use-period";

export type ShellStore = {
  id: string;
  name: string;
  /** Ort, sökbar i kommandopaletten, t.ex. "Helsingborg". */
  city?: string;
};
export type ShellMachine = {
  id: string;
  /** Visningsnamn, t.ex. "Helsingborg C". */
  name: string;
  /** Kort id i mono, t.ex. "BL-006". */
  code?: string;
  storeId?: string;
};

const presets = periodChoices.filter(
  (c): c is (typeof periodChoices)[number] & { key: PresetKey } => c.key !== "eget",
);
const longOptions = presets.map((c) => ({ value: c.key, label: c.label }));
const shortOptions = presets.map((c) => ({ value: c.key, label: c.short }));
const customChoice = periodChoices.find((c) => c.key === "eget");

type PresetKey = Exclude<PeriodKey, "eget">;

/** Väntetid innan ett pilval skrivs till URL:en (varje skrivning renderar sidan på servern). */
const KEYBOARD_COMMIT_MS = 350;

/** Den synliga av flera kandidater (de responsiva varianterna ligger i DOM:en samtidigt). */
function firstVisible<T extends HTMLElement>(root: HTMLElement | null, selector: string): T | null {
  if (!root) return null;
  for (const el of root.querySelectorAll<T>(selector)) {
    if (el.getClientRects().length > 0) return el;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Period                                                              */
/* ------------------------------------------------------------------ */

/**
 * Periodväljare kopplad till URL:en: en radiogrupp med förvalen och en
 * separat knapp "Eget intervall" som öppnar datumväljaren.
 *
 * - Klick skriver till URL:en direkt. Pilval visas direkt men skrivs först
 *   när man stannat (KEYBOARD_COMMIT_MS), så att varje tangenttryck inte
 *   blir en serverrendering.
 * - Datumväljaren öppnas bara av knappen (klick, Enter, mellanslag), aldrig
 *   av pilnavigering. Esc, Avbryt och Använd lämnar fokus på knappen.
 */
export function PeriodControl({ earliest, className }: { earliest?: Date; className?: string }) {
  const period = usePeriod({ earliest });
  const { setPeriod } = period;
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  // Ett pilval som ännu inte skrivits. Gäller bara så länge URL:en står kvar
  // på värdet det gjordes från; när URL:en ändras visas URL:ens värde.
  const [pending, setPending] = useState<{ key: PresetKey; from: PeriodKey } | null>(null);
  const shown = pending && pending.from === period.key ? pending.key : period.key;
  const timer = useRef<number | undefined>(undefined);
  const pointerAt = useRef(Number.NEGATIVE_INFINITY);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const close = (focusTrigger: boolean) => {
    setOpen(false);
    if (focusTrigger) requestAnimationFrame(() => triggerRef.current?.focus());
  };

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    // Fokus till den förvalda dagen i rutnätet.
    const raf = requestAnimationFrame(() =>
      firstVisible<HTMLButtonElement>(
        wrapRef.current,
        '[role="grid"] button[tabindex="0"]',
      )?.focus(),
    );
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const choose = (key: PresetKey) => {
    setOpen(false);
    window.clearTimeout(timer.current);
    const byPointer = performance.now() - pointerAt.current < 1000;
    if (byPointer) {
      // Valet visas direkt; URL:en (och datan) följer när servern svarat.
      setPending(key !== period.key ? { key, from: period.key } : null);
      if (key !== period.key) setPeriod({ key });
      return;
    }
    setPending({ key, from: period.key });
    timer.current = window.setTimeout(() => {
      if (key !== period.key) setPeriod({ key });
    }, KEYBOARD_COMMIT_MS);
  };

  const custom = shown === "eget";

  return (
    <div ref={wrapRef} className={cn("relative flex min-w-0 items-center gap-2", className)}>
      <div
        className="min-w-0"
        onPointerDown={() => {
          pointerAt.current = performance.now();
        }}
      >
        <div className="hidden xl:block">
          <Segmented
            label="Period"
            options={longOptions}
            value={shown as PresetKey}
            onChange={choose}
            size="sm"
          />
        </div>
        <div className="xl:hidden">
          <Segmented
            label="Period"
            options={shortOptions}
            value={shown as PresetKey}
            onChange={choose}
            size="sm"
          />
        </div>
      </div>

      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "label relative flex h-7 shrink-0 items-center gap-1.5 rounded-sm border border-line-strong px-2.5 whitespace-nowrap transition-[background-color,color] duration-fast ease-instrument",
          custom
            ? "bg-hover font-medium text-fg after:pointer-events-none after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:bg-fg"
            : open
              ? "text-fg"
              : "text-subtle hover:text-muted",
        )}
      >
        <Icon name="calendar" size={12} />
        <span className="hidden xl:inline">{customChoice?.label}</span>
        <span className="xl:hidden">{customChoice?.short}</span>
        {custom ? <span className="sr-only">, vald</span> : null}
      </button>

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
            onCancel={() => close(true)}
            onApply={(range) => {
              close(true);
              setPending(null);
              setPeriod({ key: "eget", range });
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
    <div className="flex items-center gap-2" aria-hidden>
      <div className="h-7 w-[248px] max-w-[calc(100%-72px)] rounded-sm border border-line-strong xl:w-[336px]" />
      <div className="h-7 w-16 rounded-sm border border-line-strong xl:w-[136px]" />
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
  compactLabel = false,
  className,
}: {
  label: string;
  value: string | null;
  onChange: (v: string | null) => void;
  options: Array<{ value: string; label: string }>;
  allLabel: string;
  /** Etiketten bara för skärmläsare under xl (värdet "Alla butiker" bär betydelsen). */
  compactLabel?: boolean;
  className?: string;
}) {
  const id = useId();
  return (
    <div className={cn("flex min-w-0 items-center gap-2", className)}>
      <label
        htmlFor={id}
        className={cn("label shrink-0 text-subtle", compactLabel && "sr-only xl:not-sr-only")}
      >
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
  compact = false,
  className,
}: {
  stores: ShellStore[];
  machines: ShellMachine[];
  /** Kontextraden på skrivbord: etiketterna visas först från xl, så att raden får plats. */
  compact?: boolean;
  className?: string;
}) {
  const scope = useScope();
  const { setScope } = scope;
  // En djuplänk med bara ?automat= visar automatens butik som vald och
  // skriver in den i URL:en, så att servern läser samma filter.
  const impliedStore = scope.automat
    ? (machines.find((m) => m.id === scope.automat)?.storeId ?? null)
    : null;
  const butik = scope.butik ?? impliedStore;
  useEffect(() => {
    if (!scope.butik && impliedStore && scope.automat) {
      setScope({ butik: impliedStore, automat: scope.automat });
    }
  }, [scope.butik, scope.automat, impliedStore, setScope]);

  const visibleMachines = butik ? machines.filter((m) => m.storeId === butik) : machines;
  return (
    <div className={cn("flex min-w-0 items-center gap-4", className)}>
      {stores.length > 0 ? (
        <CompactSelect
          label="Butik"
          value={butik}
          allLabel="Alla butiker"
          compactLabel={compact}
          options={stores.map((s) => ({ value: s.id, label: s.name }))}
          onChange={(next) => {
            const keep = next && machines.find((m) => m.id === scope.automat)?.storeId === next;
            setScope({ butik: next, automat: keep ? scope.automat : null });
          }}
          className="sm:max-w-[200px]"
        />
      ) : null}
      {machines.length > 0 ? (
        <CompactSelect
          label="Automat"
          value={scope.automat}
          allLabel="Alla automater"
          compactLabel={compact}
          options={visibleMachines.map((m) => ({
            value: m.id,
            label: m.code ? `${m.code} ${m.name}` : m.name,
          }))}
          onChange={(automat) => {
            const storeId = machines.find((m) => m.id === automat)?.storeId;
            setScope(automat && storeId ? { automat, butik: storeId } : { automat });
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

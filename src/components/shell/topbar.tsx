"use client";

import Link from "next/link";
import { Suspense, useId, useState } from "react";
import { cn } from "@/lib/cn";
import { IconButton } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Segmented } from "@/components/ui/segmented";
import { HotkeyHint } from "./kbd";
import { Logo } from "./logo";
import {
  PeriodControl,
  PeriodControlFallback,
  PeriodReadout,
  ScopeFilter,
  useActiveFilterCount,
  type ShellMachine,
  type ShellStore,
} from "./period-bar";
import { ThemeToggle } from "./theme-toggle";

/**
 * Äldre, lokalt periodval (används av /design och /datamodell som styr
 * perioden själva). Nya sidor använder URL-periodval: usePeriod().
 */
export type Period = "idag" | "7d" | "30d" | "90d" | "atd";

export const periodOptions = [
  { value: "idag", label: "I dag" },
  { value: "7d", label: "7 d" },
  { value: "30d", label: "30 d" },
  { value: "90d", label: "90 d" },
  { value: "atd", label: "I år" },
] as const satisfies ReadonlyArray<{ value: Period; label: string }>;

export type TopbarProps = {
  crumbs: string[];
  /** Öppnar kommandopaletten. */
  onOpenCommand?: () => void;
  /** Visa periodval och filter (URL-styrt). Standard true. */
  showContext?: boolean;
  stores?: ShellStore[];
  machines?: ShellMachine[];
  /** Första dagen med data; ger "Allt" ett intervall och spärrar datumväljaren före den. */
  earliest?: Date;
  /** Äldre lokalt periodval. När period och onPeriodChange ges ersätter de URL-periodvalet. */
  period?: Period;
  onPeriodChange?: (p: Period) => void;
  /** Äldre: beskrivning av jämförelseperioden, t.ex. "mot 26 sep – 25 okt". */
  comparison?: string;
  /** @deprecated Mobilmenyn nås nu via bottenraden. Ignoreras. */
  onOpenMenu?: () => void;
};

/**
 * Toppbar i två lager:
 * 1. Var jag är (brödsmulor; bara sista ledet under md), sök (⌘K/Ctrl K) och läge.
 * 2. Kontextraden: periodval med jämförelse i mono, och filter på butik/automat.
 * Lager 1 är alltid fäst. Kontextraden är fäst från md; på mobil rullar den bort.
 */
export function Topbar({
  crumbs,
  onOpenCommand,
  showContext = true,
  stores = [],
  machines = [],
  earliest,
  period,
  onPeriodChange,
  comparison,
}: TopbarProps) {
  const legacy = period !== undefined && onPeriodChange !== undefined;
  const hasScope = stores.length > 0 || machines.length > 0;

  return (
    <>
      <header className="sticky top-0 z-30 border-b border-line bg-bg">
        <div className="flex h-14 items-center gap-3 px-4 md:px-6">
          <Link href="/" className="shrink-0 rounded-xs lg:hidden" aria-label="Binderlab, till Hem">
            <Logo withWordmark={false} />
          </Link>
          <Crumbs crumbs={crumbs} />
          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              onClick={onOpenCommand}
              aria-label="Sök och kommandon"
              aria-keyshortcuts="Meta+K Control+K"
              className="hidden h-8 items-center gap-2 rounded-sm border border-line-strong pr-1.5 pl-2.5 text-subtle transition-colors hover:border-line-control hover:text-fg sm:flex"
            >
              <Icon name="search" />
              <span className="text-sm">Sök</span>
              <HotkeyHint className="ml-4" />
            </button>
            <IconButton
              icon="search"
              label="Sök och kommandon"
              className="sm:hidden"
              onClick={onOpenCommand}
            />
            <ThemeToggle />
          </div>
        </div>
      </header>

      {showContext ? (
        <div className="z-20 border-b border-line bg-bg md:sticky md:top-14">
          {legacy ? (
            <LegacyContext
              period={period}
              onPeriodChange={onPeriodChange}
              comparison={comparison}
            />
          ) : (
            <Suspense fallback={<ContextFallback />}>
              <UrlContext
                stores={stores}
                machines={machines}
                earliest={earliest}
                hasScope={hasScope}
              />
            </Suspense>
          )}
        </div>
      ) : null}
    </>
  );
}

function Crumbs({ crumbs }: { crumbs: string[] }) {
  return (
    <nav aria-label="Brödsmulor" className="min-w-0 flex-1">
      <ol className="label flex min-w-0 items-center gap-2 text-subtle">
        {crumbs.map((c, i) => {
          const last = i === crumbs.length - 1;
          return (
            <li
              key={`${i}-${c}`}
              // Under md visas bara sista ledet, så att det aldrig kapas.
              className={cn("min-w-0 items-center gap-2", last ? "flex" : "hidden md:flex")}
            >
              {i > 0 ? (
                <span aria-hidden className="hidden text-faint md:inline">
                  /
                </span>
              ) : null}
              <span
                aria-current={last ? "page" : undefined}
                className={cn("truncate", last && "text-fg")}
              >
                {c}
              </span>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

function UrlContext({
  stores,
  machines,
  earliest,
  hasScope,
}: {
  stores: ShellStore[];
  machines: ShellMachine[];
  earliest?: Date;
  hasScope: boolean;
}) {
  const [filtersOpen, setFiltersOpen] = useState(false);
  const filterId = useId();
  const active = useActiveFilterCount();
  return (
    <div className="px-4 py-2 md:px-6">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
        <PeriodControl earliest={earliest} className="max-w-full" />
        <div className="flex min-w-64 flex-1 items-center justify-between gap-4">
          <PeriodReadout earliest={earliest} />
          {hasScope ? (
            <button
              type="button"
              aria-expanded={filtersOpen}
              aria-controls={filterId}
              onClick={() => setFiltersOpen((o) => !o)}
              className="label tnum flex h-7 shrink-0 items-center gap-1.5 rounded-sm border border-line-strong px-2 text-muted transition-colors hover:text-fg md:hidden"
            >
              <Icon name="filter" size={12} />
              Filter{active ? ` · ${active}` : ""}
            </button>
          ) : null}
        </div>
        {hasScope ? (
          <ScopeFilter stores={stores} machines={machines} className="ml-auto hidden md:flex" />
        ) : null}
      </div>
      {hasScope && filtersOpen ? (
        <div id={filterId} className="mt-2 border-t border-line pt-2 md:hidden">
          <ScopeFilter
            stores={stores}
            machines={machines}
            className="flex-col items-stretch gap-2"
          />
        </div>
      ) : null}
    </div>
  );
}

function ContextFallback() {
  return (
    <div className="px-4 py-2 md:px-6">
      <PeriodControlFallback />
    </div>
  );
}

function LegacyContext({
  period,
  onPeriodChange,
  comparison,
}: {
  period: Period;
  onPeriodChange: (p: Period) => void;
  comparison?: string;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-2 px-4 py-2 md:px-6">
      <Segmented
        label="Period"
        size="sm"
        options={periodOptions}
        value={period}
        onChange={onPeriodChange}
      />
      {comparison ? <p className="meta tnum text-muted">{comparison}</p> : null}
    </div>
  );
}

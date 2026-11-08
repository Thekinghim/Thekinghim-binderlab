"use client";

import Link from "next/link";
import { AskAiButton } from "@/components/assistant/panel-context";
import { Suspense, useId, useState } from "react";
import { cn } from "@/lib/cn";
import { IconButton } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Segmented } from "@/components/ui/segmented";
import { CopyViewButton } from "./copy-view";
import { HotkeyHint } from "./kbd";
import { Logo } from "./logo";
import { WithCarriedQuery, withQuery } from "./side-nav";
import {
  PeriodControl,
  PeriodControlFallback,
  PeriodReadout,
  ScopeFilter,
  useActiveFilterCount,
  type ShellMachine,
  type ShellStore,
} from "./period-bar";
import { compactPeriod } from "./period-compact";
import { ThemeToggle } from "./theme-toggle";
import { usePeriod, useVmbView } from "./use-period";
import { VmbToggle } from "./vmb-toggle";

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
  /** Logons länk: rollens startsida. Standard "/". */
  homeHref?: string;
  /** Öppnar kommandopaletten. */
  onOpenCommand?: () => void;
  /** Assistentens sida, om rollen får se den (knapp i toppraden i stället för menypost). */
  assistantHref?: string;
  /** Visa periodval och filter (URL-styrt). Standard true. */
  showContext?: boolean;
  stores?: ShellStore[];
  machines?: ShellMachine[];
  /** Första dagen med data; ger "Allt" ett intervall och spärrar datumväljaren före den. */
  earliest?: Date;
  /**
   * Visa vyknappen "Med VMB" (roller som ser ekonomi). Värdet är användarens nyckel för
   * att minnas valet (localStorage). null/utelämnad = ingen knapp.
   */
  vmbUserKey?: string | null;
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
 * Lager 1 är alltid fäst. Kontextraden är fäst från md. Under md finns ingen egen kontextrad:
 * perioden (en knapp som öppnar valen) och filtret (ikon) står i lager 1 i stället för
 * brödsmulan, och temat ligger i bottenradens Mer.
 */
export function Topbar({
  crumbs,
  homeHref = "/",
  onOpenCommand,
  assistantHref,
  showContext = true,
  stores = [],
  machines = [],
  earliest,
  vmbUserKey = null,
  period,
  onPeriodChange,
  comparison,
}: TopbarProps) {
  const legacy = period !== undefined && onPeriodChange !== undefined;
  const hasScope = stores.length > 0 || machines.length > 0;
  const mobileContext = showContext && !legacy;

  return (
    <>
      <header className="sticky top-0 z-30 border-b border-line bg-bg">
        <div className="flex h-14 items-center gap-2 px-4 md:gap-3 md:px-6">
          {/* Som menyns länkar: period, filter och vyknapparna följer med till Hem. */}
          <WithCarriedQuery>
            {(query) => (
              <Link
                href={withQuery(homeHref, query)}
                className="relative shrink-0 rounded-xs before:absolute before:-inset-3.5 before:content-[''] lg:hidden"
                aria-label="Binderlab, till startsidan"
              >
                <Logo withWordmark={false} />
              </Link>
            )}
          </WithCarriedQuery>
          {/* Under md står perioden och filtret i toppraden i stället för sidans namn (som redan
              står i underflikarna), så att kontextraden inte tar en egen rad. */}
          <Crumbs crumbs={crumbs} className={mobileContext ? "max-md:hidden" : undefined} />
          {mobileContext ? (
            <Suspense fallback={<MobileContextFallback />}>
              <MobileContext
                stores={stores}
                machines={machines}
                earliest={earliest}
                hasScope={hasScope}
                vmbUserKey={vmbUserKey}
              />
            </Suspense>
          ) : null}
          <div className="flex shrink-0 items-center gap-1">
            {/* "Fråga AI" öppnar panelen (src/components/assistant); utan panel: länken. */}
            <AskAiButton fallbackHref={assistantHref} />
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
              className="max-sm:size-11 sm:hidden"
              onClick={onOpenCommand}
            />
            {/* Under md ligger temat i bottenradens Mer. */}
            <span className="contents max-md:hidden">
              <ThemeToggle />
            </span>
          </div>
        </div>
      </header>

      {showContext ? (
        <div
          className={cn(
            "z-20 border-b border-line bg-bg md:sticky md:top-14",
            mobileContext && "max-md:hidden",
          )}
        >
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
                vmbUserKey={vmbUserKey}
              />
            </Suspense>
          )}
        </div>
      ) : null}
    </>
  );
}

function Crumbs({ crumbs, className }: { crumbs: string[]; className?: string }) {
  return (
    <nav aria-label="Brödsmulor" className={cn("min-w-0 flex-1", className)}>
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

type ContextProps = {
  stores: ShellStore[];
  machines: ShellMachine[];
  earliest?: Date;
  hasScope: boolean;
  vmbUserKey: string | null;
};

/** Kontextraden från md: periodval och filter på rad 1, läsraden i mono på rad 2. */
function UrlContext({ stores, machines, earliest, hasScope, vmbUserKey }: ContextProps) {
  return (
    <div className="px-4 py-2 md:px-6">
      <div className="hidden flex-wrap items-center gap-x-6 gap-y-2 md:flex">
        <PeriodControl earliest={earliest} className="max-w-full" />
        {vmbUserKey ? <VmbToggle userKey={vmbUserKey} /> : null}
        {hasScope ? (
          <ScopeFilter stores={stores} machines={machines} compact className="ml-auto flex" />
        ) : null}
        <div className="flex min-w-0 basis-full items-center gap-1">
          <PeriodReadout earliest={earliest} />
          <CopyViewButton className="-my-1" />
        </div>
      </div>
    </div>
  );
}

/**
 * Mobilens kontext (under md), i toppraden: en knapp med perioden som öppnar valen och en
 * filterknapp (ikon, en prick när ett filter är valt). Valen öppnas under toppraden; ett
 * tryck utanför stänger dem.
 */
function MobileContext({ stores, machines, earliest, hasScope, vmbUserKey }: ContextProps) {
  const [open, setOpen] = useState<"period" | "filter" | null>(null);
  const panelId = useId();
  const active = useActiveFilterCount();
  const period = usePeriod({ earliest });
  const vmb = useVmbView(vmbUserKey);
  const compact = compactPeriod(period.key, period.rangeLabel);
  // Periodvalet stängs när en ny period är vald (sidan räknas om).
  const chosen = `${period.key}|${period.rangeLabel}`;
  const [lastChosen, setLastChosen] = useState(chosen);
  if (lastChosen !== chosen) {
    setLastChosen(chosen);
    if (open === "period") setOpen(null);
  }
  const toggle = (which: "period" | "filter") => setOpen((o) => (o === which ? null : which));

  return (
    <div className="flex min-w-0 flex-1 items-center gap-1 md:hidden">
      <button
        type="button"
        aria-expanded={open === "period"}
        aria-controls={panelId}
        aria-label={`${compact.label}${vmb.on && vmbUserKey ? ", med VMB" : ""} (byt period)`}
        onClick={() => toggle("period")}
        className="label tnum flex h-11 min-w-0 flex-1 items-center gap-1.5 rounded-sm px-1.5 text-left transition-colors hover:bg-hover"
      >
        <span className="min-w-0 truncate">
          <span className="font-medium text-fg">{compact.name}</span>
          {/* Datumen bara för ett eget intervall: "30 dagar" räcker, datumen står i valen. */}
          {compact.range && period.key === "eget" ? (
            <span className="text-muted">{` · ${compact.range}`}</span>
          ) : null}
        </span>
        {vmb.on && vmbUserKey ? (
          <span aria-hidden className="shrink-0 rounded-xs bg-hover px-1 text-fg">
            VMB
          </span>
        ) : null}
        <Icon
          name="chevronDown"
          size={12}
          className={cn(
            "shrink-0 text-subtle transition-transform duration-200 motion-reduce:transition-none",
            open === "period" && "rotate-180",
          )}
        />
      </button>
      {hasScope ? (
        <button
          type="button"
          aria-expanded={open === "filter"}
          aria-controls={panelId}
          aria-label={active ? `Filter, ${active} valda` : "Filter"}
          onClick={() => toggle("filter")}
          className={cn(
            "relative flex size-11 shrink-0 items-center justify-center rounded-sm transition-colors hover:bg-hover",
            open === "filter" || active ? "text-fg" : "text-subtle",
          )}
        >
          <Icon name="filter" />
          {active ? (
            <span
              aria-hidden
              className="absolute top-2.5 right-2.5 size-1.5 rounded-full bg-signal"
            />
          ) : null}
        </button>
      ) : null}
      {open ? (
        <>
          <button
            type="button"
            aria-label="Stäng"
            tabIndex={-1}
            onClick={() => setOpen(null)}
            className="fixed inset-x-0 top-14 bottom-0 z-0 cursor-default bg-overlay"
          />
          <div
            id={panelId}
            className="absolute inset-x-0 top-full z-10 flex max-h-[calc(100dvh-7rem)] animate-enter flex-col gap-2 overflow-y-auto border-b border-line bg-bg px-4 py-3"
          >
            {open === "period" ? (
              <>
                <PeriodControl earliest={earliest} className="max-w-full" />
                <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-1">
                    <PeriodReadout earliest={earliest} />
                    {/* Kopiera länk är ett datorverktyg (en ikon utan text). */}
                    <CopyViewButton className="-my-1 max-md:hidden" />
                  </div>
                  {/* VMB-valet är bokföring: på mobilen syns det bara när det är på, så att
                      det går att stänga av. */}
                  {vmbUserKey && vmb.on ? (
                    <VmbToggle userKey={vmbUserKey} className="max-md:min-h-11" />
                  ) : null}
                </div>
              </>
            ) : (
              <ScopeFilter
                stores={stores}
                machines={machines}
                className="flex-col items-stretch gap-2"
              />
            )}
          </div>
        </>
      ) : null}
    </div>
  );
}

function MobileContextFallback() {
  return <div aria-hidden className="h-11 min-w-0 flex-1 md:hidden" />;
}

function ContextFallback() {
  return (
    <div className="px-4 py-2 md:px-6">
      <div className="hidden md:block">
        <PeriodControlFallback />
        <div aria-hidden className="mt-2 h-4" />
      </div>
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

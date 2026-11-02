"use client";

import { IconButton } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Segmented } from "@/components/ui/segmented";
import { ThemeToggle } from "./theme-toggle";

export type Period = "idag" | "7d" | "30d" | "90d" | "atd";

export const periodOptions = [
  { value: "idag", label: "Idag" },
  { value: "7d", label: "7 d" },
  { value: "30d", label: "30 d" },
  { value: "90d", label: "90 d" },
  { value: "atd", label: "ÅTD" },
] as const satisfies ReadonlyArray<{ value: Period; label: string }>;

type TopbarProps = {
  crumbs: string[];
  period: Period;
  onPeriodChange: (p: Period) => void;
  /** Beskrivning av jämförelseperioden, t.ex. "mot 26 sep – 25 okt" */
  comparison?: string;
  onOpenMenu: () => void;
};

export function Topbar({ crumbs, period, onPeriodChange, comparison, onOpenMenu }: TopbarProps) {
  return (
    <header className="sticky top-0 z-30 border-b border-line bg-bg">
      <div className="flex h-14 items-center gap-3 px-4 md:px-6">
        <IconButton
          icon="menu"
          label="Öppna meny"
          className="-ml-2 lg:hidden"
          onClick={onOpenMenu}
        />

        <nav aria-label="Brödsmulor" className="min-w-0 flex-1">
          <ol className="label flex items-center gap-2 truncate text-subtle">
            {crumbs.map((c, i) => (
              <li key={c} className="flex items-center gap-2">
                {i > 0 ? (
                  <span aria-hidden className="text-faint">
                    /
                  </span>
                ) : null}
                <span
                  aria-current={i === crumbs.length - 1 ? "page" : undefined}
                  className={i === crumbs.length - 1 ? "text-fg" : ""}
                >
                  {c}
                </span>
              </li>
            ))}
          </ol>
        </nav>

        <div className="hidden items-center gap-3 md:flex">
          {comparison ? (
            <span className="label tnum hidden text-subtle xl:inline">{comparison}</span>
          ) : null}
          <Segmented
            label="Period"
            options={periodOptions}
            value={period}
            onChange={onPeriodChange}
          />
        </div>

        <div className="flex items-center gap-1">
          <button
            type="button"
            className="hidden h-9 items-center gap-2 rounded-sm border border-line-strong px-2.5 text-subtle transition-colors duration-[120ms] hover:border-line-control hover:text-fg sm:flex"
          >
            <Icon name="search" />
            <span className="text-sm">Sök</span>
            <kbd className="label ml-3 rounded-xs border border-line-strong px-1 text-[10px] leading-[14px]">
              ⌘K
            </kbd>
          </button>
          <IconButton icon="search" label="Sök" className="sm:hidden" />
          <ThemeToggle />
        </div>
      </div>

      {/* Mobil: periodval på egen rad */}
      <div className="flex items-center justify-between gap-3 border-t border-line px-4 py-2 md:hidden">
        <Segmented
          label="Period"
          size="sm"
          options={periodOptions}
          value={period}
          onChange={onPeriodChange}
        />
      </div>
    </header>
  );
}

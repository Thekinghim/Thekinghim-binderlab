"use client";

import { useState, type ReactNode } from "react";

import { cn } from "@/lib/cn";

import { Icon } from "./icon";

/**
 * En lista (ol) som under md bara visar de tre första raderna och en rad "Alla N …" som
 * fäller ut resten. En rad med `data-keep` visas alltid (t.ex. månaden att skicka härnäst).
 * Från md visas allt som förut och knappen syns inte.
 */
export function MobileTopList({
  total,
  noun,
  ariaLabel,
  className,
  children,
}: {
  /** Antalet rader i listan. */
  total: number;
  /** Vad raderna är, i plural ("månader"). */
  noun: string;
  ariaLabel?: string;
  className?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const folds = total > 3;
  return (
    <>
      <ol
        aria-label={ariaLabel}
        className={cn(
          className,
          folds && !open && "max-md:[&>li:nth-child(n+4):not([data-keep])]:hidden",
        )}
      >
        {children}
      </ol>
      {folds ? (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          className="label flex min-h-11 w-full items-center justify-between gap-3 border-y border-line text-left text-muted transition-colors hover:text-fg md:hidden"
        >
          {open ? "Visa färre" : `Alla ${total} ${noun}`}
          <Icon
            name="chevronDown"
            size={12}
            className={cn(
              "shrink-0 text-subtle transition-transform duration-200 motion-reduce:transition-none",
              open && "rotate-180",
            )}
          />
        </button>
      ) : null}
    </>
  );
}

/** Raderna en tabell visar på mobilen innan "Visa alla N". */
export const MOBILE_TOP_ROWS = 5;

/**
 * Som MobileTopList för en tabell (DataTable): under md visas bara de fem första raderna i
 * tabellens ordning och en rad "Visa alla N" som fäller ut resten. Summaraden (tfoot) syns
 * alltid. Från md visas allt som förut och knappen syns inte. `defaultOpen`: öppen från
 * början (t.ex. när en vald rad kan ligga längre ner).
 */
export function MobileTopRows({
  total,
  noun,
  defaultOpen = false,
  children,
}: {
  /** Antalet rader i tabellen. */
  total: number;
  /** Vad raderna är, i plural ("titlar"). */
  noun: string;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const folds = total > MOBILE_TOP_ROWS;
  return (
    <div className="flex min-w-0 flex-col">
      <div className={cn("min-w-0", folds && !open && "max-md:[&_tbody>tr:nth-child(n+6)]:hidden")}>
        {children}
      </div>
      {folds ? (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          className="label flex min-h-11 w-full items-center justify-between gap-3 border-b border-line text-left text-muted transition-colors hover:text-fg md:hidden"
        >
          {open ? "Visa färre" : `Visa alla ${total} ${noun}`}
          <Icon
            name="chevronDown"
            size={12}
            className={cn(
              "shrink-0 text-subtle transition-transform duration-200 motion-reduce:transition-none",
              open && "rotate-180",
            )}
          />
        </button>
      ) : null}
    </div>
  );
}

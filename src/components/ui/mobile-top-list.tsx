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

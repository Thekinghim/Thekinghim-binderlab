"use client";

import { useId, useState, type ReactNode } from "react";

import { cn } from "@/lib/cn";

import { Icon } from "./icon";

/**
 * Fäller ihop innehåll på mobilen (under md) bakom en rad på 44 px, t.ex. "Fler siffror · 5".
 * Från md står innehållet alltid öppet och raden syns inte, så att skärmar från md ser ut
 * som förut. Innehållet renderas en gång (räkneanimationer och mätningar körs som vanligt)
 * och tonar in när raden öppnas.
 */
export function MobileFold({
  summary,
  meta,
  children,
  className,
  defaultOpen = false,
}: {
  /** Radens text, t.ex. "Fler siffror". */
  summary: ReactNode;
  /** Grått efter texten, t.ex. antalet. */
  meta?: ReactNode;
  children: ReactNode;
  className?: string;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();
  return (
    <div className={cn("min-w-0", className)}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "label flex min-h-11 w-full items-center gap-2 border-t border-line text-left text-muted transition-colors hover:text-fg md:hidden",
          !open && "border-b",
        )}
      >
        {/* Radbryts hellre än att kapas: talen i meta ska gå att läsa. */}
        <span className="min-w-0 py-2 text-balance">
          {summary}
          {meta !== undefined && meta !== null ? (
            <span className="text-subtle">
              {" · "}
              {meta}
            </span>
          ) : null}
        </span>
        <Icon
          name="chevronDown"
          size={12}
          className={cn(
            "ml-auto shrink-0 text-subtle transition-transform duration-200 motion-reduce:transition-none",
            open && "rotate-180",
          )}
        />
      </button>
      <div id={id} className={cn(open ? "max-md:mt-1 max-md:animate-enter" : "max-md:hidden")}>
        {children}
      </div>
    </div>
  );
}

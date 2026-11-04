"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";

import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/cn";

/**
 * Sekundära åtgärder bakom "⋯" på mobil (under md). Från md står barnen precis som
 * förut i förälderns layout (omslagen är display: contents och knappen är dold).
 * Menyn stängs vid klick utanför eller Esc, inte när en dialog i den är öppen.
 */
export function MobileMore({
  children,
  label = "Fler val",
  className,
  align = "right",
}: {
  children: ReactNode;
  /** Skärmläsarnamnet på knappen. */
  label?: string;
  /** Klasser för omslaget på mobil (skriv dem med max-md:). */
  className?: string;
  /** Menyns sida under knappen (left när knappen står till vänster). */
  align?: "left" | "right";
}) {
  const [open, setOpen] = useState(false);
  const [empty, setEmpty] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const id = useId();

  // Tom meny (allt i den renderade null): ingen knapp.
  useEffect(() => {
    const el = panelRef.current;
    if (!el) return;
    const check = () => setEmpty(el.childElementCount === 0);
    check();
    const mo = new MutationObserver(check);
    mo.observe(el, { childList: true });
    return () => mo.disconnect();
  }, []);

  useEffect(() => {
    if (!open) return;
    const dialogOpen = () => document.querySelector("dialog[open]") !== null;
    const onDown = (e: PointerEvent) => {
      if (dialogOpen()) return;
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !dialogOpen()) setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className={cn("relative md:contents", className)}>
      <button
        type="button"
        aria-label={label}
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "inline-flex size-11 items-center justify-center rounded-sm text-muted transition-colors hover:bg-hover hover:text-fg md:hidden",
          open && "bg-hover text-fg",
          empty && "hidden",
        )}
      >
        <Icon name="more" />
      </button>
      <div
        ref={panelRef}
        id={id}
        // Ett val stänger menyn, utom när det öppnade en dialog i menyn (då står den kvar
        // under dialogen, annars skulle dialogen döljas med den).
        onClick={(e) => {
          if (!(e.target as HTMLElement).closest("button, a")) return;
          window.setTimeout(() => {
            if (!ref.current?.querySelector("dialog[open]")) setOpen(false);
          }, 60);
        }}
        className={cn(
          "md:contents",
          open
            ? "max-md:shadow-lg max-md:absolute max-md:top-full max-md:z-40 max-md:mt-1 max-md:flex max-md:w-64 max-md:animate-enter max-md:flex-col max-md:items-stretch max-md:gap-2 max-md:rounded-md max-md:border max-md:border-line-strong max-md:bg-surface max-md:p-2 max-md:[&>a]:min-h-11 max-md:[&>a]:w-full max-md:[&>a]:justify-start max-md:[&>button]:min-h-11 max-md:[&>button]:w-full max-md:[&>button]:justify-start"
            : "max-md:hidden",
          align === "right" ? "max-md:right-0" : "max-md:left-0",
        )}
      >
        {children}
      </div>
    </div>
  );
}

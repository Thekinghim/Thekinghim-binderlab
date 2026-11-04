"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";

import { cn } from "@/lib/cn";

import { Icon } from "./icon";

/**
 * Mindre viktiga knappar bakom "⋯" på mobilen (under md); från md står de som vanligt.
 *
 * Innehållet renderas en gång. Under md är det en liten meny som öppnas under knappen
 * (samma stil som underflikarnas "Mer"); från md är menyn bara en behållare med
 * `className` (ange klasserna med md:-prefix, t.ex. "md:flex md:gap-3"), så att skärmar
 * från md ser ut precis som utan menyn. Knappen döljs när menyn är tom (t.ex. roll utan AI).
 * Menyn stängs vid ett val, ett tryck utanför och Escape, men inte medan en dialog är öppen.
 */
export function MobileMore({
  children,
  label = "Fler val",
  className,
  buttonClassName,
  align = "right",
}: {
  children: ReactNode;
  /** Knappens namn för skärmläsare. */
  label?: string;
  /** Behållarens klasser från md (md:-prefix). */
  className?: string;
  /** Extra klasser på "⋯"-knappen (t.ex. placering). */
  buttonClassName?: string;
  /** Menyns sida under md. */
  align?: "left" | "right";
}) {
  const [open, setOpen] = useState(false);
  const [empty, setEmpty] = useState(false);
  const id = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

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
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
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
    <div ref={rootRef} className="relative max-md:shrink-0 md:contents">
      <button
        type="button"
        aria-label={label}
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "flex size-11 items-center justify-center rounded-sm text-muted transition-colors hover:bg-hover hover:text-fg md:hidden",
          open && "bg-hover text-fg",
          empty && "hidden",
          buttonClassName,
        )}
      >
        <Icon name="more" />
      </button>
      <div
        ref={panelRef}
        id={id}
        // Ett val i menyn stänger den (efter att knappen gjort sitt), utom när valet öppnade
        // en dialog i menyn: den skulle annars döljas med menyn.
        onClick={(e) => {
          if (!(e.target as HTMLElement).closest("button, a")) return;
          window.setTimeout(() => {
            if (!panelRef.current?.querySelector("dialog[open]")) setOpen(false);
          }, 60);
        }}
        className={cn(
          "max-md:shadow-lg max-md:absolute max-md:top-full max-md:z-40 max-md:mt-1 max-md:flex max-md:w-max max-md:max-w-[calc(100vw-2rem)] max-md:min-w-56 max-md:flex-col max-md:gap-1 max-md:rounded-md max-md:border max-md:border-line-strong max-md:bg-surface max-md:p-1",
          align === "right" ? "max-md:right-0" : "max-md:left-0",
          open ? "max-md:animate-enter" : "max-md:hidden",
          className,
        )}
      >
        {children}
      </div>
    </div>
  );
}

/**
 * Klasser för en knapp eller länk som står i MobileMore: under md en hel rad på 44 px med
 * vänsterställd text; från md oförändrad.
 */
export const MOBILE_MENU_ITEM =
  "max-md:h-11 max-md:w-full max-md:justify-start max-md:self-stretch max-md:rounded-sm max-md:border-0 max-md:px-3 max-md:text-left max-md:hover:bg-hover";

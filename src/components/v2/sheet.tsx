"use client";

import type { ReactNode } from "react";
import { Drawer } from "vaul";

import { usePhone } from "./use-media";

/**
 * Ark i V2 (vaul): låda från höger på dator, ark nerifrån på telefon som följer fingret 1:1 och
 * stängs genom att dras ner. Escape och tryck utanför stänger. Fält i fokus rullas fram
 * (repositionInputs). Används för Registrera betalning, Markera som betald, Räkna lagret m.m.
 *
 * Kontrollerat (`open` + `onOpenChange`) eller med `trigger` (en knapp som öppnar).
 */
export function Sheet({
  open,
  onOpenChange,
  trigger,
  title,
  description,
  children,
  footer,
  dismissible = true,
  hideHead = false,
}: {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Elementet som öppnar arket (renderas med asChild: en <button> eller <Button>). */
  trigger?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  /** Knapparna längst ner (t.ex. Avbryt + Spara). */
  footer?: ReactNode;
  /** false: arket kan bara stängas med knapparna (pågående sparning). */
  dismissible?: boolean;
  /** Rubriken bara för skärmläsare: innehållet börjar med samma namn (t.ex. butikens kort). */
  hideHead?: boolean;
}) {
  const phone = usePhone();
  return (
    <Drawer.Root
      open={open}
      onOpenChange={onOpenChange}
      direction={phone ? "bottom" : "right"}
      dismissible={dismissible}
      repositionInputs
    >
      {trigger ? <Drawer.Trigger asChild>{trigger}</Drawer.Trigger> : null}
      <Drawer.Portal>
        <Drawer.Overlay className="v2-scrim" />
        <Drawer.Content
          className="v2-sheet"
          // Utan beskrivning: säg det uttryckligen (annars varnar Radix).
          {...(description ? {} : { "aria-describedby": undefined })}
        >
          {phone ? <span className="grab" aria-hidden="true" /> : null}
          <div className={hideHead ? "sr-only" : "sh"}>
            <Drawer.Title asChild>
              <h2>{title}</h2>
            </Drawer.Title>
            {description ? (
              <Drawer.Description asChild>
                <p>{description}</p>
              </Drawer.Description>
            ) : null}
            {!phone ? (
              <Drawer.Close className="x" aria-label="Stäng">
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  aria-hidden="true"
                >
                  <path d="M6 6l12 12M18 6 6 18" />
                </svg>
              </Drawer.Close>
            ) : null}
          </div>
          {children ? <div className="sb">{children}</div> : null}
          {footer ? <div className="ft">{footer}</div> : null}
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  );
}

/** Knapp som stänger arket (Avbryt). */
export const SheetClose = Drawer.Close;

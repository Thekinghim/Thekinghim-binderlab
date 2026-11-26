"use client";

import type { ReactNode } from "react";
import { Drawer } from "vaul";

/**
 * Periodvalets ark nerifrån på telefonen (vaul). Egen fil: PeriodSegment laddar den först när
 * Datum trycks första gången på en telefon, så att vaul inte ligger i varje sidas start.
 */
export function PeriodSheet({
  open,
  onOpenChange,
  onCloseAutoFocus,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Fokus tillbaka till datumknappen (arket har ingen Drawer.Trigger). */
  onCloseAutoFocus: () => void;
  children: ReactNode;
}) {
  return (
    <Drawer.Root open={open} onOpenChange={onOpenChange} direction="bottom" repositionInputs>
      <Drawer.Portal>
        <Drawer.Overlay className="v2-scrim" />
        <Drawer.Content
          className="v2-sheet v2-psheet"
          aria-describedby={undefined}
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            onCloseAutoFocus();
          }}
        >
          <span className="grab" aria-hidden="true" />
          <div className="sh">
            <Drawer.Title asChild>
              <h2>Välj period</h2>
            </Drawer.Title>
          </div>
          {children}
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  );
}

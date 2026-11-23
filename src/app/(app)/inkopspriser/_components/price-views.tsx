"use client";

import "./price-shelf.css";

import type { ReactNode } from "react";
import { useState } from "react";

import { ViewToggle } from "../../vart-lager/_components/v2/view-toggle";
import { VIEW_COOKIE, type ShelfView } from "../../vart-lager/_lib/shelf";

/**
 * Per titel på Inköpspriser som Hylla eller Tabell (valet sparas i en kaka). Båda vyerna
 * renderas på servern; här väljs bara vilken som visas. `before` (Att göra-listan) visas med
 * tabellen: på hyllan står titlarna utan pris redan först.
 */
export function PriceViews({
  initial,
  heading,
  actions,
  shelf,
  table,
  before,
}: {
  initial: ShelfView;
  heading: ReactNode;
  actions?: ReactNode;
  shelf: ReactNode;
  table: ReactNode;
  before?: ReactNode;
}) {
  const [view, setView] = useState<ShelfView>(initial);
  return (
    <>
      {view === "tabell" ? before : null}
      <section aria-labelledby="per-titel" className="v2-card">
        <div className="v2-card-hd flex-wrap gap-y-2">
          {heading}
          <div className="flex items-center gap-2">
            {actions}
            <ViewToggle value={view} onChange={setView} cookie={VIEW_COOKIE.priser} />
          </div>
        </div>
        {view === "hylla" ? shelf : table}
      </section>
    </>
  );
}

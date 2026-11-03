/**
 * "Ny automat hittad – välj butik" överst på Att göra: automater som Awish hittat men som
 * inte är kopplade (src/server/machines/new-machines.ts). Bara ägare och admin; tom annars.
 */

import { day } from "@/analytics/todos/text";
import { formatInt, NBSP } from "@/lib/format";
import type { Viewer } from "@/server/data/core/loaders";
import { loadNewMachinesFor } from "@/server/machines/new-machines";

import { NewMachineCards, type NewMachineCard } from "./new-machine-cards";

export async function NewMachinesFound({ viewer }: { viewer: Viewer }) {
  const state = await loadNewMachinesFor(viewer).catch((error: unknown) => {
    console.error("[att-gora] Nya automater kunde inte läsas:", error);
    return null;
  });
  if (!state || state.machines.length === 0) return null;
  const cards: NewMachineCard[] = state.machines.map((m) => ({
    id: m.id,
    title: m.name,
    code: m.suggestedCode,
    detail:
      m.orders > 0 && m.firstOrderDate
        ? `${formatInt(m.orders)}${NBSP}köp sedan ${day(m.firstOrderDate)}.`
        : "Inga köp än.",
  }));
  return <NewMachineCards cards={cards} stores={state.stores} />;
}

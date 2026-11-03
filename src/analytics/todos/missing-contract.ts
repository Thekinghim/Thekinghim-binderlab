/**
 * Butik med automat utan signerat kontrakt: en punkt per butik i Att göra
 * ("Sega gubben saknar kontrakt" → Skapa kontrakt). Samma regel som Kontrakt och Butiker
 * (@/analytics/contracts/signed). Automaten säljer och räknas ändå; punkten blockerar inget.
 *
 *   med        = butiken har en automat placerad i dag (inte arkiverad); kontrakten måste
 *                finnas i indata (`contracts`), annars inga punkter
 *   punkt      = med och läget är "saknas" eller "osignerat"
 *   nivå       = 'soon'
 *   nyckel     = 'contract-missing:<butik>', fingerprint = läget
 */

import { storeContractState } from "@/analytics/contracts/signed";

import { evidence } from "./common";
import { urgencyOf, type TodoContext } from "./context";
import type { TodoItem } from "./types";

/** Länk till Skapa kontrakt med butiken förvald. */
export function createContractLink(storeId: string): string {
  return `/avtal?skapa=${encodeURIComponent(`store:${storeId}`)}`;
}

/** Länk till butikens rad på Kontrakt. */
export function storeContractLink(storeId: string): string {
  return `/avtal#butik-${encodeURIComponent(storeId)}`;
}

export function missingContractTodos(ctx: TodoContext): TodoItem[] {
  const stores = ctx.input.stores ?? [];
  // Utan kontrakt i indata (inte laddade, t.ex. för påfyllaren) blir det inga punkter.
  const contracts = ctx.input.contracts;
  if (stores.length === 0 || contracts === undefined) return [];
  const today = ctx.today;
  const archived = new Set(ctx.input.machines.filter((m) => m.archived).map((m) => m.id));
  const code = new Map(ctx.input.machines.map((m) => [m.id, m.code ?? m.name]));
  const placed = new Map<string, string[]>();
  for (const p of ctx.input.placements) {
    if (archived.has(p.machineId)) continue;
    if (p.from > today || (p.to !== null && p.to < today)) continue;
    placed.set(p.storeId, [...(placed.get(p.storeId) ?? []), p.machineId]);
  }
  const out: TodoItem[] = [];
  for (const store of stores) {
    const machines = placed.get(store.id);
    if (!machines || machines.length === 0) continue;
    const state = storeContractState(contracts, store.id, today);
    if (state === "signed") continue;
    const missing = state === "missing";
    const codes = [...new Set(machines.map((id) => code.get(id) ?? id))].sort().join(", ");
    out.push({
      key: `contract-missing:${store.id}`,
      fingerprint: state,
      kind: "contract",
      level: "soon",
      urgency: urgencyOf("soon", null),
      atStakeOre: null,
      daysLeft: null,
      title: missing
        ? `${store.name} saknar kontrakt`
        : `${store.name}: kontraktet är inte signerat`,
      detail: `${codes} står där.`,
      evidence: evidence({
        rule: "Varje butik med automat ska ha ett signerat kontrakt.",
        storeIds: [store.id],
        machineIds: machines,
      }),
      link: missing ? createContractLink(store.id) : storeContractLink(store.id),
      action: {
        kind: "open-contract",
        label: missing ? "Skapa kontrakt" : "Signera",
        params: { storeId: store.id },
      },
    });
  }
  return out;
}

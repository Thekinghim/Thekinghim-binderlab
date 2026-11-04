/**
 * Avräkningen räknad NU: samma laddare och rapportberäkning som månadsrapporten (typ butik),
 * en laddning av underlaget per månad för alla butiker. Används av Butiksportal, Hem/Att
 * göra, dokumentet och "markera som betald", så att en obetald avräkning alltid visar det
 * belopp som gäller med dagens inköpspriser, testköp och avtal. Egen fil utan beroende på
 * laddarna (src/server/data/core/loaders.ts använder den).
 */

import "server-only";

import type { Tx } from "@/db/client";
import { DomainError, type IsoMonth } from "@/domain";
import { buildSnapshot } from "@/server/reports/snapshot";
import { loadSnapshotInput, settlementOrderWindow } from "@/server/reports/sources";

import { parseStatement, statementFromReport, type SettlementStatement } from "./model";

export interface ComputedSettlement {
  readonly amountOre: number;
  readonly statement: SettlementStatement;
  readonly calcVersion: string;
}

/** Avräkningen för en butik räknad nu, eller varför den inte går att räkna (t.ex. saknat inköpspris). */
export type LiveSettlement =
  | { readonly ok: true; readonly computed: ComputedSettlement }
  | { readonly ok: false; readonly message: string };

/**
 * Räknar månadens avräkning för flera butiker med EN laddning av underlaget (samma laddare
 * och rapportberäkning som månadsrapporten, typ butik). Ett fel i en butik (DomainError,
 * t.ex. order utan inköpspris under vinstdelning) blir `ok: false` för just den butiken.
 */
export async function computeSettlementsTx(
  tx: Tx,
  input: {
    organizationId: string;
    month: IsoMonth;
    storeIds: readonly string[];
    now: Date;
  },
): Promise<Map<string, LiveSettlement>> {
  const out = new Map<string, LiveSettlement>();
  if (input.storeIds.length === 0) return out;
  const base = await loadSnapshotInput(tx, {
    organizationId: input.organizationId,
    type: "butik",
    month: input.month,
    storeId: null,
    now: input.now.toISOString(),
    orderWindow: settlementOrderWindow(input.month),
  });
  for (const storeId of input.storeIds) {
    try {
      const snapshot = buildSnapshot({ ...base, storeId });
      if (snapshot.type !== "butik") throw new Error("Fel rapporttyp för avräkningen.");
      const statement = statementFromReport(snapshot.report);
      out.set(storeId, {
        ok: true,
        computed: { amountOre: statement.totalOre, statement, calcVersion: snapshot.calcVersion },
      });
    } catch (error) {
      if (!(error instanceof DomainError)) throw error;
      out.set(storeId, { ok: false, message: error.message });
    }
  }
  return out;
}

/** Samma belopp och uträkning (det som sparas på en obetald avräkning). */
export function sameComputed(
  stored: { amountOre: number; statement: unknown },
  c: ComputedSettlement,
): boolean {
  return (
    stored.amountOre === c.amountOre &&
    JSON.stringify(parseStatement(stored.statement)) === JSON.stringify(c.statement)
  );
}

/** Avräkningarna räknade nu, per avräknings-id (en laddning per månad). */
export async function liveFor(
  tx: Tx,
  orgId: string,
  rows: readonly { id: string; storeId: string; month: string }[],
  now: Date,
): Promise<Map<string, LiveSettlement>> {
  const byMonth = new Map<IsoMonth, { id: string; storeId: string }[]>();
  for (const r of rows) {
    const m = r.month.slice(0, 7) as IsoMonth;
    const list = byMonth.get(m);
    if (list) list.push(r);
    else byMonth.set(m, [r]);
  }
  const out = new Map<string, LiveSettlement>();
  for (const [month, list] of byMonth) {
    const live = await computeSettlementsTx(tx, {
      organizationId: orgId,
      month,
      storeIds: [...new Set(list.map((x) => x.storeId))],
      now,
    });
    for (const r of list) out.set(r.id, live.get(r.storeId)!);
  }
  return out;
}

/**
 * Avräkningen räknad NU: samma laddare och rapportberäkning som månadsrapporten (typ butik),
 * en laddning av underlaget per månad för alla butiker. Används av Butiksportal, Hem/Att
 * göra, dokumentet och "markera som betald", så att en obetald avräkning alltid visar det
 * belopp som gäller med dagens inköpspriser, testköp och avtal. Egen fil utan beroende på
 * laddarna (src/server/data/core/loaders.ts använder den).
 */

import "server-only";

import type { Tx } from "@/db/client";
import { DomainError, type DomainErrorCode, type IsoMonth, type Period } from "@/domain";
import { buildSnapshot } from "@/server/reports/snapshot";
import { loadSnapshotInput, settlementOrderWindow } from "@/server/reports/sources";

import { sql } from "drizzle-orm";

import {
  correctionsTotal,
  parseCorrections,
  parseStatement,
  statementFromReport,
  withCorrections,
  type SettlementCorrection,
  type SettlementStatement,
} from "./model";

export interface ComputedSettlement {
  /** Beloppet, med rättelserna som ligger på avräkningen. */
  readonly amountOre: number;
  readonly statement: SettlementStatement;
  readonly calcVersion: string;
  /** Summan av rättelserna i beloppet (0 utan). Butikens andel för månaden = amountOre − den. */
  readonly correctionsOre: number;
}

/** Avräkningen för en butik räknad nu, eller varför den inte går att räkna (t.ex. saknat inköpspris). */
export type LiveSettlement =
  | { readonly ok: true; readonly computed: ComputedSettlement }
  | {
      readonly ok: false;
      readonly message: string;
      /** Varför (DomainError.code), t.ex. "missing_price" för order utan inköpspris. */
      readonly code: DomainErrorCode;
    };

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
    /**
     * Bara de här dagarna i månaden (en betalning för en egen period, ./advance.ts). Samma
     * uträkning som butiksrapporten för ett eget datum. Utelämnad = hela månaden.
     */
    period?: Period;
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
    ...(input.period ? { period: input.period } : {}),
  });
  for (const storeId of input.storeIds) {
    try {
      const snapshot = buildSnapshot({ ...base, storeId });
      if (snapshot.type !== "butik") throw new Error("Fel rapporttyp för avräkningen.");
      const statement = statementFromReport(snapshot.report);
      out.set(storeId, {
        ok: true,
        computed: {
          amountOre: statement.totalOre,
          statement,
          calcVersion: snapshot.calcVersion,
          correctionsOre: 0,
        },
      });
    } catch (error) {
      if (!(error instanceof DomainError)) throw error;
      out.set(storeId, { ok: false, message: error.message, code: error.code });
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

/** Rättelserna som ligger på avräkningarna, per avräknings-id. */
async function correctionsFor(
  tx: Tx,
  orgId: string,
  ids: readonly string[],
): Promise<Map<string, SettlementCorrection[]>> {
  const out = new Map<string, SettlementCorrection[]>();
  if (ids.length === 0) return out;
  const rows = Array.from(
    await tx.execute(sql`
      select id, corrections from public.store_settlements
      where organization_id = ${orgId}::uuid
        and id in (${sql.join(
          ids.map((id) => sql`${id}::uuid`),
          sql`, `,
        )})
        and corrections <> '[]'::jsonb`),
  ) as { id: string; corrections: unknown }[];
  for (const r of rows) out.set(String(r.id), parseCorrections(r.corrections));
  return out;
}

/** Uträkningen med avräkningens rättelser (egna rader, ingår i beloppet). */
export function applyCorrections(
  computed: ComputedSettlement,
  corrections: readonly SettlementCorrection[],
): ComputedSettlement {
  if (corrections.length === 0) return computed;
  const statement = withCorrections(computed.statement, corrections);
  return {
    ...computed,
    statement,
    amountOre: statement.totalOre,
    correctionsOre: correctionsTotal(corrections),
  };
}

/**
 * Avräkningarna räknade nu, per avräknings-id (en laddning per månad). Rättelser som
 * ligger på en avräkning ingår som egna rader och i beloppet.
 */
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
  const corrections = await correctionsFor(
    tx,
    orgId,
    rows.map((r) => r.id),
  );
  const out = new Map<string, LiveSettlement>();
  for (const [month, list] of byMonth) {
    const live = await computeSettlementsTx(tx, {
      organizationId: orgId,
      month,
      storeIds: [...new Set(list.map((x) => x.storeId))],
      now,
    });
    for (const r of list) {
      const l = live.get(r.storeId)!;
      const own = corrections.get(r.id);
      out.set(r.id, l.ok && own ? { ok: true, computed: applyCorrections(l.computed, own) } : l);
    }
  }
  return out;
}

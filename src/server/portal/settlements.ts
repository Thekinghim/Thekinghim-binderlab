/**
 * Butiksportalen: butikens månadsavräkningar och avtal. Bara portal_*-funktionerna i
 * databasen (security definer, rollen store för just den butiken), som användaren med RLS.
 *
 * Avtalsfilen läses med systemnyckeln (bucketen 'contracts' har ingen policy för
 * butiksrollen), men bara på sökvägen som portal_contract_file gav för butikens eget avtal.
 */

import "server-only";

import { sql } from "drizzle-orm";

import type { Tx } from "@/db/client";
import type { IsoDate, IsoMonth } from "@/domain";
import { isValidStoragePath } from "@/import/file-store";
import { systemContractStore } from "@/server/contracts/signing";
import type { AdvancePart } from "@/server/settlements/advance";
import {
  parseStatement,
  settlementFileName,
  settlementHtml,
  settlementState,
  type SettlementState,
  type SettlementStatement,
} from "@/server/settlements/model";

import { withUserDbFor } from "../access";
import { pgErrorOf } from "../errors";

import type { PortalContext } from "./session";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Row = Record<string, unknown>;
const str = (v: unknown): string => (v === null || v === undefined ? "" : String(v));
const strOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const iso = (v: unknown): string | null =>
  v === null || v === undefined ? null : v instanceof Date ? v.toISOString() : String(v);
const dateOf = (v: unknown): string | null =>
  v === null || v === undefined
    ? null
    : v instanceof Date
      ? v.toISOString().slice(0, 10)
      : String(v).slice(0, 10);

export interface PortalSettlement {
  readonly id: string;
  readonly month: IsoMonth;
  readonly amountOre: number;
  readonly state: SettlementState;
  readonly paidOn: IsoDate | null;
  readonly computedAt: string;
  readonly statement: SettlementStatement | null;
}

/** Butikens avräkningar, senaste först. */
export async function queryPortalSettlements(tx: Tx, storeId: string): Promise<PortalSettlement[]> {
  const rows = Array.from(
    await tx.execute(
      sql`select settlement_id, month::text as month, amount_ore, paid_on::text as paid_on,
                 computed_at, statement
          from public.portal_settlements(${storeId}::uuid)`,
    ),
  ) as Row[];
  return rows.map((r) => {
    const amountOre = Number(r.amount_ore);
    const paidOn = dateOf(r.paid_on) as IsoDate | null;
    return {
      id: str(r.settlement_id),
      month: str(r.month).slice(0, 7) as IsoMonth,
      amountOre,
      state: settlementState(amountOre, paidOn),
      paidOn,
      computedAt: iso(r.computed_at) ?? "",
      statement: parseStatement(r.statement),
    };
  });
}

export interface PortalContract {
  readonly id: string;
  readonly title: string | null;
  readonly validFrom: IsoDate;
  readonly validTo: IsoDate | null;
  readonly terminatedOn: IsoDate | null;
  readonly signedAt: string | null;
  readonly signerName: string | null;
  readonly hasFile: boolean;
  /**
   * Signerat med samma regel som ägarens Kontrakt (isSigned): signerat, eller registrerat
   * för hand (ett befintligt papperskontrakt). Räknas i portal_contracts.
   */
  readonly signed: boolean;
}

/** Butikens avtal, senaste först. */
export async function queryPortalContracts(tx: Tx, storeId: string): Promise<PortalContract[]> {
  const rows = Array.from(
    await tx.execute(
      sql`select contract_id, title, valid_from::text as valid_from, valid_to::text as valid_to,
                 terminated_on::text as terminated_on, signed_at, signer_name, has_file, signed
          from public.portal_contracts(${storeId}::uuid)`,
    ),
  ) as Row[];
  return rows.map((r) => ({
    id: str(r.contract_id),
    title: strOrNull(r.title),
    validFrom: str(r.valid_from) as IsoDate,
    validTo: strOrNull(r.valid_to) as IsoDate | null,
    terminatedOn: strOrNull(r.terminated_on) as IsoDate | null,
    signedAt: iso(r.signed_at),
    signerName: strOrNull(r.signer_name),
    hasFile: r.has_file === true,
    signed: r.signed === true,
  }));
}

/** Sökvägen till ett av butikens avtal. Kastar P0002 om det inte finns hos butiken. */
export async function queryPortalContractFile(
  tx: Tx,
  storeId: string,
  contractId: string,
): Promise<{ storagePath: string; contentType: string; signed: boolean }> {
  const rows = Array.from(
    await tx.execute(
      sql`select storage_path, content_type, signed
          from public.portal_contract_file(${storeId}::uuid, ${contractId}::uuid)`,
    ),
  ) as Row[];
  const r = rows[0]!;
  return {
    storagePath: str(r.storage_path),
    contentType: str(r.content_type),
    signed: r.signed === true,
  };
}

export interface PortalMoneyData {
  readonly settlements: PortalSettlement[];
  readonly contracts: PortalContract[];
  /** Betalningar för egna perioder (dras av på obetalda avräkningar). */
  readonly advances: AdvancePart[];
}

export async function loadPortalMoney(ctx: PortalContext): Promise<PortalMoneyData> {
  return withUserDbFor(ctx.user, async (tx) => ({
    settlements: await queryPortalSettlements(tx, ctx.store.storeId),
    contracts: await queryPortalContracts(tx, ctx.store.storeId),
    advances: await queryPortalAdvances(tx, ctx.store.storeId),
  }));
}

/**
 * Betalningar till butiken för egna perioder, per del och månad (portal_store_payments: bara
 * den egna butiken, utan ägarens anteckning). På en obetald avräkning dras de av.
 */
export async function queryPortalAdvances(tx: Tx, storeId: string): Promise<AdvancePart[]> {
  const rows = Array.from(
    await tx.execute(
      sql`select payment_id, paid_on::text as paid_on, to_char(month, 'YYYY-MM') as month,
                 part_start::text as part_start, part_end::text as part_end, amount_ore
          from public.portal_store_payments(${storeId}::uuid)`,
    ),
  ) as Row[];
  return rows.map((r) => ({
    paymentId: str(r.payment_id),
    storeId,
    paidOn: str(r.paid_on).slice(0, 10) as IsoDate,
    month: str(r.month) as IsoMonth,
    start: str(r.part_start).slice(0, 10) as IsoDate,
    end: str(r.part_end).slice(0, 10) as IsoDate,
    amountOre: Number(r.amount_ore),
  }));
}

/** En avräkning som dokument, eller null om den inte finns hos butiken. */
export async function loadPortalSettlementDocument(
  ctx: PortalContext,
  settlementId: string,
): Promise<{ html: string; fileName: string } | null> {
  if (!UUID.test(settlementId)) return null;
  const { list, advances } = await withUserDbFor(ctx.user, async (tx) => ({
    list: await queryPortalSettlements(tx, ctx.store.storeId),
    advances: await queryPortalAdvances(tx, ctx.store.storeId),
  }));
  const hit = list.find((x) => x.id === settlementId.toLowerCase());
  if (!hit || !hit.statement) return null;
  return {
    html: settlementHtml({
      organizationName: ctx.store.organizationName,
      statement: hit.statement,
      amountOre: hit.amountOre,
      paidOn: hit.paidOn,
      reference: hit.id.slice(0, 8),
      // Förskott för månaden: dras av på en obetald (samma som på sidan Pengar).
      advances: advances.filter((a) => a.month === hit.month),
    }),
    fileName: settlementFileName(hit.statement.storeName, hit.month),
  };
}

/** Avtalsfilen (den signerade PDF:en om den finns), eller null om den inte finns hos butiken. */
export async function loadPortalContractFile(
  ctx: PortalContext,
  contractId: string,
): Promise<{ bytes: Uint8Array; contentType: string; fileName: string } | null> {
  if (!UUID.test(contractId)) return null;
  let file: { storagePath: string; contentType: string; signed: boolean };
  try {
    file = await withUserDbFor(ctx.user, (tx) =>
      queryPortalContractFile(tx, ctx.store.storeId, contractId),
    );
  } catch (error) {
    if (pgErrorOf(error)?.code === "P0002") return null;
    throw error;
  }
  if (!isValidStoragePath(file.storagePath)) return null;
  let bytes: Uint8Array;
  try {
    bytes = await systemContractStore().get(file.storagePath);
  } catch {
    return null;
  }
  const ext = file.contentType === "application/pdf" ? "pdf" : "fil";
  return {
    bytes,
    contentType: file.contentType,
    fileName: `${file.signed ? "avtal-signerat" : "avtal"}-${contractId.slice(0, 8)}.${ext}`,
  };
}

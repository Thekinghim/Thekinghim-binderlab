"use server";

/**
 * Server actions för Pengar → Utbetalningar. Tunna omslag: rollen kontrolleras här
 * (ägare och admin) och igen i tjänsten mot databasen (src/server/payouts), allt körs
 * under RLS. Fel visas som de är (svensk text).
 */

import { unstable_rethrow } from "next/navigation";
import { z } from "zod";

import { AuthorizationError } from "@/server/access";
import {
  OPERATOR_ROLES,
  requireContextRole,
  requireViewer,
  revalidateSettlementData,
} from "@/server/data/core";
import { dbErrorMessage, safeErrorForLog } from "@/server/errors";
import { markPaidFor, undoPaidFor } from "@/server/payouts/pay";
import {
  applyMappingFor,
  confirmDraftFor,
  discardDraftFor,
  expectedForPeriodFor,
  PayoutError,
  registerPayoutFor,
  removePartnerAgreementFor,
  savePartnerAgreementFor,
  savePayoutOptionsFor,
  uploadPayoutFileFor,
  type RegisterPayoutResult,
  type UploadResult,
} from "@/server/payouts/service";

export type PayoutActionResult<T = undefined> =
  { ok: true; data: T } | { ok: false; error: string };

function failure(error: unknown): { ok: false; error: string } {
  unstable_rethrow(error);
  if (error instanceof z.ZodError) {
    return { ok: false, error: error.issues[0]?.message ?? "Ogiltiga uppgifter." };
  }
  if (error instanceof AuthorizationError) {
    return { ok: false, error: "Bara ägare och admin kan ändra utbetalningarna." };
  }
  if (error instanceof PayoutError) return { ok: false, error: error.message };
  console.error("[utbetalningar]", safeErrorForLog(error));
  return { ok: false, error: dbErrorMessage(error) };
}

async function operator() {
  await requireContextRole(OPERATOR_ROLES);
  return requireViewer();
}

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Välj ett datum.");
const ore = z.number().int("Ogiltigt belopp.").safe("Ogiltigt belopp.");
const period = z.object({ start: date, end: date }).nullable().optional();

export async function registerPayout(
  raw: unknown,
): Promise<PayoutActionResult<RegisterPayoutResult>> {
  try {
    const viewer = await operator();
    const input = z
      .object({
        paidOn: date,
        amountOre: ore,
        feesOre: ore.nullable().optional(),
        period,
        note: z.string().max(2000).nullable().optional(),
      })
      .parse(raw);
    const data = await registerPayoutFor(viewer, input);
    await revalidateSettlementData();
    return { ok: true, data };
  } catch (error) {
    return failure(error);
  }
}

export async function uploadPayoutReport(
  form: FormData,
): Promise<PayoutActionResult<UploadResult>> {
  try {
    const viewer = await operator();
    const file = form.get("file");
    if (!(file instanceof File) || file.size === 0) {
      return { ok: false, error: "Välj rapporten (fil eller foto)." };
    }
    if (file.size > 10 * 1024 * 1024)
      return { ok: false, error: "Filen är för stor (högst 10 MB)." };
    const bytes = new Uint8Array(await file.arrayBuffer());
    const data = await uploadPayoutFileFor(viewer, { name: file.name, type: file.type, bytes });
    if (data.kind === "imported") await revalidateSettlementData();
    return { ok: true, data };
  } catch (error) {
    return failure(error);
  }
}

export async function applyColumnMapping(
  draftId: unknown,
  mapping: unknown,
  remember: unknown,
): Promise<PayoutActionResult<UploadResult>> {
  try {
    const viewer = await operator();
    const id = z.uuid().parse(draftId);
    return { ok: true, data: await applyMappingFor(viewer, id, mapping, remember === true) };
  } catch (error) {
    return failure(error);
  }
}

export async function confirmDraft(
  draftId: unknown,
  raw: unknown,
): Promise<PayoutActionResult<RegisterPayoutResult>> {
  try {
    const viewer = await operator();
    const id = z.uuid().parse(draftId);
    const edits = z
      .object({
        paidOn: date,
        amountOre: ore,
        feesOre: ore.nullable().optional(),
        period,
        note: z.string().max(2000).nullable().optional(),
      })
      .parse(raw);
    const data = await confirmDraftFor(viewer, id, edits);
    await revalidateSettlementData();
    return { ok: true, data };
  } catch (error) {
    return failure(error);
  }
}

export async function discardDraft(draftId: unknown): Promise<PayoutActionResult> {
  try {
    const viewer = await operator();
    await discardDraftFor(viewer, z.uuid().parse(draftId));
    return { ok: true, data: undefined };
  } catch (error) {
    return failure(error);
  }
}

export async function expectedForPeriod(
  raw: unknown,
): Promise<
  PayoutActionResult<{ grossOre: number; feeOre: number; netOre: number; orders: number }>
> {
  try {
    const viewer = await operator();
    const p = z.object({ start: date, end: date }).parse(raw);
    return { ok: true, data: await expectedForPeriodFor(viewer, p) };
  } catch (error) {
    return failure(error);
  }
}

export async function markPaid(
  raw: unknown,
): Promise<PayoutActionResult<{ paidOre: number; refs: string[] }>> {
  try {
    const viewer = await operator();
    const input = z
      .object({
        lineIds: z.array(z.uuid()).min(1).max(500),
        paidOn: date,
        amountOre: ore.nullable().optional(),
      })
      .parse(raw);
    const r = await markPaidFor(viewer, input);
    await revalidateSettlementData();
    return { ok: true, data: { paidOre: r.paidOre, refs: [...r.refs] } };
  } catch (error) {
    return failure(error);
  }
}

export async function undoPaid(refs: unknown): Promise<PayoutActionResult> {
  try {
    const viewer = await operator();
    const list = z
      .array(z.string().regex(/^[sr]:[0-9a-f-]{36}$/i))
      .min(1)
      .max(500)
      .parse(refs);
    await undoPaidFor(viewer, list);
    await revalidateSettlementData();
    return { ok: true, data: undefined };
  } catch (error) {
    return failure(error);
  }
}

export async function savePartnerAgreement(raw: unknown): Promise<PayoutActionResult> {
  try {
    const viewer = await operator();
    const input = z
      .object({
        partnerName: z.string().trim().min(1, "Skriv partnerns namn.").max(200),
        reimburseCost: z.boolean(),
        profitSharePercent: z.number().min(0).max(100),
        validFrom: date,
      })
      .parse(raw);
    await savePartnerAgreementFor(viewer, input);
    await revalidateSettlementData();
    return { ok: true, data: undefined };
  } catch (error) {
    return failure(error);
  }
}

export async function removePartnerAgreement(id: unknown): Promise<PayoutActionResult> {
  try {
    const viewer = await operator();
    await removePartnerAgreementFor(viewer, z.uuid().parse(id));
    await revalidateSettlementData();
    return { ok: true, data: undefined };
  } catch (error) {
    return failure(error);
  }
}

export async function savePayoutOptions(raw: unknown): Promise<PayoutActionResult> {
  try {
    const viewer = await operator();
    const input = z
      .object({
        vatReserveMode: z.enum(["auto", "vmb", "standard", "none"]),
        reminderDays: z.number().int().min(0).max(90),
      })
      .parse(raw);
    await savePayoutOptionsFor(viewer, input);
    await revalidateSettlementData();
    return { ok: true, data: undefined };
  } catch (error) {
    return failure(error);
  }
}

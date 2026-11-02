"use server";

/**
 * Server actions för Avtal: skapa och ändra avtal (med villkor), arkivera, och bifoga
 * avtalsfilen. Indata valideras med zod, rollen kontrolleras här (requireContextRole) och i
 * tjänsten mot databasen, allt skrivs som användaren med RLS.
 */

import { unstable_rethrow } from "next/navigation";
import { z, ZodError } from "zod";

import { DomainError } from "@/domain";
import { parseAmountOre } from "@/import/amount";
import {
  AccountingError,
  archiveContractFor,
  attachContractFileFor,
  contractFileStore,
  currentViewer,
  MAX_CONTRACT_FILE_BYTES,
  saveContractFor,
} from "@/server/accounting";
import { AuthorizationError } from "@/server/access";
import { OPERATOR_ROLES, requireContextRole, revalidateAppData } from "@/server/data/core";
import { dbErrorMessage, pgErrorOf } from "@/server/errors";

export type ActionResult<T = undefined> = { ok: true; data: T } | { ok: false; error: string };

function failure(error: unknown): { ok: false; error: string } {
  unstable_rethrow(error);
  if (error instanceof ZodError) {
    return { ok: false, error: error.issues[0]?.message ?? "Ogiltiga uppgifter." };
  }
  if (
    error instanceof AccountingError ||
    error instanceof AuthorizationError ||
    error instanceof DomainError
  ) {
    return { ok: false, error: error.message };
  }
  if (pgErrorOf(error)?.code === "23P01") {
    return {
      ok: false,
      error:
        "Butiken har redan villkor för en del av perioden. Koppla de befintliga villkoren i stället.",
    };
  }
  console.error("[avtal]", error);
  return { ok: false, error: dbErrorMessage(error) };
}

async function operator() {
  await requireContextRole(OPERATOR_ROLES);
  return currentViewer();
}

const ISO_DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const date = z.string().regex(ISO_DATE, "Ange datum som ÅÅÅÅ-MM-DD.");
const optionalDate = z
  .string()
  .trim()
  .optional()
  .nullable()
  .transform((v) => (v ? v : null))
  .pipe(date.nullable());
const optionalCount = (max: number, label: string) =>
  z
    .union([z.string(), z.number()])
    .optional()
    .nullable()
    .transform((v, ctx) => {
      if (v === null || v === undefined || String(v).trim() === "") return null;
      const n = Number(String(v).trim());
      if (!Number.isInteger(n) || n < 0 || n > max) {
        ctx.addIssue({ code: "custom", message: `${label} måste vara ett heltal 0–${max}.` });
        return z.NEVER;
      }
      return n;
    });

const contractSchema = z
  .object({
    id: z.uuid().nullable().optional(),
    storeId: z.uuid("Välj en butik."),
    title: z.string().trim().max(200).nullable().optional(),
    validFrom: date,
    validTo: optionalDate,
    noticePeriodMonths: optionalCount(120, "Uppsägningstiden"),
    noticePeriodDays: optionalCount(3650, "Uppsägningstiden i dagar"),
    renewalMonths: optionalCount(120, "Förlängningen"),
    terminatedOn: optionalDate,
    terms: z
      .string()
      .trim()
      .max(4000, "Villkoren får vara högst 4 000 tecken.")
      .nullable()
      .optional(),
    note: z.string().trim().max(2000).nullable().optional(),
    agreementIds: z.array(z.uuid()).max(50).optional(),
    commissionPercent: z.string().trim().optional().nullable(),
    monthlyRent: z.string().trim().optional().nullable(),
  })
  .refine((v) => v.validTo === null || v.validTo >= v.validFrom, {
    message: "Avtalet kan inte sluta före det börjar.",
  })
  .refine((v) => v.renewalMonths !== 0, { message: "Förlängningen måste vara minst 1 månad." })
  .transform((v, ctx) => {
    let commissionBp: number | null = null;
    if (v.commissionPercent) {
      const m = /^(\d{1,3})(?:[.,](\d{1,2}))?$/.exec(v.commissionPercent.replace(/\s|%/g, ""));
      const bp = m ? Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0")) : NaN;
      if (!m || bp > 10_000) {
        ctx.addIssue({ code: "custom", message: "Provisionen anges i procent, 0–100." });
        return z.NEVER;
      }
      commissionBp = bp;
    }
    let monthlyRentOre: number | null = null;
    if (v.monthlyRent) {
      const parsed = parseAmountOre(v.monthlyRent);
      if (!parsed.ok) {
        ctx.addIssue({ code: "custom", message: `Hyran: ${parsed.message}` });
        return z.NEVER;
      }
      monthlyRentOre = parsed.ore;
    }
    return {
      id: v.id ?? null,
      storeId: v.storeId,
      title: v.title ?? null,
      validFrom: v.validFrom,
      validTo: v.validTo,
      noticePeriodMonths: v.noticePeriodMonths,
      noticePeriodDays: v.noticePeriodDays,
      renewalMonths: v.renewalMonths,
      terminatedOn: v.terminatedOn,
      terms: v.terms ?? null,
      note: v.note ?? null,
      agreementIds: v.agreementIds,
      newTerms:
        commissionBp !== null || monthlyRentOre !== null ? { commissionBp, monthlyRentOre } : null,
    };
  });

/** Skapar eller ändrar ett avtal. */
export async function saveContract(raw: unknown): Promise<ActionResult<{ id: string }>> {
  try {
    const viewer = await operator();
    const input = contractSchema.parse(raw);
    const data = await saveContractFor(viewer, input);
    revalidateAppData();
    return { ok: true, data };
  } catch (error) {
    return failure(error);
  }
}

/** Arkiverar eller återställer ett avtal. */
export async function archiveContract(raw: unknown): Promise<ActionResult> {
  try {
    const viewer = await operator();
    const input = z.object({ id: z.uuid(), archived: z.boolean() }).parse(raw);
    await archiveContractFor(viewer, input);
    revalidateAppData();
    return { ok: true, data: undefined };
  } catch (error) {
    return failure(error);
  }
}

/** Avtalsfilen: FormData med `contractId` och `file`. */
export async function uploadContractFile(
  form: FormData,
): Promise<ActionResult<{ fileName: string }>> {
  try {
    const viewer = await operator();
    const contractId = z.uuid().parse(form.get("contractId"));
    const file = form.get("file");
    if (!(file instanceof File) || file.size === 0) {
      return { ok: false, error: "Välj avtalsfilen (PDF, PNG, JPEG eller Word)." };
    }
    if (file.size > MAX_CONTRACT_FILE_BYTES) {
      return { ok: false, error: "Filen är för stor (högst 20 MB)." };
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    await attachContractFileFor(
      viewer,
      { contractId, fileName: file.name, bytes },
      { fileStore: await contractFileStore() },
    );
    revalidateAppData();
    return { ok: true, data: { fileName: file.name } };
  } catch (error) {
    return failure(error);
  }
}

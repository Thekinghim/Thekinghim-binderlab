"use server";

/**
 * Server actions för Avtal: skapa och ändra avtal (med villkor), arkivera, och bifoga
 * avtalsfilen. Indata valideras med zod, rollen kontrolleras här (requireContextRole) och i
 * tjänsten mot databasen, allt skrivs som användaren med RLS.
 */

import { headers } from "next/headers";
import { unstable_rethrow } from "next/navigation";
import { z, ZodError } from "zod";

import { DomainError } from "@/domain";
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
import {
  ContractError,
  createSigningLinkFor,
  createStoreContractFor,
  setContractStatusFor,
  type ContractStatus,
} from "@/server/contracts";
import { OPERATOR_ROLES, requireContextRole, revalidateSettlementData } from "@/server/data/core";
import { businessToday } from "@/server/data/core/loaders";
import { dbErrorMessage, pgErrorOf } from "@/server/errors";
import { getPdfRenderer, pdfStatus } from "@/server/pdf/render";
import { getServerEnv } from "@/lib/env";
import { contractTermsSchema } from "../butiker/_lib/validation";
import { resolveAppBaseUrl } from "@/server/request-info";

export type ActionResult<T = undefined> = { ok: true; data: T } | { ok: false; error: string };

function failure(error: unknown): { ok: false; error: string } {
  unstable_rethrow(error);
  if (error instanceof ZodError) {
    return { ok: false, error: error.issues[0]?.message ?? "Ogiltiga uppgifter." };
  }
  if (
    error instanceof AccountingError ||
    error instanceof ContractError ||
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
  })
  .refine((v) => v.validTo === null || v.validTo >= v.validFrom, {
    message: "Avtalet kan inte sluta före det börjar.",
  })
  .refine((v) => v.renewalMonths !== 0, { message: "Förlängningen måste vara minst 1 månad." })
  .transform((v) => {
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
      // Nya villkor skapas bara med Skapa avtal (vinstdelning 50/50) eller under Butiker.
      newTerms: null,
    };
  });

/** Skapar eller ändrar ett avtal. */
export async function saveContract(raw: unknown): Promise<ActionResult<{ id: string }>> {
  try {
    const viewer = await operator();
    const input = contractSchema.parse(raw);
    const data = await saveContractFor(viewer, input);
    await revalidateSettlementData();
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
    await revalidateSettlementData();
    return { ok: true, data: undefined };
  } catch (error) {
    return failure(error);
  }
}

/**
 * Skapa kontrakt: butik (eller plats i pipelinen), startdag och villkoren ägaren valt
 * (`terms`, se contractTermsSchema; utan dem 50 % av vinsten efter kostnader). Sparar
 * kontraktet, villkoren och PDF:en. `needsConfirm` när startdagen ligger bakåt.
 */
export async function createContract(
  raw: unknown,
): Promise<
  | { ok: true; data: { id: string; storeName: string; pdf: boolean } }
  | { ok: false; error: string; needsConfirm?: boolean }
> {
  try {
    const viewer = await operator();
    const base = z
      .object({
        target: z.string().regex(/^(store|lead):[0-9a-f-]{36}$/i, "Välj en butik."),
        validFrom: date,
        confirmHistory: z.boolean().optional(),
        vmbBeforeSplit: z.boolean().optional(),
        fromOpenTerms: z.boolean().optional(),
        terms: z.unknown().optional(),
      })
      .parse(raw);
    // Villkoren ägaren valt (samma regler som Butiker); utan dem 50/50 av vinsten.
    const terms = base.terms === undefined ? null : contractTermsSchema.parse(base.terms);
    const input = {
      target: base.target,
      validFrom: base.validFrom,
      confirmHistory: base.confirmHistory,
      vmbBeforeSplit: base.vmbBeforeSplit,
      fromOpenTerms: base.fromOpenTerms,
      ...(terms
        ? {
            terms: {
              shareBp: terms.shareBp,
              base: terms.base,
              lossTreatment: terms.lossTreatment,
              vmbBeforeSplit: terms.vmbBeforeSplit,
              monthlyRentOre: terms.monthlyRentOre,
            },
            specialTerms: terms.specialTerms,
          }
        : {}),
    };
    const result = await createStoreContractFor(viewer, input, {
      today: businessToday(new Date(), viewer.organization.timezone),
      renderPdf: pdfStatus().configured ? (html) => getPdfRenderer().renderHtml(html) : null,
      fileStore: () => contractFileStore(),
    });
    if (!result.ok) return { ok: false, error: result.message, needsConfirm: true };
    await revalidateSettlementData();
    return {
      ok: true,
      data: { id: result.contractId, storeName: result.storeName, pdf: result.pdf },
    };
  } catch (error) {
    return failure(error);
  }
}

/** Avtalets status: utkast, skickat eller signerat. */
export async function setContractStatus(raw: unknown): Promise<ActionResult> {
  try {
    const viewer = await operator();
    const input = z
      .object({ id: z.uuid(), status: z.enum(["draft", "sent", "signed"]) })
      .parse(raw) as { id: string; status: ContractStatus };
    await setContractStatusFor(viewer, input);
    await revalidateSettlementData();
    return { ok: true, data: undefined };
  } catch (error) {
    return failure(error);
  }
}

/**
 * Avtalsfilen: FormData med `contractId` och `file`. Med `signed` = "1" är filen den
 * signerade kopian, och avtalet markeras som signerat.
 */
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
    if (form.get("signed") === "1") {
      await setContractStatusFor(viewer, { id: contractId, status: "signed" });
    }
    await revalidateSettlementData();
    return { ok: true, data: { fileName: file.name } };
  } catch (error) {
    return failure(error);
  }
}

/**
 * Signera på plats: en engångslänk (7 dagar) till avtalets PDF som butiksägaren öppnar på
 * sin mobil. Länken visas en gång; en ny länk ersätter den förra.
 */
export async function createSigningLink(
  raw: unknown,
): Promise<ActionResult<{ url: string; expiresAt: string }>> {
  try {
    const viewer = await operator();
    const id = z.uuid().parse(raw);
    const { token, expiresAt } = await createSigningLinkFor(viewer, id, {
      renderPdf: pdfStatus().configured ? (html) => getPdfRenderer().renderHtml(html) : null,
      fileStore: await contractFileStore(),
    });
    const base = resolveAppBaseUrl(getServerEnv(), await headers());
    await revalidateSettlementData();
    return {
      ok: true,
      data: { url: `${base}/signera/${token}`, expiresAt: expiresAt.toISOString() },
    };
  } catch (error) {
    return failure(error);
  }
}

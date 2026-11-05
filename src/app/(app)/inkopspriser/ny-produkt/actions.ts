"use server";

/**
 * Server actions för "Ny produkt" (Inköpspriser → Ny produkt). Tunna omslag: rollen
 * kontrolleras här (requireContextRole) och i tjänsten mot databasen, indata valideras med
 * zod i tjänsten, och organisationen är alltid den inloggades aktiva. Varje skrivning till
 * Awish kräver förhandsvisningens fingeravtryck. Awish-inloggningen lämnar aldrig servern.
 */

import { unstable_rethrow } from "next/navigation";
import { z, ZodError } from "zod";

import { AuthorizationError } from "@/server/access";
import { AwishApiError } from "@/server/awish/grpc-client";
import { checkGoodImage, NewProductError, type GoodImage } from "@/server/awish/goods";
import {
  applySlotChangeFor,
  createNewProductFor,
  FORBIDDEN_MESSAGE,
  previewNewProductFor,
  previewSlotChangeFor,
  slotChoicesFor,
  type NewProductPreview,
  type NewProductResult,
  type SlotChangePreview,
  type SlotChoices,
} from "@/server/awish/new-product";
import {
  OPERATOR_ROLES,
  requireContextRole,
  requireViewer,
  revalidateAppData,
} from "@/server/data/core";
import { dbErrorMessage, safeErrorForLog } from "@/server/errors";

export type ActionResult<T = undefined> = { ok: true; data: T } | { ok: false; error: string };

function failure(error: unknown): { ok: false; error: string } {
  unstable_rethrow(error);
  if (error instanceof ZodError) {
    return { ok: false, error: error.issues[0]?.message ?? "Ogiltiga uppgifter." };
  }
  if (error instanceof AuthorizationError) {
    return {
      ok: false,
      error: error.reason === "unauthenticated" ? error.message : FORBIDDEN_MESSAGE,
    };
  }
  if (error instanceof NewProductError || error instanceof AwishApiError) {
    return { ok: false, error: error.message };
  }
  // Bara namn, meddelande och SQLSTATE loggas (aldrig parametrar eller inloggning).
  console.error("[ny-produkt]", safeErrorForLog(error));
  return { ok: false, error: dbErrorMessage(error) };
}

async function operator() {
  await requireContextRole(OPERATOR_ROLES);
  return requireViewer();
}

/** FormData: `input` (JSON med name, salePrice, purchasePrice, ownProduct) och ev. `image`. */
async function readForm(form: unknown): Promise<{ input: unknown; image: GoodImage | null }> {
  if (!(form instanceof FormData)) throw new NewProductError("Ogiltiga uppgifter.");
  const raw = form.get("input");
  let input: unknown;
  try {
    input = JSON.parse(typeof raw === "string" ? raw : "{}");
  } catch {
    throw new NewProductError("Ogiltiga uppgifter.");
  }
  const file = form.get("image");
  if (!(file instanceof File) || file.size === 0) return { input, image: null };
  const name = (input as { name?: unknown } | null)?.name;
  return {
    input,
    image: checkGoodImage(
      new Uint8Array(await file.arrayBuffer()),
      typeof name === "string" ? name : "",
    ),
  };
}

const fingerprintSchema = z.string().regex(/^[0-9a-f]{32}$/, "Förhandsgranska först.");

/** Förhandsvisning av en ny produkt. Skriver ingenting. */
export async function previewNewProduct(form: FormData): Promise<ActionResult<NewProductPreview>> {
  try {
    const viewer = await operator();
    const { input, image } = await readForm(form);
    return { ok: true, data: await previewNewProductFor(viewer, input, image) };
  } catch (error) {
    return failure(error);
  }
}

/** Skicka till Awish: skapar varan i Awish och kopplar den i Binderlab. */
export async function createNewProduct(form: FormData): Promise<ActionResult<NewProductResult>> {
  try {
    const viewer = await operator();
    const fingerprint = fingerprintSchema.parse(
      form instanceof FormData ? form.get("fingerprint") : null,
    );
    const { input, image } = await readForm(form);
    const data = await createNewProductFor(viewer, input, image, fingerprint);
    if (data.status !== "nothing") revalidateAppData();
    return { ok: true, data };
  } catch (error) {
    return failure(error);
  }
}

/** Automatens fack och varorna i Awish (läses nu). Skriver ingenting. */
export async function loadSlotChoices(machineId: unknown): Promise<ActionResult<SlotChoices>> {
  try {
    const viewer = await operator();
    const id = z.uuid("Välj automat.").parse(machineId);
    return { ok: true, data: await slotChoicesFor(viewer, id) };
  } catch (error) {
    return failure(error);
  }
}

/** Förhandsvisning av ett byte i ett fack. Skriver ingenting. */
export async function previewSlotChange(raw: unknown): Promise<ActionResult<SlotChangePreview>> {
  try {
    const viewer = await operator();
    return { ok: true, data: await previewSlotChangeFor(viewer, raw) };
  } catch (error) {
    return failure(error);
  }
}

/** Skicka bytet i facket till Awish. `confirmed` krävs när facket har pack som byts eller sänks. */
export async function applySlotChange(raw: unknown): Promise<ActionResult<{ message: string }>> {
  try {
    const viewer = await operator();
    const r = (raw ?? {}) as { fingerprint?: unknown; confirmed?: unknown };
    const fingerprint = fingerprintSchema.parse(r.fingerprint);
    const data = await applySlotChangeFor(viewer, raw, fingerprint, r.confirmed === true);
    revalidateAppData();
    return { ok: true, data };
  } catch (error) {
    return failure(error);
  }
}

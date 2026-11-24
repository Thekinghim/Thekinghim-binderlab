"use server";

/**
 * Inköpspriser → Kategorier: kategorierna i Awish och kategori per fack. Bara ägare och
 * admin; rollen kontrolleras här och i tjänsten mot databasen.
 */

import { catalogAction } from "@/server/awish-catalog/action-result";
import {
  applyBatchCategoryFor,
  applyCategoryFor,
  categorySlotsFor,
  previewBatchCategoryFor,
  previewCategoryFor,
} from "@/server/awish-catalog/categories";
import {
  OPERATOR_ROLES,
  requireContextRole,
  requireViewer,
  revalidateAppData,
} from "@/server/data/core";

async function operator() {
  await requireContextRole(OPERATOR_ROLES);
  return requireViewer();
}

export async function previewCategory(raw: unknown) {
  return catalogAction("kategorier", async () => previewCategoryFor(await operator(), raw));
}

export async function applyCategory(raw: unknown) {
  return catalogAction("kategorier", async () => {
    const r = await applyCategoryFor(await operator(), raw);
    revalidateAppData();
    return r;
  });
}

export async function categorySlots(machineId: unknown) {
  return catalogAction("kategorier", async () => categorySlotsFor(await operator(), machineId));
}

export async function previewBatchCategory(raw: unknown) {
  return catalogAction("kategorier", async () => previewBatchCategoryFor(await operator(), raw));
}

export async function applyBatchCategory(raw: unknown) {
  return catalogAction("kategorier", async () => {
    const r = await applyBatchCategoryFor(await operator(), raw);
    revalidateAppData();
    return r;
  });
}

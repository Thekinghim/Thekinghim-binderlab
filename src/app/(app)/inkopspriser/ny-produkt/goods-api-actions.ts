"use server";

/**
 * Varor i Awish via API:t: kategori på en vara och "Ta bort vara" (DeleteGood). Bara ägare
 * och admin; rollen kontrolleras här och i tjänsten mot databasen.
 */

import { catalogAction } from "@/server/awish-catalog/action-result";
import { categoryListFor } from "@/server/awish-catalog/categories";
import {
  deleteGoodFor,
  previewDeleteGoodFor,
  previewGoodCategoryFor,
  setGoodCategoryFor,
} from "@/server/awish-catalog/goods-api";
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

export async function goodCategories() {
  return catalogAction("varor-api", async () => categoryListFor(await operator()));
}

export async function previewGoodCategory(raw: unknown) {
  return catalogAction("varor-api", async () => previewGoodCategoryFor(await operator(), raw));
}

export async function setGoodCategory(raw: unknown) {
  return catalogAction("varor-api", async () => {
    const r = await setGoodCategoryFor(await operator(), raw);
    await revalidateAppData();
    return r;
  });
}

export async function previewDeleteGood(raw: unknown) {
  return catalogAction("varor-api", async () => previewDeleteGoodFor(await operator(), raw));
}

export async function deleteGood(raw: unknown) {
  return catalogAction("varor-api", async () => {
    const r = await deleteGoodFor(await operator(), raw);
    await revalidateAppData();
    return r;
  });
}

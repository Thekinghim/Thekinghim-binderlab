/**
 * Den inloggade användaren och den aktiva organisationen som en Viewer, för Lagers sida.
 * Kastar AuthorizationError om användaren saknar organisation; rollen kontrolleras i
 * varje laddare och tjänst mot databasen.
 */

import "server-only";

import { cache } from "react";

import type { Viewer } from "@/server/data/core/loaders";
import { AuthorizationError, getActiveOrganization, requireUser } from "@/server/session";

export const currentViewer = cache(async (): Promise<Viewer> => {
  const user = await requireUser();
  const organization = await getActiveOrganization();
  if (!organization) {
    throw new AuthorizationError("forbidden", "Du är inte medlem i någon organisation.");
  }
  return { user, organization };
});

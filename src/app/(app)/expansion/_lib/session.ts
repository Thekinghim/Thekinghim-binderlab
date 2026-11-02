/**
 * Den inloggade användaren och den aktiva organisationen som en Viewer, för sidorna och
 * server actions under Expansion, Enhetsekonomi och Effekt. Rollen kontrolleras i varje
 * funktion i ./service.
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

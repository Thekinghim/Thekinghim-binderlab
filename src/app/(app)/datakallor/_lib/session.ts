/**
 * Den inloggade användaren och den aktiva organisationen som en Viewer, för
 * Datakällors sidor och server actions. Kastar AuthorizationError om användaren
 * saknar organisation; rollen kontrolleras i varje funktion i ./service.
 */

import "server-only";

import { cache } from "react";

import type { Viewer } from "@/server/data/core/loaders";
import { AuthorizationError, getActiveOrganization, requireUser } from "@/server/session";

import { UploadStaging } from "./staging";

export const currentViewer = cache(async (): Promise<Viewer> => {
  const user = await requireUser();
  const organization = await getActiveOrganization();
  if (!organization) {
    throw new AuthorizationError("forbidden", "Du är inte medlem i någon organisation.");
  }
  return { user, organization };
});

const globalForStaging = globalThis as typeof globalThis & {
  __binderlabUploadStaging?: UploadStaging;
};

/** Mellanlagret för uppladdningar (i databasen; instansen är tillståndslös). */
export function uploadStaging(): UploadStaging {
  return (globalForStaging.__binderlabUploadStaging ??= new UploadStaging());
}

/**
 * Sökningen för den inloggade användaren (GET /sok). Sessionen och den aktiva
 * organisationen läses per förfrågan; rollen kontrolleras med requireRole innan
 * tjänsten (./service) läser något, och tjänsten läser sedan allt med RLS.
 */

import "server-only";

import type { Viewer } from "@/server/data/core/loaders";
import { ALL_ROLES } from "@/server/data/core/types";
import {
  AuthorizationError,
  getActiveOrganization,
  getSessionUser,
  requireRole,
} from "@/server/session";

import { pickListFor, searchFor } from "./service";
import type { PickList, PickResponse, SearchResponse } from "./types";

export * from "./types";

/**
 * Den inloggade användaren och den aktiva organisationen. Kastar
 * AuthorizationError("unauthenticated") utan session (en fetch ska få 401, inte en
 * omdirigering) och "forbidden" utan medlemskap.
 */
async function currentViewer(): Promise<Viewer> {
  const user = await getSessionUser();
  if (!user) throw new AuthorizationError("unauthenticated");
  const organization = await getActiveOrganization();
  if (!organization) {
    throw new AuthorizationError("forbidden", "Du är inte medlem i någon organisation.");
  }
  await requireRole(organization.id, ALL_ROLES);
  return { user, organization };
}

/** Söker som den inloggade användaren (se searchFor). */
export async function search(query: string): Promise<SearchResponse> {
  return searchFor(await currentViewer(), query);
}

/** Listan för ett steg i paletten som den inloggade användaren (se pickListFor). */
export async function pickList(list: PickList, machineId: string | null): Promise<PickResponse> {
  return pickListFor(await currentViewer(), list, machineId);
}

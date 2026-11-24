"use server";

/**
 * Inställningar → Medlemmar: ny medlem, ändra och ta bort (Awish). Bara ägare och admin;
 * rollen kontrolleras här och i tjänsten mot databasen. Medlemsuppgifter sparas aldrig i
 * Binderlab och loggas aldrig.
 */

import { catalogAction } from "@/server/awish-catalog/action-result";
import {
  applyMemberFor,
  MEMBERS_FORBIDDEN,
  previewMemberFor,
} from "@/server/awish-catalog/members";
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

export async function previewMember(raw: unknown) {
  return catalogAction(
    "medlemmar",
    async () => previewMemberFor(await operator(), raw),
    MEMBERS_FORBIDDEN,
  );
}

export async function applyMember(raw: unknown) {
  return catalogAction(
    "medlemmar",
    async () => {
      const r = await applyMemberFor(await operator(), raw);
      revalidateAppData();
      return r;
    },
    MEMBERS_FORBIDDEN,
  );
}

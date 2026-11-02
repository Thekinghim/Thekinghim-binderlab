"use server";

/**
 * Server actions för Enhetsekonomi: investeringar per automat (inköp, installation,
 * övrigt). Bara ägare och admin. Investeringar raderas aldrig (ekonomiska uppgifter);
 * fel rättas genom att beloppet ändras, och ändringen loggas i audit_log. Därför stoppas
 * orimliga datum (mer än två år från i dag) redan vid fältet.
 */

import { OPERATOR_ROLES, requireContextRole, revalidateAppData } from "@/server/data/core";

import { failure, type ActionResult } from "../../expansion/_lib/action-result";
import { investmentSchemaAt } from "../../expansion/_lib/schemas";
import { saveInvestmentFor } from "../../expansion/_lib/service";
import { currentViewer } from "../../expansion/_lib/session";

export async function saveInvestment(raw: unknown): Promise<ActionResult<{ id: string }>> {
  try {
    const ctx = await requireContextRole(OPERATOR_ROLES);
    const viewer = await currentViewer();
    const id = await saveInvestmentFor(viewer, investmentSchemaAt(ctx.today).parse(raw));
    revalidateAppData();
    return { ok: true, data: { id } };
  } catch (error) {
    return failure(error, "enhetsekonomi");
  }
}

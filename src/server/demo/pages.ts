/**
 * Sidor som inte hör till panelen (designsystemet och datamodellen) visas inte i en demo
 * (Demo för kunder): kunden ska bara se panelen, inget internt.
 */

import "server-only";

import { notFound } from "next/navigation";

import { getActiveOrganization, requireUser } from "@/server/session";

import { isDemoFor } from "./guard";

export async function hideInDemo(): Promise<void> {
  const user = await requireUser();
  const organization = await getActiveOrganization();
  if (organization && (await isDemoFor(user, organization.id))) {
    notFound();
  }
}

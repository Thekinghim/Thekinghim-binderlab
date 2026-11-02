import { notFound, redirect } from "next/navigation";
import type { ReactNode } from "react";

import { isUuid } from "@/server/access";
import { requireRoute } from "@/server/data/core";

import { incidentExists } from "../_lib/load";

/**
 * Kontrollerar ärendet innan laddningsläget ([id]/loading.tsx) börjar strömma, så att ett okänt
 * id ger HTTP 404 och inte 200 (Next.js: statuskoden bestäms av det första svaret). Sidan
 * (inkorg/not-found.tsx) är densamma som förut.
 */
export default async function IncidentLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ id: string }>;
}) {
  const ctx = await requireRoute("inkorg");
  // Påfyllaren hanterar inga kundärenden: samma förklaring som i listan.
  if (!ctx.canSeeEconomy) redirect("/inkorg");
  const { id } = await params;
  if (!isUuid(id) || !(await incidentExists(ctx, id.toLowerCase()))) notFound();
  return children;
}

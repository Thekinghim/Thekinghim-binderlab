import { notFound } from "next/navigation";
import type { ReactNode } from "react";

import { isUuid } from "@/server/access";
import { loadMasterData, requireRoute } from "@/server/data/core";

/**
 * Kontrollerar automaten (aktiva automater ur skalets redan laddade stamdata, samma urval som
 * tidslinjen) innan laddningsläget ([id]/loading.tsx) börjar strömma, så att ett okänt id ger
 * HTTP 404 och inte 200. Sidan för okänd automat är drift/automat/not-found.tsx.
 */
export default async function TimelineLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ id: string }>;
}) {
  await requireRoute("drift");
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const key = id.toLowerCase();
  const { machines } = await loadMasterData();
  if (!machines.some((m) => m.id === key && !m.archived)) notFound();
  return children;
}

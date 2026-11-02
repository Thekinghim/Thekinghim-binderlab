import { notFound } from "next/navigation";
import type { ReactNode } from "react";

import { requireRoute } from "@/server/data/core";

import { importExistsFor } from "../../_lib/service";
import { currentViewer } from "../../_lib/session";

/**
 * Kontrollerar importen innan laddningsläget ([id]/loading.tsx) börjar strömma, så att ett
 * okänt id ger HTTP 404 och inte 200. Sidan för okänd import är datakallor/importer/not-found.tsx.
 */
export default async function ImportLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ id: string }>;
}) {
  await requireRoute("datakallor");
  const { id } = await params;
  if (!(await importExistsFor(await currentViewer(), id))) notFound();
  return children;
}

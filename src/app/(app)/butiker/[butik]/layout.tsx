import { notFound } from "next/navigation";
import type { ReactNode } from "react";

import { storeNameOf } from "../_lib/data";

/**
 * Kontrollerar butiken (ur de redan laddade butikerna) innan laddningsläget
 * ([butik]/loading.tsx) börjar strömma, så att en okänd butik ger HTTP 404 och inte 200.
 * Sidan för okänd butik är butiker/not-found.tsx.
 */
export default async function StoreLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ butik: string }>;
}) {
  const { butik } = await params;
  if ((await storeNameOf(decodeURIComponent(butik))) === null) notFound();
  return children;
}

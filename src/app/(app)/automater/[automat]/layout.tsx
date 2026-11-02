import { notFound } from "next/navigation";
import type { ReactNode } from "react";

import { resolveMachineCode } from "../_lib/data";

/**
 * Kontrollerar automaten (id eller kod, ur skalets redan laddade stamdata) innan
 * laddningsläget ([automat]/loading.tsx) börjar strömma, så att en okänd automat ger
 * HTTP 404 och inte 200. Sidan för okänd automat är automater/not-found.tsx.
 */
export default async function MachineLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ automat: string }>;
}) {
  const { automat } = await params;
  if (!(await resolveMachineCode(automat))) notFound();
  return children;
}

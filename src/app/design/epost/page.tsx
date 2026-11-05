import type { Metadata } from "next";
import { hideInDemo } from "@/server/demo/pages";
import { requireUser } from "@/server/session";

import { EpostPreview } from "./epost-preview";
import { parseRecipientKind } from "./kind";

export const metadata: Metadata = { title: "E-postmall" };

/** Förhandsvisning av rapportmejlet. Mottagare väljs med ?typ=butik|bokforing|delagare. */
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  await requireUser();
  // Internt: inte i en demo (Demo för kunder).
  await hideInDemo();
  const { typ } = await searchParams;
  return <EpostPreview initialKind={parseRecipientKind(typ)} />;
}

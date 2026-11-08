import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { simpleHomeFor } from "@/components/shell/simple-view";
import { getT } from "@/i18n/server";
import { loadContext } from "@/server/data/core";

import { SalesScreen } from "./_components/sales-screen";

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getT();
  return { title: t.sales.title };
}

/**
 * Försäljning (/forsaljning): samma skärm som startsidan i Enkel vy (Hem visar den för den
 * enkla vyn). Ägare, admin och läsare; andra skickas till sin startsida i den enkla vyn.
 */
export default async function SalesPage() {
  const ctx = await loadContext();
  if (!ctx.canSeeEconomy) redirect(simpleHomeFor(ctx.role));
  return <SalesScreen ctx={ctx} />;
}

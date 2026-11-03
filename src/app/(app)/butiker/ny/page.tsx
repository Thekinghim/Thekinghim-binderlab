import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { day } from "@/analytics/todos/text";
import { SectionHeader } from "@/components/ui/section-header";
import { formatInt, NBSP } from "@/lib/format";
import { requireRoute, requireViewer } from "@/server/data/core";
import { loadNewMachinesFor } from "@/server/machines/new-machines";
import { nextMachineCode } from "@/app/(app)/automater/_lib/model";
import { loadMasterData } from "@/server/data/core";

import { StoreGuide, type GuideMachine } from "./store-guide";

export const metadata: Metadata = { title: "Ny butik" };

type SearchParams = Record<string, string | string[] | undefined>;

/**
 * Guiden "Ny butik": butik → villkor (50/50 förvalt) → automat → klart, ett steg i taget.
 * ?awish=<källautomat> förväljer en automat som Awish hittat (från Att göra).
 * Bara ägare och admin.
 */
export default async function NyButikPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const ctx = await requireRoute("butiker");
  if (!ctx.canEdit) redirect("/butiker");
  const sp = await searchParams;
  const [viewer, master] = await Promise.all([requireViewer(), loadMasterData()]);
  const state = await loadNewMachinesFor(viewer);
  const found: GuideMachine[] = state.machines.map((m) => ({
    id: m.id,
    title: m.name,
    code: m.suggestedCode,
    detail:
      m.orders > 0 && m.firstOrderDate
        ? `${formatInt(m.orders)}${NBSP}köp sedan ${day(m.firstOrderDate)}`
        : "Inga köp än",
  }));
  const wanted = typeof sp.awish === "string" ? sp.awish : null;
  return (
    <div className="mx-auto flex w-full max-w-[720px] flex-col gap-10 px-4 pt-8 pb-16 md:px-8 md:pt-12">
      <div className="rise">
        <SectionHeader
          as="h1"
          size="xl"
          eyebrow="Butiker"
          title="Ny butik."
          aside="Klart på en minut."
        />
      </div>
      <StoreGuide
        found={found}
        preselected={found.some((m) => m.id === wanted) ? wanted : null}
        newCode={nextMachineCode(master.machines.map((m) => m.code))}
      />
    </div>
  );
}

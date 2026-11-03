import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { day } from "@/analytics/todos/text";
import { formatInt, NBSP } from "@/lib/format";
import { loadContractSetupFor } from "@/server/contracts";
import { requireRoute, requireViewer } from "@/server/data/core";
import { loadNewMachinesFor } from "@/server/machines/new-machines";
import { nextMachineCode } from "@/app/(app)/automater/_lib/model";
import { loadMasterData } from "@/server/data/core";

import { loadLeadsFor } from "../../expansion/_lib/service";
import { PageHead } from "../_components/page-head";
import { StoreGuide, type GuideLead, type GuideMachine } from "./store-guide";

export const metadata: Metadata = { title: "Ny butik" };

/** Kontraktet skrivs ut som PDF i sista steget. */
export const maxDuration = 60;

type SearchParams = Record<string, string | string[] | undefined>;

/**
 * Guiden "Ny butik": butik → villkor (50/50 förvalt) → automat → kontrakt → klart, ett
 * steg i taget. ?awish=<källautomat> förväljer en automat som Awish hittat (Att göra),
 * ?plats=<plats> fyller i en plats från pipelinen (Expansion). Bara ägare och admin.
 */
export default async function NyButikPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const ctx = await requireRoute("butiker");
  if (!ctx.canEdit) redirect("/butiker");
  const sp = await searchParams;
  const viewer = await requireViewer();
  const plats = typeof sp.plats === "string" ? sp.plats : null;
  const [master, state, setup, leads] = await Promise.all([
    loadMasterData(),
    loadNewMachinesFor(viewer),
    loadContractSetupFor(viewer),
    plats ? loadLeadsFor(viewer) : Promise.resolve([]),
  ]);
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
  const l = leads.find((x) => x.id === plats && !x.archived && x.storeId === null);
  const lead: GuideLead | null = l
    ? {
        id: l.id,
        name: l.name,
        address: l.address ?? "",
        city: l.city ?? "",
        shareBp: l.commissionBp,
        rentOre: l.monthlyRentOre,
      }
    : null;
  return (
    <div className="mx-auto flex w-full max-w-[720px] flex-col gap-10 px-4 pt-8 pb-16 md:px-8 md:pt-12">
      <PageHead eyebrow="Butiker" title="Ny butik." aside="Klart på en minut." />
      <StoreGuide
        found={found}
        preselected={found.some((m) => m.id === wanted) ? wanted : null}
        newCode={nextMachineCode(master.machines.map((m) => m.code))}
        lead={lead}
        operator={setup.operator}
        today={ctx.today}
      />
    </div>
  );
}

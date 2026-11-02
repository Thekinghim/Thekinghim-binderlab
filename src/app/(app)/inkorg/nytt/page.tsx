import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { SectionHeader } from "@/components/ui/section-header";
import { requireRoute } from "@/server/data/core";

import { IncidentForm } from "../_components/incident-form";
import { loadIncident } from "../_lib/load";
import { utcToLocalInput } from "../_lib/model";

export const metadata: Metadata = { title: "Nytt ärende" };

/** Registrera ett kundärende. Ägare och admin. */
export default async function NewIncidentPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const ctx = await requireRoute("inkorg");
  if (!ctx.canEdit) redirect("/inkorg");
  const sp = await searchParams;
  const data = await loadIncident(ctx, null);
  const machineParam = typeof sp.automat === "string" ? sp.automat : "";
  const machineId = data.machines.some((m) => m.id === machineParam) ? machineParam : (data.machines[0]?.id ?? "");
  return (
    <div className="mx-auto flex w-full max-w-[960px] flex-col gap-10 px-4 pt-8 pb-16 md:px-8 md:pt-12">
      <SectionHeader
        as="h1"
        size="xl"
        eyebrow="Inkorg / Nytt ärende"
        title="Registrera ett kundärende."
        aside="Koppla det till automat, tidpunkt och helst ordern, så att det går att följa upp."
      />
      <IncidentForm
        initial={{
          machineId,
          kind: "not_delivered",
          occurredAt: utcToLocalInput(ctx.now, ctx.timeZone),
          orderId: "",
          titleId: "",
          description: "",
          customerContact: "",
          status: "open",
          assigneeId: ctx.user.id,
          actionTaken: "",
          refunded: "",
          refundedOn: ctx.today,
        }}
        machines={data.machines.map((m) => ({ id: m.id, label: `${m.code} ${m.name}` }))}
        titles={data.titles}
        members={data.members}
        timeZone={ctx.timeZone}
        currentOrder={null}
      />
    </div>
  );
}

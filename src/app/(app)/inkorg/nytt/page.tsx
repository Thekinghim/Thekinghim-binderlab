import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { SectionHeader } from "@/components/ui/section-header";
import { requireRoute } from "@/server/data/core";

import { ClosedMonthsBanner } from "../../_manad/closed-note";
import { IncidentForm } from "../_components/incident-form";
import { formatCsvNumber } from "@/lib/format";

import { loadIncident, loadPrefillOrder } from "../_lib/load";
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
  // Från Att göra ("Hantera ordern"): ärendet börjar från ordern som Awish återbetalade.
  const order = typeof sp.order === "string" ? await loadPrefillOrder(ctx, sp.order) : null;
  const machineParam = order?.machineId ?? (typeof sp.automat === "string" ? sp.automat : "");
  const machineId = data.machines.some((m) => m.id === machineParam)
    ? machineParam
    : (data.machines[0]?.id ?? "");
  const prefilled = order !== null && order.machineId === machineId;
  return (
    <div className="mx-auto flex w-full max-w-[960px] flex-col gap-10 px-4 pt-8 pb-16 md:px-8 md:pt-12">
      <SectionHeader
        as="h1"
        size="xl"
        eyebrow="Inkorg / Nytt ärende"
        title={prefilled ? `Återbetalning för order ${order.externalId}.` : "Nytt ärende."}
        aside={
          prefilled
            ? "Awish har återbetalat ordern. Kontrollera beloppet och spara."
            : "Välj automat och helst ordern."
        }
      />
      <ClosedMonthsBanner />
      <IncidentForm
        initial={{
          machineId,
          kind: prefilled ? "refund_request" : "not_delivered",
          occurredAt: utcToLocalInput(prefilled ? order.orderedAt : ctx.now, ctx.timeZone),
          orderId: prefilled ? order.id : "",
          titleId: prefilled ? (order.titleId ?? "") : "",
          description: prefilled ? "Återbetald i Awish." : "",
          customerContact: "",
          status: "open",
          assigneeId: ctx.user.id,
          actionTaken: "",
          refunded: prefilled ? formatCsvNumber(order.amountOre / 100) : "",
          refundedOn: ctx.today,
        }}
        machines={data.machines.map((m) => ({ id: m.id, label: `${m.code} ${m.name}` }))}
        titles={data.titles}
        members={data.members}
        timeZone={ctx.timeZone}
        currentOrder={
          prefilled
            ? {
                id: order.id,
                externalId: order.externalId,
                orderedAt: order.orderedAt,
                amountOre: order.amountOre,
                titleId: order.titleId,
                titleName: order.titleName,
              }
            : null
        }
      />
    </div>
  );
}

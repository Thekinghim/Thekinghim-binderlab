import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { Card, CardBody } from "@/components/v2/card";
import { V2Page } from "@/components/v2/shell/page";
import { SubNav } from "@/components/v2/sub-nav";
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
    <V2Page
      title="Nytt ärende"
      sub={
        <>
          {prefilled ? <b>{`Återbetalning för order ${order.externalId}.`} </b> : null}
          {prefilled
            ? "Awish har återbetalat ordern. Kontrollera beloppet och spara."
            : "Välj automat och helst ordern."}
        </>
      }
    >
      <SubNav />
      <div className="v2-stack max-w-[960px]">
        <Card title="Ärendet">
          <CardBody className="flex flex-col gap-4">
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
          </CardBody>
        </Card>
      </div>
    </V2Page>
  );
}

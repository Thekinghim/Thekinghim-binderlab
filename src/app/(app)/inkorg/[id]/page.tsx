import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { SectionHeader } from "@/components/ui/section-header";
import { StatusTag } from "@/components/ui/status-tag";
import { formatCsvNumber, formatDate } from "@/lib/format";
import { isoDateToShellDate, requireRoute } from "@/server/data/core";

import { formatWhen } from "../../drift/_lib/display";
import { IncidentForm } from "../_components/incident-form";
import { loadIncident } from "../_lib/load";
import { KIND_LABEL, kronorOfOre, STATUS_LABEL, utcToLocalInput } from "../_lib/model";

export const metadata: Metadata = { title: "Ärende" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACTION: Record<string, string> = {
  insert: "Registrerat",
  update: "Ändrat",
  delete: "Borttaget",
};

/** Ett kundärende: uppgifter, order, hantering och ändringshistorik (audit_log). */
export default async function IncidentPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireRoute("inkorg");
  if (!ctx.canSeeEconomy) notFound();
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const data = await loadIncident(ctx, id.toLowerCase());
  const i = data.incident;
  if (!i) notFound();
  const now = new Date(ctx.now);
  const machine = data.machines.find((m) => m.id === i.machineId);
  const titleName =
    data.titles.find((t) => t.id === (data.order?.titleId ?? i.titleId))?.name ?? null;

  return (
    <div className="mx-auto flex w-full max-w-[960px] flex-col gap-10 px-4 pt-8 pb-16 md:px-8 md:pt-12">
      <SectionHeader
        as="h1"
        size="xl"
        eyebrow={`Inkorg / ${machine?.code ?? "Ärende"}`}
        title={`${KIND_LABEL[i.kind] ?? i.kind}, ${formatWhen(i.startedAt, ctx.timeZone, now)}.`}
        aside={
          i.refundedOre > 0
            ? `${kronorOfOre(i.refundedOre)} återbetalt${i.refundedOn ? ` ${formatDate(isoDateToShellDate(i.refundedOn))}` : ""}.`
            : i.status === "resolved"
              ? `Löst ${formatWhen(i.endedAt, ctx.timeZone, now)}.`
              : "Ingen återbetalning registrerad."
        }
        meta={[
          { label: "Status", value: STATUS_LABEL[i.status] },
          { label: "Automat", value: machine?.code ?? "–" },
          { label: "Order", value: data.order?.externalId ?? "–" },
        ]}
      />
      <div className="flex flex-wrap items-center gap-3">
        <StatusTag
          status={i.status === "resolved" ? "ok" : i.status === "open" ? "warning" : "neutral"}
        >
          {STATUS_LABEL[i.status]}
        </StatusTag>
        <Link
          href={`/drift/automat/${i.machineId}`}
          className="rounded-xs text-sm text-muted hover:text-fg"
        >
          Automatens tidslinje →
        </Link>
        <Link href="/inkorg" className="rounded-xs text-sm text-muted hover:text-fg">
          Alla ärenden →
        </Link>
      </div>
      <IncidentForm
        initial={{
          id: i.id,
          machineId: i.machineId,
          kind: i.kind,
          occurredAt: utcToLocalInput(i.startedAt, ctx.timeZone),
          orderId: i.orderId ?? "",
          titleId: i.titleId ?? "",
          description: i.description ?? "",
          customerContact: i.customerContact ?? "",
          status: i.status,
          assigneeId: i.assigneeId ?? "",
          actionTaken: i.actionTaken ?? "",
          refunded: i.refundedOre > 0 ? formatCsvNumber(i.refundedOre / 100) : "",
          refundedOn: i.refundedOn ?? ctx.today,
        }}
        machines={data.machines.map((m) => ({ id: m.id, label: `${m.code} ${m.name}` }))}
        titles={data.titles}
        members={data.members}
        timeZone={ctx.timeZone}
        currentOrder={
          data.order
            ? {
                id: data.order.id,
                externalId: data.order.externalId,
                orderedAt: data.order.orderedAt,
                amountOre: data.order.amountOre,
                titleId: data.order.titleId,
                titleName,
              }
            : null
        }
        readOnly={!ctx.canEdit}
      />
      {data.history.length > 0 ? (
        <section aria-labelledby="historik" className="flex flex-col gap-4">
          <SectionHeader
            id="historik"
            eyebrow="Historik"
            title="Ändringar."
            size="sm"
            aside="Ur ändringsloggen."
          />
          <ul className="flex flex-col divide-y divide-line border-y border-line text-sm">
            {data.history.map((h, n) => (
              <li key={`${h.at}-${n}`} className="flex flex-wrap justify-between gap-3 py-2">
                <span className="text-fg">{`${ACTION[h.action] ?? h.action}${h.actor ? ` av ${h.actor}` : ""}`}</span>
                <span className="meta text-subtle">{formatWhen(h.at, ctx.timeZone, now)}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

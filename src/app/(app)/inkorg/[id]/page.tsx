import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { MobileFold } from "@/components/ui/mobile-fold";
import { Badge } from "@/components/v2/badge";
import { Card, CardBody } from "@/components/v2/card";
import { KeyValues } from "@/components/v2/key-values";
import { V2Page } from "@/components/v2/shell/page";
import { SubNav } from "@/components/v2/sub-nav";
import { formatCsvNumber, formatDate } from "@/lib/format";
import { isoDateToShellDate, requireRoute } from "@/server/data/core";

import "@/app/(app)/installningar/_components/settings.css";

import { formatWhen } from "../../drift/_lib/display";
import { ClosedMonthsBanner } from "../../_manad/closed-note";
import { IncidentForm } from "../_components/incident-form";
import { loadIncident } from "../_lib/load";
import {
  isStoreFault,
  KIND_LABEL,
  kronorOfOre,
  STATUS_LABEL,
  telHref,
  utcToLocalInput,
} from "../_lib/model";

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
  // Påfyllaren hanterar inga kundärenden: samma förklaring som i listan.
  if (!ctx.canSeeEconomy) redirect("/inkorg");
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const data = await loadIncident(ctx, id.toLowerCase());
  const i = data.incident;
  if (!i) notFound();
  const now = new Date(ctx.now);
  const machine = data.machines.find((m) => m.id === i.machineId);
  // Felanmälan från butiken: numret blir en länk som ringer (notisen landar här).
  const fromStore = isStoreFault(i.kind);
  const tel = telHref(data.store?.phone);
  const titleName =
    data.titles.find((t) => t.id === (data.order?.titleId ?? i.titleId))?.name ?? null;

  const statusTone =
    i.status === "resolved" ? "success" : i.status === "open" ? "warning" : "neutral";

  return (
    <V2Page
      title={KIND_LABEL[i.kind] ?? i.kind}
      date={formatWhen(i.startedAt, ctx.timeZone, now)}
      sub={
        <>
          <Badge tone={statusTone}>{STATUS_LABEL[i.status]}</Badge>{" "}
          {machine?.code ? <b>{machine.code} · </b> : null}
          {i.refundedOre > 0
            ? `${kronorOfOre(i.refundedOre)} återbetalt${i.refundedOn ? ` ${formatDate(isoDateToShellDate(i.refundedOn))}` : ""}.`
            : i.status === "resolved"
              ? `Löst ${formatWhen(i.endedAt, ctx.timeZone, now)}.`
              : "Ingen återbetalning registrerad."}
        </>
      }
    >
      <SubNav />
      <div className="v2-cols">
        <div className="v2-stack">
          {fromStore && data.store ? (
            <Card title="Felanmälan från butiken">
              <CardBody className="flex flex-col gap-3">
                {tel ? (
                  <a href={tel} className="v2-btn act lg w-full md:w-fit">
                    <span>{`Ring ${data.store.name}`}</span>
                    <span className="whitespace-nowrap tabular-nums">{data.store.phone}</span>
                  </a>
                ) : (
                  <p className="st-p">
                    {`${data.store.name} har inget telefonnummer. `}
                    {ctx.canEdit ? (
                      <Link
                        href={`/butiker/${data.store.id}`}
                        className="text-v2-ink underline underline-offset-4"
                      >
                        Lägg in numret under Butiker
                      </Link>
                    ) : null}
                  </p>
                )}
                <p className="st-p">Butiken ser i sin portal när ärendet är Pågår eller Löst.</p>
              </CardBody>
            </Card>
          ) : null}
          <Card title="Ärendet">
            <CardBody>
              {/* Ett löst ärende: sammanfattningen räcker på mobilen, formuläret fälls ut. */}
              <MobileFold summary="Ändra ärendet" defaultOpen={i.status !== "resolved"}>
                <ClosedMonthsBanner className="mb-4" />
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
              </MobileFold>
            </CardBody>
          </Card>
        </div>
        <div className="v2-stack">
          <Card title="Översikt">
            <CardBody className="flex flex-col gap-3">
              <KeyValues
                items={[
                  {
                    label: "Status",
                    value: <Badge tone={statusTone}>{STATUS_LABEL[i.status]}</Badge>,
                  },
                  { label: "Automat", value: machine?.code ?? "–" },
                  { label: "Order", value: data.order?.externalId ?? "–" },
                ]}
              />
            </CardBody>
            <nav aria-label="Vidare" className="flex flex-col border-t border-v2-line">
              <Link href={`/drift/automat/${i.machineId}`} className="st-link">
                Automatens tidslinje
                <span aria-hidden className="arr">
                  →
                </span>
              </Link>
              <Link href="/inkorg" className="st-link">
                Alla ärenden
                <span aria-hidden className="arr">
                  →
                </span>
              </Link>
            </nav>
          </Card>
          {data.history.length > 0 ? (
            <Card
              title={<span id="historik">Ändringar</span>}
              actions={<span className="lk">Ur ändringsloggen</span>}
            >
              <ul className="st-list text-v2-sm" aria-labelledby="historik">
                {data.history.map((h, n) => (
                  <li key={`${h.at}-${n}`} className="flex flex-wrap justify-between gap-3">
                    <span className="text-v2-ink">{`${ACTION[h.action] ?? h.action}${h.actor ? ` av ${h.actor}` : ""}`}</span>
                    <span className="text-v2-mute tabular-nums">
                      {formatWhen(h.at, ctx.timeZone, now)}
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}
        </div>
      </div>
    </V2Page>
  );
}

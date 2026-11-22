import type { Metadata } from "next";

import { Badge, type BadgeTone } from "@/components/v2/badge";
import { Card, CardBody } from "@/components/v2/card";
import { Empty } from "@/components/v2/empty";
import { formatInt } from "@/lib/format";
import {
  FAULT_LABEL,
  FAULT_STATUS_LABEL,
  faultStatus,
  isFaultKind,
  type FaultStatus,
} from "@/server/portal/faults";
import { loadPortalFaults } from "@/server/portal/load";
import { requirePortalContext } from "@/server/portal/session";

import { PortalPage } from "../_components/page-head";
import { dateTimeText } from "../_components/text";
import { FaultForm } from "./fault-form";

export const metadata: Metadata = { title: "Felanmälan" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const STATUS_TONE: Record<FaultStatus, BadgeTone> = {
  open: "warning",
  in_progress: "info",
  resolved: "success",
};

/**
 * Felanmälan: butiken anmäler fel på en automat som står i butiken. Anmälan blir
 * ett ärende hos operatören (incidents, Inkorgen) och syns här med status.
 */
export default async function PortalFaultPage({ searchParams }: { searchParams: SearchParams }) {
  const ctx = await requirePortalContext();
  const sp = await searchParams;
  const requested = Array.isArray(sp.automat) ? sp.automat[0] : sp.automat;
  const { faults, machinesToday, machineNames } = await loadPortalFaults(ctx);
  const open = faults.filter((f) => faultStatus(f.status, f.resolvedAt) !== "resolved");

  return (
    <PortalPage
      id="felanmalan"
      title="Felanmälan"
      sub={
        <>
          <b>
            {open.length === 0
              ? "Inga öppna felanmälningar."
              : open.length === 1
                ? "1 felanmälan är öppen."
                : `${formatInt(open.length)} felanmälningar är öppna.`}
          </b>{" "}
          Anmälan går direkt till {ctx.store.organizationName}, som ser den i sin inkorg.
        </>
      }
    >
      <div className="v2-cols">
        <div className="v2-stack">
          <Card title="Anmäl ett fel">
            {machinesToday.length === 0 ? (
              <Empty title="Ingen automat står i butiken i dag, så det finns inget att felanmäla." />
            ) : (
              <CardBody>
                <FaultForm
                  storeId={ctx.store.storeId}
                  machines={machinesToday}
                  initialMachineId={requested}
                />
              </CardBody>
            )}
          </Card>

          <Card title="Era anmälningar" id="tidigare">
            <CardBody>
              <p className="pt-lead">
                <b>
                  {faults.length === 0
                    ? "Inga anmälningar än."
                    : `${formatInt(faults.length)} ${faults.length === 1 ? "anmälan" : "anmälningar"}.`}
                </b>
                {faults.length > 0
                  ? ` ${formatInt(faults.length - open.length)} ${faults.length - open.length === 1 ? "åtgärdad" : "åtgärdade"}, ${formatInt(open.length)} ${open.length === 1 ? "öppen" : "öppna"}.`
                  : null}
              </p>
            </CardBody>
            {faults.length === 0 ? null : (
              <ul className="pt-list border-t border-v2-line">
                {faults.map((f) => {
                  const status = faultStatus(f.status, f.resolvedAt);
                  return (
                    <li key={f.incidentId} className="pt-item flex-nowrap items-start">
                      <div className="t">
                        <b>
                          {isFaultKind(f.kind) ? FAULT_LABEL[f.kind] : "Felanmälan"}
                          <span className="font-[450] text-v2-mute">
                            {" "}
                            · {machineNames[f.machineId] ?? "Automat"}
                          </span>
                        </b>
                        {f.description ? (
                          <span className="text-v2-sm break-words text-v2-body2">
                            {f.description}
                          </span>
                        ) : null}
                        <small>
                          Anmäld {dateTimeText(f.reportedAt, ctx.store.timezone)}
                          {f.resolvedAt
                            ? ` · åtgärdad ${dateTimeText(f.resolvedAt, ctx.store.timezone)}`
                            : ""}
                        </small>
                      </div>
                      <div className="a">
                        <Badge tone={STATUS_TONE[status]}>{FAULT_STATUS_LABEL[status]}</Badge>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>
        </div>

        <Card title="Bra att veta" as="div">
          <CardBody className="flex flex-col gap-3 text-v2-sm text-v2-body2">
            <p>
              Skriv gärna vad som hände och när. Operatören ser automatens försäljning och larm.
            </p>
            <p>
              Har en kund betalat utan att få sitt pack? Skriv tiden och beloppet i beskrivningen.
            </p>
            <p>
              Är det akut, till exempel krossat glas eller fara för någon? Ring operatören också.
            </p>
          </CardBody>
        </Card>
      </div>
    </PortalPage>
  );
}

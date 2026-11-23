import type { Metadata } from "next";

import { Badge } from "@/components/v2/badge";
import { Card, CardBody } from "@/components/v2/card";
import { Empty } from "@/components/v2/empty";
import { formatInt } from "@/lib/format";
import { FAULT_LABEL, faultStatus, isFaultKind } from "@/server/portal/faults";
import { loadPortalFaults } from "@/server/portal/load";
import type { PortalFault } from "@/server/portal/queries";
import { requirePortalContext } from "@/server/portal/session";

import { faultStepIndex } from "../_components/hero-model";
import { PortalPage } from "../_components/page-head";
import { dateTimeText } from "../_components/text";
import { FaultForm, type FaultMachine } from "./fault-form";
import { FaultIcon } from "./fault-icons";

export const metadata: Metadata = { title: "Felanmälan" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/**
 * Felanmälan (uppgradering 7): butiken anmäler ett fel i två–tre tryck. Vad som är fel (sex
 * rutor), var på automaten (automaten som den ser ut i butiken, med Skärmen, Betalningen och
 * Luckan att trycka på) och Skicka. Anmälan blir ett ärende hos operatören (incidents,
 * Inkorgen) och syns till höger med stegen Skickad → Sedd → Åtgärdad.
 */
export default async function PortalFaultPage({ searchParams }: { searchParams: SearchParams }) {
  const ctx = await requirePortalContext();
  const sp = await searchParams;
  const requested = Array.isArray(sp.automat) ? sp.automat[0] : sp.automat;
  const { faults, machinesToday, machineNames, screens } = await loadPortalFaults(ctx);
  const open = faults.filter((f) => faultStatus(f.status, f.resolvedAt) !== "resolved");
  const done = faults.filter((f) => faultStatus(f.status, f.resolvedAt) === "resolved");
  const screenOf = new Map(screens.map((s) => [s.machineId, s]));
  const machines: FaultMachine[] = machinesToday.map((m) => {
    const s = screenOf.get(m.machineId);
    return {
      ...m,
      look: s?.look ?? "stjarnor",
      status: s?.status ?? "ok",
      slots: s?.slots ?? [],
    };
  });
  const org = ctx.store.organizationName;
  const tz = ctx.store.timezone;

  return (
    <PortalPage
      id="felanmalan"
      title="Felanmälan"
      sub={`Tryck på det som är fel. ${org} ser anmälan direkt.`}
    >
      <div className="pt-fel">
        <Card title="Anmäl ett fel">
          {machines.length === 0 ? (
            <Empty title="Ingen automat står i butiken i dag, så det finns inget att felanmäla." />
          ) : (
            <CardBody>
              <FaultForm
                storeId={ctx.store.storeId}
                machines={machines}
                initialMachineId={requested}
              />
            </CardBody>
          )}
        </Card>

        <div className="v2-stack">
          <Card
            title="Era anmälningar"
            id="tidigare"
            actions={
              <span className="lk">
                {open.length === 0
                  ? "inga öppna"
                  : `${formatInt(open.length)} ${open.length === 1 ? "öppen" : "öppna"}`}
              </span>
            }
          >
            {faults.length === 0 ? (
              <Empty title="Inga anmälningar än." />
            ) : (
              <ul className="pt-reps">
                {open.map((f) => (
                  <OpenFault
                    key={f.incidentId}
                    fault={f}
                    machine={machineNames[f.machineId] ?? "Automat"}
                    org={org}
                    tz={tz}
                  />
                ))}
                {done.map((f) => (
                  <li key={f.incidentId} className="pt-rep-old">
                    <span aria-hidden className="fi sm">
                      {isFaultKind(f.kind) ? <FaultIcon kind={f.kind} size={20} /> : null}
                    </span>
                    <span className="t">
                      <b>{isFaultKind(f.kind) ? FAULT_LABEL[f.kind] : "Felanmälan"}</b>
                      <span>
                        {machineNames[f.machineId] ?? "Automat"} · anmäld{" "}
                        {dateTimeText(f.reportedAt, tz)}
                      </span>
                      {f.description ? <span className="d">{f.description}</span> : null}
                    </span>
                    <Badge tone="success">Åtgärdad</Badge>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <section className="v2-card pt-urgent" aria-label="Akut fel">
            <span aria-hidden className="fi sm warn">
              <svg viewBox="0 0 24 24" width="20" height="20">
                <path
                  d="M6.5 3.5h3l1.5 4.5-2 1.5a10 10 0 0 0 5.5 5.5l1.5-2 4.5 1.5v3a2 2 0 0 1-2 2A16 16 0 0 1 4.5 5.5a2 2 0 0 1 2-2z"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinejoin="round"
                />
              </svg>
            </span>
            <span className="t">
              <b>Akut, till exempel krossat glas?</b>
              <span>Anmäl här och ring {org} också.</span>
            </span>
          </section>
        </div>
      </div>
    </PortalPage>
  );
}

const STEPS = ["Skickad", "Sedd", "Åtgärdad"] as const;

/** Ett öppet ärende med stegen Skickad → Sedd → Åtgärdad. */
function OpenFault({
  fault,
  machine,
  org,
  tz,
}: {
  fault: PortalFault;
  machine: string;
  org: string;
  tz: string;
}) {
  const status = faultStatus(fault.status, fault.resolvedAt);
  const at = faultStepIndex(status);
  const label = isFaultKind(fault.kind) ? FAULT_LABEL[fault.kind] : "Felanmälan";
  return (
    <li className="pt-rep">
      <div className="pt-rep-top">
        <span aria-hidden className="bigcheck">
          <svg viewBox="0 0 16 16" width="20" height="20">
            <path
              d="M3 8.5l3 3 7-7"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
        <span className="t">
          <b>Skickad {dateTimeText(fault.reportedAt, tz)}</b>
          <span>{at >= 1 ? `${org} har sett den.` : `${org} har fått den.`}</span>
        </span>
      </div>
      <div className="pt-rep-item">
        <span aria-hidden className="fi sm">
          {isFaultKind(fault.kind) ? <FaultIcon kind={fault.kind} size={20} /> : null}
        </span>
        <span className="t">
          <b>{label}</b>
          <span>{machine}</span>
          {fault.description ? <span className="d">{fault.description}</span> : null}
        </span>
      </div>
      <ol className="pt-stepper" aria-label={`Läget: ${STEPS[at]}`}>
        {STEPS.map((s, i) => (
          <li
            key={s}
            data-done={i <= at || undefined}
            data-cur={i === at || undefined}
            aria-current={i === at ? "step" : undefined}
          >
            <span aria-hidden className="sd">
              {i <= at ? (
                <svg viewBox="0 0 16 16" width="15" height="15">
                  <path
                    d="M3 8.5l3 3 7-7"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              ) : null}
            </span>
            <b>{s}</b>
            <span>{i === 0 ? timeText(fault.reportedAt, tz) : i <= at ? "\u00a0" : "väntar"}</span>
          </li>
        ))}
      </ol>
    </li>
  );
}

function timeText(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone, hour: "2-digit", minute: "2-digit" }).format(
    new Date(iso),
  );
}

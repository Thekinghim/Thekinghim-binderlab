import type { Metadata } from "next";

import { SectionHeader } from "@/components/ui/section-header";
import { StateMessage } from "@/components/ui/state-message";
import { StatusTag, type Status } from "@/components/ui/status-tag";
import { formatDateTime, formatInt } from "@/lib/format";
import {
  FAULT_LABEL,
  FAULT_STATUS_LABEL,
  faultStatus,
  isFaultKind,
  type FaultStatus,
} from "@/server/portal/faults";
import { loadPortalFaults } from "@/server/portal/load";
import { requirePortalContext } from "@/server/portal/session";

import { FaultForm } from "./fault-form";

export const metadata: Metadata = { title: "Felanmälan" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const STATUS_TAG: Record<FaultStatus, Status> = {
  open: "warning",
  in_progress: "neutral",
  resolved: "ok",
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
    <div className="flex flex-col">
      <section className="flex flex-col gap-10 py-10 md:py-12" aria-labelledby="felanmalan">
        <SectionHeader
          as="h1"
          id="felanmalan"
          index={1}
          eyebrow="Felanmälan"
          size="xl"
          title={
            open.length === 0
              ? "Inga öppna felanmälningar."
              : `${formatInt(open.length)} ${open.length === 1 ? "felanmälan är" : "felanmälningar är"} öppna.`
          }
          aside={`Anmälan går direkt till ${ctx.store.organizationName}, som ser den i sin inkorg.`}
        />
        <div className="grid gap-x-8 gap-y-12 lg:grid-cols-12">
          <div className="lg:col-span-7">
            {machinesToday.length === 0 ? (
              <StateMessage
                kind="empty"
                message="Ingen automat står i butiken i dag, så det finns inget att felanmäla."
              />
            ) : (
              <FaultForm
                storeId={ctx.store.storeId}
                machines={machinesToday}
                initialMachineId={requested}
              />
            )}
          </div>
          <aside className="flex flex-col gap-3 text-sm text-muted lg:col-span-4 lg:col-start-9">
            <p className="label text-subtle">Bra att veta</p>
            <p>
              Skriv gärna vad som hände och när. Operatören ser automatens försäljning och larm.
            </p>
            <p>
              Har en kund betalat utan att få sitt pack? Skriv tiden och beloppet i beskrivningen.
            </p>
            <p>
              Är det akut, till exempel krossat glas eller fara för någon? Ring operatören också.
            </p>
          </aside>
        </div>
      </section>

      <section
        className="flex flex-col gap-8 border-t border-line py-16"
        aria-labelledby="tidigare"
      >
        <SectionHeader
          id="tidigare"
          index={2}
          eyebrow="Era anmälningar"
          size="md"
          title={
            faults.length === 0
              ? "Inga anmälningar än."
              : `${formatInt(faults.length)} ${faults.length === 1 ? "anmälan" : "anmälningar"}.`
          }
          aside={
            faults.length > 0
              ? `${formatInt(faults.length - open.length)} åtgärdade, ${formatInt(open.length)} öppna.`
              : undefined
          }
        />
        {faults.length === 0 ? (
          <StateMessage kind="empty" message="Butiken har inte gjort någon felanmälan." />
        ) : (
          <ul className="flex flex-col border-t border-line-strong">
            {faults.map((f) => {
              const status = faultStatus(f.status, f.resolvedAt);
              return (
                <li
                  key={f.incidentId}
                  className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-6 gap-y-1 border-b border-line py-4"
                >
                  <div className="flex min-w-0 flex-col gap-1">
                    <span className="text-base text-fg">
                      {isFaultKind(f.kind) ? FAULT_LABEL[f.kind] : "Felanmälan"}
                      <span className="text-subtle">
                        {" "}
                        · {machineNames[f.machineId] ?? "Automat"}
                      </span>
                    </span>
                    {f.description ? (
                      <span className="text-sm break-words text-muted">{f.description}</span>
                    ) : null}
                    <span className="meta text-subtle">
                      Anmäld {formatDateTime(new Date(f.reportedAt))}
                      {f.resolvedAt ? ` · åtgärdad ${formatDateTime(new Date(f.resolvedAt))}` : ""}
                    </span>
                  </div>
                  <StatusTag status={STATUS_TAG[status]}>{FAULT_STATUS_LABEL[status]}</StatusTag>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}

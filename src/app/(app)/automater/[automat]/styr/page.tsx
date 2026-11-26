import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { wallClockIn } from "@/components/shell/period-state";
import { ButtonLink } from "@/components/v2/button";
import { Card } from "@/components/v2/card";
import { Notice } from "@/components/v2/notice";
import { V2Page } from "@/components/v2/shell/page";
import { formatDateTime, formatTime } from "@/lib/format";
import { DEMO_MESSAGES } from "@/server/demo/guard";
import { loadStyrPage, styrBlocked, type StyrLogRow } from "@/server/machine-control/load";
import { timezoneBlock } from "@/server/machine-control/power-schedule";

import { currentViewer } from "../../_lib/session";
import { ConfigCard } from "./_components/config-card";
import { PowerCard } from "./_components/power-card";
import { ScheduleCard } from "./_components/schedule-card";
import { ShipmentCard } from "./_components/shipment-card";
import { SlotsCard } from "./_components/slots-card";

import "../../../drift/_components/ops.css";
import "./styr.css";

export const metadata: Metadata = { title: "Styr automaten" };

type Params = Promise<{ automat: string }>;

const STATUS_TEXT: Record<StyrLogRow["status"], string> = {
  ok: "Klart",
  failed: "Misslyckades",
  unknown: "Okänt",
  pending: "Pågår",
  blocked: "Stoppad",
};

/**
 * Styr automaten: starta om, strömschema, byt pack, mata ut och skärmens reklam via Awish.
 * Bara ägare och admin (andra får 404). En demo visar sidan utan att läsa Awish.
 */
export default async function StyrPage({ params }: { params: Params }) {
  const { automat } = await params;
  const viewer = await currentViewer();
  const data = await loadStyrPage(viewer, decodeURIComponent(automat));
  if (!data) notFound();
  const { machine } = data;
  const back = `/automater/${encodeURIComponent(machine.code.toLowerCase())}`;
  const tz = viewer.organization.timezone;

  const crumb = (
    // Telefon: tillbaka-pilen före rubriken (V2Back) gör samma sak.
    <nav aria-label="Brödsmulor" className="ops-bar max-[900px]:hidden">
      <Link href={back} className="ops-link text-v2-mute">
        <span aria-hidden>← </span>
        {machine.code}
      </Link>
    </nav>
  );

  if (data.kind !== "ready") {
    return (
      <V2Page title="Styr automaten" date={`${machine.code} · ${machine.name}`}>
        <div className="v2-stack">
          {crumb}
          <Notice
            tone="info"
            title={
              data.kind === "demo"
                ? DEMO_MESSAGES.integrations
                : `${machine.code} är inte kopplad till Awish.`
            }
            action={
              data.kind === "not_linked" ? (
                <ButtonLink href="/datakallor" size="sm" touch>
                  Datakällor
                </ButtonLink>
              ) : undefined
            }
          />
        </div>
      </V2Page>
    );
  }

  const now = wallClockIn(new Date(), tz);
  const seen = data.lastSeenAt ? wallClockIn(new Date(data.lastSeenAt), tz) : null;
  const statusText =
    data.online === null
      ? "Okänt läge"
      : data.online
        ? "Online"
        : seen
          ? `Offline · senast ${formatTime(seen)}`
          : "Offline";

  return (
    <V2Page
      title="Styr automaten"
      date={`${machine.code} · ${machine.name}`}
      sub={<b>{statusText}</b>}
    >
      <div className="v2-stack">
        {crumb}
        {data.missingCredentials ? (
          <Notice
            tone="warning"
            title="Awish-inloggningen saknas. Inget kan skickas."
            action={
              <ButtonLink href="/datakallor" size="sm" touch>
                Datakällor
              </ButtonLink>
            }
          >
            {data.missingCredentials}
          </Notice>
        ) : null}
        {data.versionBlocked ? (
          <Notice
            tone="warning"
            title="Awish bytte version. Ändringar via API är pausade."
            action={
              <ButtonLink href="/datakallor" size="sm" touch>
                Datakällor
              </ButtonLink>
            }
          />
        ) : null}
        {data.signFailed ? (
          <Notice
            tone="warning"
            title="Awish godkänner inte vår signering ännu."
            action={
              <ButtonLink href="/datakallor" size="sm" touch>
                Datakällor
              </ButtonLink>
            }
          >
            Skrivningar via API är pausade.
          </Notice>
        ) : null}
        {data.errors.map((e) => (
          <Notice key={e} tone="critical" title={e} />
        ))}

        <PowerCard
          machineId={machine.id}
          code={machine.code}
          online={data.online}
          blocked={styrBlocked(data)}
          versionBlocked={data.versionBlocked}
        />
        <ScheduleCard
          machineId={machine.id}
          store={data.store}
          saved={data.saved}
          timezoneBlock={timezoneBlock(data.merchantTimezone, data.orgTimezone)}
        />
        <SlotsCard machineId={machine.id} slots={data.slots} via={data.slotVia} />
        <ConfigCard machineId={machine.id} config={data.config} />
        <ShipmentCard
          machineId={machine.id}
          code={machine.code}
          slots={data.slots}
          online={data.online}
          versionBlocked={data.versionBlocked}
        />

        <Card title="Logg" id="logg">
          {data.log.length === 0 ? (
            <p className="px-[18px] pt-3 pb-4 text-v2-sm text-v2-mute max-[900px]:px-4">
              Inget skickat ännu.
            </p>
          ) : (
            <ul className="styr-log">
              {data.log.map((r) => (
                <li key={r.id}>
                  <span className="tnum text-v2-mute">
                    {formatDateTime(wallClockIn(new Date(r.at), tz), { now })}
                  </span>
                  <span>{r.who}</span>
                  <span className="min-w-0 truncate">{r.what}</span>
                  <span className={`styr-st ${r.status}`}>{STATUS_TEXT[r.status]}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </V2Page>
  );
}

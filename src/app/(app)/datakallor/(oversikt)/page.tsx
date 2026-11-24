import type { Metadata } from "next";

import { OpenOnHash } from "@/components/ui/open-on-hash";
import { Badge } from "@/components/v2/badge";
import { Card, CardBody } from "@/components/v2/card";
import { Section } from "@/components/v2/section";
import { V2Page } from "@/components/v2/shell/page";
import { SubNav } from "@/components/v2/sub-nav";
import { formatInt } from "@/lib/format";
import { requireRoute } from "@/server/data/core";

import { FoldCard } from "@/app/(app)/installningar/_components/fold-card";
import "@/app/(app)/installningar/_components/settings.css";

import { AwishApiSection } from "../_components/awish-api-section";
import { AwishCard } from "../_components/awish-card";
import { AwishHealthPanel } from "../_components/awish-health-panel";
import { ImportLog } from "../_components/import-log";
import { MachineQueue } from "../_components/machine-queue";
import { SourceList } from "../_components/source-list";
import { UploadPanel } from "../_components/upload-panel";
import { formatWhen, plural } from "../_lib/display";
import { headlineOf } from "../_lib/headline";
import { loadAwishHealthPanelFor } from "../_lib/awish-health-load";
import { loadDatakallorFor } from "../_lib/service";
import { currentViewer } from "../_lib/session";
import { loadAwishPanelFor } from "@/server/awish/manage";
import { DEMO_MESSAGES, isDemoFor } from "@/server/demo/guard";
import { loadAwishExpirySafe } from "@/server/awish/expiry-notice";
import { AwishExpiry } from "@/app/(app)/_awish/awish-expiry";

function CsvLink() {
  return (
    <p className="st-p">
      <a href="#ladda-upp" className="text-v2-ink underline underline-offset-4">
        Har du automater från ett annat märke? Ladda upp försäljning som CSV →
      </a>
    </p>
  );
}

export const metadata: Metadata = { title: "Datakällor" };
/** "Synka nu" och "Testa anslutningen" (server actions på sidan) anropar Awish. */
export const maxDuration = 60;

/**
 * Datakällor: Awish (gRPC-API, hämtas automatiskt var femte minut), varifrån orderna
 * kommer, uppladdning av en orderlista som reserv eller försäljning från ett annat märke
 * (ihopfälld, länkad under Awish), kön för okända
 * automater och loggen över alla importer. Bara ägare och admin (requireRoute skickar
 * andra vidare).
 */
export default async function DatakallorPage() {
  await requireRoute("datakallor");
  const viewer = await currentViewer();
  const [data, awish, demo, awishExpiry] = await Promise.all([
    loadDatakallorFor(viewer),
    loadAwishPanelFor(viewer),
    isDemoFor(viewer.user, viewer.organization.id),
    loadAwishExpirySafe(viewer),
  ]);
  // Om Awish krånglar: hälsan per väg (null vid fel eller utan Awish-nycklar: döljs).
  const awishHealth = awish.source?.credentials
    ? await loadAwishHealthPanelFor(viewer, data.timeZone, new Date(data.now))
    : null;
  const headline = headlineOf(data);
  const fileSources = data.sources.filter((s) => s.acceptsFiles && !s.archived);
  const queuedOrders = data.queue.reduce((sum, q) => sum + q.pendingOrders, 0);
  const lastImport = data.imports[0];
  const nowDate = new Date(data.now);
  const lastFile = data.imports.find((i) => i.trigger === "upload" && i.status === "succeeded");

  const tone = headline.tone === "ok" ? "good" : headline.tone === "neutral" ? undefined : "bad";
  const awishLive = Boolean(awish.source?.credentials) && headline.tone === "ok";

  const orders = data.sources.reduce((n, s) => n + s.orders, 0);
  const lastWhen = lastImport
    ? formatWhen(lastImport.finishedAt ?? lastImport.createdAt, data.timeZone, nowDate)
    : null;

  return (
    <V2Page
      title="Datakällor"
      sub={
        <>
          {awishLive ? (
            <span className="v2-dot mr-1.5 bg-v2-profit align-middle" aria-hidden />
          ) : null}
          <b className={tone === "bad" ? "text-v2-crit-text" : undefined}>{headline.title}</b>{" "}
          {headline.aside ? `${headline.aside} · ` : ""}
          {formatInt(orders)} order
          {data.queue.length > 0 ? ` · ${formatInt(data.queue.length)} att koppla` : ""}
        </>
      }
    >
      <SubNav />
      <div className="v2-stack">
        {data.queue.length > 0 ? (
          <Section
            id="okanda-automater"
            title="Koppla automater"
            sub={queuedOrders > 0 ? `${formatInt(queuedOrders)} order väntar.` : undefined}
          >
            <MachineQueue queue={data.queue} machines={data.machines} timeZone={data.timeZone} />
          </Section>
        ) : null}

        {demo ? (
          // Demo för kunder: inga anrop till Awish med demons data (även spärrat på servern).
          <Card title={<span id="awish">Awish</span>} actions={<Badge>Avstängt i demon</Badge>}>
            <CardBody className="flex flex-col gap-3">
              <p className="st-p">{DEMO_MESSAGES.integrations}</p>
              <CsvLink />
            </CardBody>
          </Card>
        ) : (
          <section aria-labelledby="awish" className="flex flex-col gap-3">
            <h2 id="awish" className="sr-only">
              Awish
            </h2>
            <AwishExpiry notice={awishExpiry} link={false} className="mb-0 max-md:mb-0" />
            <AwishCard source={awish.source} timeZone={data.timeZone} now={data.now} />
            {awishHealth ? <AwishHealthPanel data={awishHealth} /> : null}
            <AwishApiSection viewer={viewer} timeZone={data.timeZone} />
            <CsvLink />
          </section>
        )}

        <OpenOnHash id="ladda-upp" />
        <FoldCard
          id="ladda-upp"
          title="Ladda upp fil"
          aside={
            lastFile
              ? `Senaste ${formatWhen(lastFile.finishedAt ?? lastFile.createdAt, data.timeZone, nowDate)}, ${formatInt(lastFile.rowsNew)} nya av ${plural(lastFile.rowsTotal, "rad", "rader")}`
              : "CSV från Awish eller ett annat märke"
          }
        >
          <CardBody>
            <UploadPanel sources={fileSources} timeZone={data.timeZone} />
          </CardBody>
        </FoldCard>

        <div className="v2-stack" role="region" aria-labelledby="kallor">
          {/* Rubriken i ett kort (som de andra korten), källorna under. */}
          <Card title={<span id="kallor">Källor</span>} count={data.sources.length}>
            <p className="px-[18px] py-3 text-v2-md text-v2-mute">
              {data.queue.length === 0
                ? `Alla automater kopplade${data.lastMapped ? ` · senast ${data.lastMapped.machineCode}` : ""}.`
                : `${formatInt(data.queue.length)} ${data.queue.length === 1 ? "automat väntar" : "automater väntar"} på koppling.`}
            </p>
          </Card>
          <SourceList sources={data.sources} timeZone={data.timeZone} now={data.now} demo={demo} />
        </div>

        <Card
          id="importlogg"
          className="scroll-mt-24"
          title="Importer"
          actions={lastWhen ? <span className="lk">Senast {lastWhen}</span> : undefined}
        >
          <CardBody>
            <ImportLog imports={data.imports} timeZone={data.timeZone} now={data.now} />
          </CardBody>
        </Card>
      </div>
    </V2Page>
  );
}

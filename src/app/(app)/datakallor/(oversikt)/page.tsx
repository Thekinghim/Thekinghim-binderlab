import type { Metadata } from "next";

import { SectionHeader } from "@/components/ui/section-header";
import { formatInt } from "@/lib/format";
import { requireRoute } from "@/server/data/core";

import { AwishCard } from "../_components/awish-card";
import { ImportLog } from "../_components/import-log";
import { MachineQueue } from "../_components/machine-queue";
import { SourceList } from "../_components/source-list";
import { UploadPanel } from "../_components/upload-panel";
import { formatWhen, plural } from "../_lib/display";
import { headlineOf } from "../_lib/headline";
import { loadDatakallorFor } from "../_lib/service";
import { currentViewer } from "../_lib/session";
import { loadAwishPanelFor } from "@/server/awish/manage";

export const metadata: Metadata = { title: "Datakällor" };

/**
 * Datakällor: Awish (gRPC-API, hämtas automatiskt var tionde minut), varifrån orderna
 * kommer, uppladdning av en orderlista som reserv (ihopfälld), kön för okända
 * automater och loggen över alla importer. Bara ägare och admin (requireRoute skickar
 * andra vidare).
 */
export default async function DatakallorPage() {
  await requireRoute("datakallor");
  const viewer = await currentViewer();
  const [data, awish] = await Promise.all([loadDatakallorFor(viewer), loadAwishPanelFor(viewer)]);
  const headline = headlineOf(data);
  const fileSources = data.sources.filter((s) => s.acceptsFiles && !s.archived);
  const queuedOrders = data.queue.reduce((sum, q) => sum + q.pendingOrders, 0);
  const lastImport = data.imports[0];
  const nowDate = new Date(data.now);
  const lastFile = data.imports.find((i) => i.trigger === "upload" && i.status === "succeeded");

  return (
    <div className="mx-auto flex w-full max-w-[1280px] flex-col gap-12 px-4 pt-8 pb-16 md:gap-16 md:px-8 md:pt-12">
      <SectionHeader
        as="h1"
        size="xl"
        eyebrow="Datakällor"
        title={headline.title}
        aside={headline.aside}
        meta={[
          { label: "Källor", value: formatInt(data.sources.filter((s) => !s.archived).length) },
          { label: "Importer", value: formatInt(data.imports.length) },
          { label: "Väntar på koppling", value: formatInt(data.queue.length) },
        ]}
      />

      <section aria-labelledby="awish" className="flex flex-col gap-6">
        <SectionHeader id="awish" index={1} eyebrow="Awish" title="Hämtas automatiskt." />
        <AwishCard source={awish.source} timeZone={data.timeZone} now={data.now} />
      </section>

      <section aria-labelledby="kallor" className="flex flex-col gap-6">
        <SectionHeader
          id="kallor"
          index={2}
          eyebrow="Källor"
          title="Varifrån orderna kommer."
          aside={
            data.sources.length === 0
              ? "Ingen källa ännu."
              : `${formatInt(data.sources.reduce((n, s) => n + s.orders, 0))} order totalt.`
          }
        />
        <SourceList sources={data.sources} timeZone={data.timeZone} now={data.now} />
        <details className="group">
          <summary className="cursor-pointer text-sm text-muted hover:text-fg">
            Ladda upp fil
            {lastFile
              ? ` · senaste ${formatWhen(lastFile.finishedAt ?? lastFile.createdAt, data.timeZone, nowDate)}, ${formatInt(lastFile.rowsNew)} nya av ${plural(lastFile.rowsTotal, "rad", "rader")}`
              : ""}
          </summary>
          <div className="mt-4">
            <UploadPanel sources={fileSources} timeZone={data.timeZone} />
          </div>
        </details>
      </section>

      <section aria-labelledby="okanda-automater" className="flex flex-col gap-6">
        <SectionHeader
          id="okanda-automater"
          index={3}
          eyebrow="Okända automater"
          title={
            data.queue.length === 0
              ? "Alla automater är kopplade."
              : `${formatInt(data.queue.length)} ${data.queue.length === 1 ? "automat" : "automater"} att koppla.`
          }
          aside={
            data.queue.length === 0
              ? data.lastMapped
                ? `Senast kopplad ${data.lastMapped.machineCode}${
                    data.lastMapped.at
                      ? ` ${formatWhen(data.lastMapped.at, data.timeZone, nowDate)}`
                      : ""
                  }.`
                : "Inga okända namn i orderna."
              : queuedOrders === 0
                ? `Inga order väntar på ${data.queue.length === 1 ? "den" : "dem"} ännu.`
                : `${formatInt(queuedOrders)} order räknas inte på någon automat förrän de kopplas.`
          }
        />
        <MachineQueue queue={data.queue} machines={data.machines} timeZone={data.timeZone} />
      </section>

      <section aria-labelledby="importlogg" className="flex flex-col gap-6">
        <SectionHeader
          id="importlogg"
          index={4}
          eyebrow="Importlogg"
          title="Alla importer."
          aside={
            lastImport
              ? `Senast ${formatWhen(lastImport.finishedAt ?? lastImport.createdAt, data.timeZone, nowDate)}${lastImport.createdBy ? ` av ${lastImport.createdBy}` : ""}.`
              : "Ingen import ännu."
          }
        />
        <ImportLog imports={data.imports} timeZone={data.timeZone} now={data.now} />
      </section>
    </div>
  );
}

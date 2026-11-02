import type { Metadata } from "next";

import { SectionHeader } from "@/components/ui/section-header";
import { formatInt } from "@/lib/format";
import { requireRoute } from "@/server/data/core";

import { ImportLog } from "./_components/import-log";
import { MachineQueue } from "./_components/machine-queue";
import { SourceList } from "./_components/source-list";
import { UploadPanel } from "./_components/upload-panel";
import { formatWhen } from "./_lib/display";
import { headlineOf } from "./_lib/headline";
import { loadDatakallorFor } from "./_lib/service";
import { currentViewer } from "./_lib/session";

export const metadata: Metadata = { title: "Datakällor" };

/**
 * Datakällor: varifrån orderna kommer, hur färska de är, uppladdning av Awish
 * orderlista (förhandsvisning och import), kön för okända automater och loggen
 * över alla importer. Bara ägare och admin (requireRoute skickar andra vidare).
 */
export default async function DatakallorPage() {
  await requireRoute("datakallor");
  const data = await loadDatakallorFor(await currentViewer());
  const headline = headlineOf(data);
  const fileSources = data.sources.filter((s) => s.acceptsFiles && !s.archived);
  const queuedOrders = data.queue.reduce((sum, q) => sum + q.pendingOrders, 0);
  const lastImport = data.imports[0];

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

      <section aria-labelledby="kallor" className="flex flex-col gap-6">
        <SectionHeader
          id="kallor"
          index={1}
          eyebrow="Källor"
          title="Varifrån orderna kommer."
          aside={
            data.sources.length === 0
              ? "Ingen källa ännu."
              : `${formatInt(data.sources.reduce((n, s) => n + s.orders, 0))} order totalt.`
          }
        />
        <SourceList sources={data.sources} timeZone={data.timeZone} now={data.now} />
      </section>

      <section aria-labelledby="ladda-upp" className="flex flex-col gap-6">
        <SectionHeader
          id="ladda-upp"
          index={2}
          eyebrow="Ladda upp"
          title="Importera orderlistan."
          aside="Förhandsvisa först, inget sparas förrän du bekräftar."
          description="Exportera orderlistan i Awish som CSV. Hela historiken går bra (upp till 50 MB): order som redan finns räknas som dubbletter och ändras aldrig."
        />
        <UploadPanel sources={fileSources} timeZone={data.timeZone} />
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
              ? "Nya namn från Awish hamnar här."
              : queuedOrders === 0
                ? "Inga order väntar på dem ännu."
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
              ? `Senast ${formatWhen(lastImport.finishedAt ?? lastImport.createdAt, data.timeZone, new Date(data.now))}${lastImport.createdBy ? ` av ${lastImport.createdBy}` : ""}.`
              : "Ingen import ännu."
          }
        />
        <ImportLog imports={data.imports} timeZone={data.timeZone} now={data.now} />
      </section>
    </div>
  );
}

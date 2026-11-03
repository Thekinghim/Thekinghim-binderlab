import type { Metadata } from "next";
import type { CSSProperties } from "react";

import { OpenOnHash } from "@/components/ui/open-on-hash";
import { SectionHeader } from "@/components/ui/section-header";
import { formatInt } from "@/lib/format";
import { requireRoute } from "@/server/data/core";

import { MerHead } from "@/app/(app)/installningar/_components/mer-head";

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
/** "Synka nu" och "Testa anslutningen" (server actions på sidan) anropar Awish. */
export const maxDuration = 60;

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

  const tone = headline.tone === "ok" ? "good" : headline.tone === "neutral" ? undefined : "bad";
  const awishLive = Boolean(awish.source?.credentials) && headline.tone === "ok";

  return (
    <div className="mx-auto flex w-full max-w-[1280px] flex-col gap-12 px-4 pt-8 pb-16 md:gap-14 md:px-8 md:pt-12">
      <MerHead
        eyebrow="Datakällor"
        title={headline.title}
        line={headline.aside || undefined}
        tone={tone}
        live={awishLive}
        count={data.queue.length > 0}
        meta={[
          { label: "Order", value: formatInt(data.sources.reduce((n, s) => n + s.orders, 0)) },
          { label: "Att koppla", value: formatInt(data.queue.length) },
        ]}
      />

      {data.queue.length > 0 ? (
        <section
          aria-labelledby="okanda-automater"
          className="rise flex flex-col gap-6"
          style={{ "--i": 1 } as CSSProperties}
        >
          <SectionHeader
            id="okanda-automater"
            title="Koppla automater."
            aside={queuedOrders > 0 ? `${formatInt(queuedOrders)} order väntar.` : undefined}
          />
          <MachineQueue queue={data.queue} machines={data.machines} timeZone={data.timeZone} />
        </section>
      ) : null}

      <section
        aria-labelledby="awish"
        className="rise flex flex-col gap-6"
        style={{ "--i": 2 } as CSSProperties}
      >
        <SectionHeader id="awish" title="Awish." aside="Hämtas automatiskt." />
        <AwishCard source={awish.source} timeZone={data.timeZone} now={data.now} />
      </section>

      <OpenOnHash id="ladda-upp" />
      <details
        id="ladda-upp"
        className="rise scroll-mt-28 rounded-md border border-line bg-surface p-4 md:p-5"
        style={{ "--i": 3 } as CSSProperties}
      >
        <summary className="cursor-pointer list-none">
          <SectionHeader
            id="kallor"
            size="md"
            title="Mer."
            aside={`Källor, fil, importer${lastImport ? ` · senast ${formatWhen(lastImport.finishedAt ?? lastImport.createdAt, data.timeZone, nowDate)}` : ""}.`}
          />
        </summary>
        <div className="mt-6 flex flex-col gap-10">
          <section aria-label="Källor" className="flex flex-col gap-4">
            <h3 className="label text-subtle">Källor</h3>
            <SourceList sources={data.sources} timeZone={data.timeZone} now={data.now} />
          </section>
          <section aria-label="Ladda upp fil" className="flex flex-col gap-4">
            <h3 className="label text-subtle">
              Ladda upp fil
              {lastFile
                ? ` · senaste ${formatWhen(lastFile.finishedAt ?? lastFile.createdAt, data.timeZone, nowDate)}, ${formatInt(lastFile.rowsNew)} nya av ${plural(lastFile.rowsTotal, "rad", "rader")}`
                : ""}
            </h3>
            <UploadPanel sources={fileSources} timeZone={data.timeZone} />
          </section>
          {data.queue.length === 0 ? (
            <p className="text-sm text-muted">
              Alla automater kopplade
              {data.lastMapped ? ` · senast ${data.lastMapped.machineCode}` : ""}.
            </p>
          ) : null}
          <section aria-label="Importer" className="flex flex-col gap-4">
            <h3 className="label text-subtle">Importer</h3>
            <ImportLog imports={data.imports} timeZone={data.timeZone} now={data.now} />
          </section>
        </div>
      </details>
    </div>
  );
}

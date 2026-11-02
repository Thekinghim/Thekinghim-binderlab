import { headers } from "next/headers";

import { SectionHeader } from "@/components/ui/section-header";
import { getServerEnv } from "@/lib/env";
import { loadExtensionPanelFor } from "@/server/ingest/manage";
import { resolveAppBaseUrl } from "@/server/request-info";

import { formatWhen } from "../_lib/display";
import { currentViewer } from "../_lib/session";
import { ExtensionPanel } from "./extension-panel";

/** Sökvägen till tilläggets zip (byggs av scripts/extension/build.mjs). */
export const EXTENSION_ZIP_PATH = "/downloads/binderlab-awish-sync.zip";

function appBaseUrl(requestHeaders: Headers): string {
  try {
    return resolveAppBaseUrl(getServerEnv(), requestHeaders);
  } catch {
    return "";
  }
}

/**
 * Datakällor → "Automatisk synk (Chrome-tillägg)": Binderlabs Chrome-tillägg läser
 * Awish orderlista med användarens inloggning och skickar ordrarna hit, så att ingen
 * behöver ladda ner något från Awish. Datakällor, tokens, status och installationen.
 * Se docs/awish-tillagg.md.
 */
export async function ExtensionSection({ index }: { index: number }) {
  const viewer = await currentViewer();
  const [data, requestHeaders] = await Promise.all([loadExtensionPanelFor(viewer), headers()]);
  const active = data.sources.filter((s) => !s.archived);
  const last = active
    .map((s) => s.tokens.map((t) => t.lastSeenAt).filter((v): v is string => v !== null))
    .flat()
    .sort()
    .at(-1);
  const now = new Date(data.now);
  const tz = viewer.organization.timezone;

  return (
    <section aria-labelledby="automatisk-synk" className="flex flex-col gap-6">
      <SectionHeader
        id="automatisk-synk"
        index={index}
        eyebrow="Automatisk synk (Chrome-tillägg)"
        title={
          active.length === 0
            ? "Hämta ordrarna automatiskt."
            : active.some((s) => s.silent)
              ? "Synken har stannat."
              : "Ordrarna hämtas automatiskt."
        }
        aside={
          active.length === 0
            ? "Inget tillägg kopplat ännu."
            : last
              ? `Senaste kontakt ${formatWhen(last, tz, now)}.`
              : "Väntar på första synken."
        }
        description="Binderlabs Chrome-tillägg läser orderlistan i Awish med din inloggning var tionde minut och skickar nya ordrar hit. Du behöver aldrig exportera eller ladda upp något. Tillägget skickar bara till Binderlab."
      />
      <ExtensionPanel
        sources={data.sources}
        timeZone={tz}
        now={data.now}
        appUrl={appBaseUrl(requestHeaders)}
        zipPath={EXTENSION_ZIP_PATH}
        silenceMinutes={data.silenceMinutes}
      />
    </section>
  );
}

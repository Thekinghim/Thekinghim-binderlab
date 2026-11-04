/**
 * En rad i Att göra när månadens bokföringspaket är sparat och månaden inte är markerad
 * som skickad: "Bokföring för oktober 2026 är klar att ladda ner." Preliminärt paket: en
 * rad om varför. Bara ägare och admin (readyPackageFor ger null för andra).
 */

import Link from "next/link";

import type { Viewer } from "@/server/data/core/loaders";
import { readyPackageFor, type ReadyLine } from "@/server/bokforing/stored";

import { monthText } from "../_lib/view";

export async function BokforingReady({
  viewer,
  preloaded,
}: {
  viewer: Viewer;
  /** Redan läst av sidan (Att göra räknar raden i rubriken); utelämnad = läs här. */
  preloaded?: ReadyLine | null;
}) {
  const ready = preloaded !== undefined ? preloaded : await readyPackageFor(viewer);
  if (!ready) return null;
  const month = monthText(ready.month);
  const final = ready.status === "final";
  return (
    <section
      aria-label="Bokföring"
      className="rise mb-6 flex flex-wrap items-center justify-between gap-3 rounded-md border border-line bg-surface px-4 py-3 max-md:mb-4 max-md:flex-nowrap max-md:rounded-none max-md:border-x-0 max-md:border-t-0 max-md:bg-transparent max-md:px-0 max-md:py-1"
    >
      <p className="text-base text-fg max-md:line-clamp-2 max-md:min-w-0 max-md:text-sm">
        {final
          ? `Bokföring för ${month} är klar att ladda ner.`
          : `Bokföring för ${month} är preliminär: ${ready.reason ?? "underlaget är inte klart."}`}
      </p>
      <span className="flex items-center gap-3 text-sm max-md:shrink-0 max-md:[&>a]:inline-flex max-md:[&>a]:min-h-11 max-md:[&>a]:items-center">
        <a
          href={`/ekonomi/bokforing/paket?manad=${ready.month}`}
          download
          className="font-medium text-fg underline-offset-2 hover:underline"
        >
          Ladda ner
        </a>
        <Link
          href="/ekonomi?vy=bokforing"
          className="text-muted underline-offset-2 hover:underline"
        >
          Bokföring
        </Link>
      </span>
    </section>
  );
}

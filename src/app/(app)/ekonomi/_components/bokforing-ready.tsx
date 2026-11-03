/**
 * En rad i Att göra när månadens bokföringspaket är sparat och månaden inte är markerad
 * som skickad: "Bokföring för oktober 2026 är klar att ladda ner." Preliminärt paket: en
 * rad om varför. Bara ägare och admin (readyPackageFor ger null för andra).
 */

import Link from "next/link";

import type { Viewer } from "@/server/data/core/loaders";
import { readyPackageFor } from "@/server/bokforing/stored";

import { monthText } from "../_lib/view";

export async function BokforingReady({ viewer }: { viewer: Viewer }) {
  const ready = await readyPackageFor(viewer);
  if (!ready) return null;
  const month = monthText(ready.month);
  const final = ready.status === "final";
  return (
    <section
      aria-label="Bokföring"
      className="rise mb-6 flex flex-wrap items-center justify-between gap-3 rounded-md border border-line bg-surface px-4 py-3"
    >
      <p className="text-base text-fg">
        {final
          ? `Bokföring för ${month} är klar att ladda ner.`
          : `Bokföring för ${month} är preliminär: ${ready.reason ?? "underlaget är inte klart."}`}
      </p>
      <span className="flex items-center gap-3 text-sm">
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

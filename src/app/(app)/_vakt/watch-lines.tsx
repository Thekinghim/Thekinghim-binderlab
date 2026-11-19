import Link from "next/link";

import type { WatchLine } from "@/analytics/watch";
import { requireViewer } from "@/server/data/core";
import { loadWatchFor } from "@/server/monitoring/watch";

/**
 * Vakten på Hem och Drift: en rad för varje sak som gör att ägaren inte får veta när något
 * går sönder ("Ingen får larm just nu", "Kontrollen har inte körts sedan …",
 * "Försäljningen har inte hämtats sedan …"). Räknas ur databasen när sidan öppnas, så den
 * syns även när inget schemalagt jobb körs. Ingenting när allt fungerar, och ingenting för
 * andra än ägare och admin. Ett fel här stoppar aldrig sidan.
 */
export async function WatchLines({ className }: { className?: string }) {
  const lines = await requireViewer()
    .then((viewer) => loadWatchFor(viewer))
    .catch((): WatchLine[] => []);
  if (lines.length === 0) return null;
  return (
    <ul className={className} data-watch={lines.map((l) => l.key).join(" ")}>
      {lines.map((line) => (
        <li key={line.key} className="mt-2 first:mt-0">
          <Link
            href={line.href}
            role="alert"
            className="group flex min-h-11 items-start justify-between gap-3 rounded-sm border border-signal-line bg-surface px-4 py-3 hover:bg-hover"
          >
            <span className="flex min-w-0 items-start gap-2.5">
              <span aria-hidden className="mt-2 inline-block size-2 shrink-0 bg-signal" />
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="text-base text-fg">{line.title}</span>
                <span className="text-sm text-muted">{line.detail}</span>
              </span>
            </span>
            <span className="shrink-0 text-sm whitespace-nowrap text-muted transition-colors group-hover:text-fg max-md:hidden">
              {`${line.action} →`}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

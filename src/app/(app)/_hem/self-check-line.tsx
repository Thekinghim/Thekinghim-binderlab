import Link from "next/link";

import { homeLine, homeLink } from "@/analytics/self-check";
import { requireViewer } from "@/server/data/core";
import { latestSelfCheckFor } from "@/server/self-check/service";

/**
 * Daglig kontroll på Hem: en rad bara när senaste kontrollen hittade fel ("Kontrollen
 * hittade 2 fel →", till Inställningar → Kontroll) eller när en inställning gör vinsten
 * för hög ("Kortavgiften står på 0 % →", till Inställningar). Ingenting när allt stämmer, och
 * ingenting för läsaren (resultaten syns bara för ägare och admin, RLS). Ett fel här
 * stoppar aldrig Hem.
 */
export async function SelfCheckLine({ className }: { className?: string }) {
  const run = await requireViewer()
    .then(latestSelfCheckFor)
    .catch(() => null);
  const text = homeLine(run);
  if (!text) return null;
  return (
    <div className={className}>
      <Link
        href={homeLink(run)}
        className="group flex min-h-11 items-center justify-between gap-3 rounded-sm border border-signal-line bg-surface px-4 py-2.5 text-base text-fg hover:bg-hover"
        data-self-check="failed"
      >
        <span className="flex items-center gap-2.5">
          <span aria-hidden className="inline-block size-2 shrink-0 bg-signal" />
          {text}
        </span>
        <span aria-hidden className="text-subtle transition-colors group-hover:text-fg">
          →
        </span>
      </Link>
    </div>
  );
}

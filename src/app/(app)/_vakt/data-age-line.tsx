import Link from "next/link";

import { requireViewer } from "@/server/data/core";
import { loadMachineAgeFor } from "@/server/monitoring/watch";

/**
 * Hur gammal datan är, per automat (Hem): "Data från Awish: alla 4 automater, 3 min
 * sedan." När någon automat släpar nämns den vid namn med sin ålder ("Gammal data från
 * Awish: BL-003 2 tim 10 min sedan. Övriga 3 min sedan."). Åldern är tiden sedan automaten
 * senast sågs i en lyckad hämtning, inte när sidan laddades. Ingenting utan Awish-automater.
 */
export async function DataAgeLine({ className }: { className?: string }) {
  const age = await requireViewer()
    .then((viewer) => loadMachineAgeFor(viewer))
    .catch(() => null);
  if (!age) return null;
  return (
    <p
      className={className}
      data-data-age={age.stale ? "stale" : "fresh"}
      title={age.ages.map((a) => `${a.label}: ${a.text}`).join(" · ")}
    >
      {age.stale ? (
        <Link
          href="/datakallor"
          className="inline-flex min-h-11 items-center gap-2.5 rounded-sm border border-signal-line bg-surface px-4 py-2.5 text-base text-fg hover:bg-hover"
        >
          <span aria-hidden className="inline-block size-2 shrink-0 bg-signal" />
          {age.text}
        </Link>
      ) : (
        <span className="meta text-subtle">{age.text}</span>
      )}
    </p>
  );
}

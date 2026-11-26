import Link from "next/link";

import { requireViewer } from "@/server/data/core";
import { loadAwishFreshnessFor, loadMachineAgeFor } from "@/server/monitoring/watch";

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
          prefetch={false}
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

/**
 * Hur färsk Awish-datan är (Drift): "Försäljning 14:52 · Lager 14:50 (via webbpanelen)", och
 * för ägare och admin en lugn rad per väg där reservvägen fungerar just nu ("Lager i
 * automaterna: via webbpanelen sedan 03:05 (Open API: Awish internt fel)."). Inget larm: det
 * Binderlab redan har löst ska inte störa. Ingenting utan Awish-källa; ett fel döljer raden.
 */
export async function AwishFreshnessLine({ className }: { className?: string }) {
  const f = await requireViewer()
    .then((viewer) => loadAwishFreshnessFor(viewer))
    .catch(() => null);
  if (!f || (!f.text && f.status.length === 0)) return null;
  return (
    <div className={className} data-awish-freshness>
      {f.text ? <p className="meta text-subtle">{f.text}</p> : null}
      {f.status.length > 0 ? (
        <ul className="mt-1 flex flex-col gap-0.5" data-awish-reserv>
          {f.status.map((s) => (
            <li key={s.key} className="text-sm text-muted">
              <Link prefetch={false} href="/datakallor#awish-halsa" className="hover:text-fg">
                {s.text}
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/**
 * Bannern på Hem när försäljningen inte har hämtats på 30 min: "Försäljningen är inte
 * uppdaterad sedan 14:52. Awish svarar inte. Ladda upp orderlistan i Datakällor." Bara
 * ägare och admin. Ingenting när allt fungerar; ett fel döljer bannern.
 */
export async function AwishOrdersBanner({ className }: { className?: string }) {
  const f = await requireViewer()
    .then((viewer) => loadAwishFreshnessFor(viewer))
    .catch(() => null);
  if (!f?.banner) return null;
  return (
    <p className={className} data-awish-banner>
      <Link
        prefetch={false}
        href="/datakallor#ladda-upp"
        role="alert"
        className="inline-flex min-h-11 w-full items-center gap-2.5 rounded-sm border border-signal-line bg-surface px-4 py-2.5 text-base text-fg hover:bg-hover"
      >
        <span aria-hidden className="inline-block size-2 shrink-0 bg-signal" />
        {f.banner}
      </Link>
    </p>
  );
}

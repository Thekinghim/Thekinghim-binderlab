/**
 * Platshållarsida: rätt rubrik, en mono-rad och ingenting annat.
 * Ingen illustration, ingen tom-ikon. Server Component.
 */
export function ComingSoonPage({
  title,
  phase,
  lead,
}: {
  /** Sidans namn, t.ex. "Lönsamhet". */
  title: string;
  /** Fasen då sidan byggs, t.ex. 4 eller "4". */
  phase: number | string;
  /** Valfri andra del av rubriken (tvådelad rubrik), t.ex. "Per automat och butik." */
  lead?: string;
}) {
  return (
    <div className="mx-auto w-full max-w-[1280px] px-4 pt-8 pb-16 md:px-8 md:pt-12">
      <h1 className="text-2xl font-medium text-balance text-fg md:text-3xl">
        {title}
        {lead ? <span className="text-subtle"> {lead}</span> : null}
      </h1>
      <p className="label mt-4 flex items-center gap-3 border-t border-line pt-3 text-subtle">
        <span className="tnum text-muted">Fas {phase}</span>
        <span aria-hidden className="h-px w-6 bg-line-strong" />
        <span>Byggs, inget att visa än</span>
      </p>
    </div>
  );
}

import type { ReactNode } from "react";

/**
 * Rubriken för ett avsnitt på Marknad (V2): ett kort med avsnittets namn i rubrikraden,
 * knappar till höger och läget i en grå rad under. Namnet står i rubriken, meningen i raden
 * under (ingen etikett ovanför, "eyebrow").
 */
export function SectionHead({
  id,
  eyebrow,
  title,
  aside,
  actions,
}: {
  id?: string;
  /** Avsnittets namn ("Releasekalender"). Utan: meningen är rubriken. */
  eyebrow?: string;
  title: ReactNode;
  aside?: ReactNode;
  actions?: ReactNode;
}) {
  // Ett kort med avsnittets namn i rubrikraden (som korten på Pengar) och läget i en rad
  // under, i stället för en rubrik som står fritt ovanför avsnittets kort.
  return (
    <div className="v2-card">
      <div className="v2-card-hd">
        <h2 id={id}>{eyebrow ?? title}</h2>
        {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
      {eyebrow || aside ? (
        <p className="px-[18px] py-3 text-v2-md text-v2-mute">
          {eyebrow ? (
            <>
              <span className="font-[550] text-v2-ink">{title}</span>
              {aside ? " " : null}
            </>
          ) : null}
          {aside}
        </p>
      ) : null}
    </div>
  );
}

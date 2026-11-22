import type { ReactNode } from "react";

/**
 * Rubriken för ett avsnitt på Marknad (V2, som Section i src/components/v2): avsnittets namn
 * 16 px halvfet, läget i en grå rad under och knappar till höger. Ersätter SectionHeader
 * med etikett ovanför ("eyebrow"): namnet står i rubriken, meningen i raden under.
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
  return (
    <div className="v2-section-hd">
      <div className="min-w-0">
        <h2 id={id}>{eyebrow ?? title}</h2>
        {eyebrow || aside ? (
          <p>
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
      {actions ? <div className="acts">{actions}</div> : null}
    </div>
  );
}

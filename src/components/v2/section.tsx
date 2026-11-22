import type { ReactNode } from "react";

import { cn } from "@/lib/cn";

/**
 * Rubrik för en grupp kort på en V2-sida (utanför korten): 16 px halvfet rubrik, en grå rad
 * under och åtgärder till höger. Inne i ett kort används Card-rubriken i stället.
 *
 *   <Section title="Avtal" sub="3 butiker · 1 löper ut i december" actions={<Button>Nytt</Button>}>
 *     <Card>…</Card>
 *   </Section>
 *
 * Inga versaletiketter och ingen "eyebrow": rubriken säger vad det är, raden under säger läget.
 */
export function Section({
  title,
  sub,
  actions,
  children,
  className,
  id,
  as: Tag = "h2",
}: {
  title: ReactNode;
  /** En rad under rubriken (13 px grå), helst med ett tal. */
  sub?: ReactNode;
  /** Knappar eller en länk till höger. */
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
  id?: string;
  as?: "h2" | "h3";
}) {
  return (
    <section className={cn("v2-section", className)} aria-labelledby={id}>
      <div className="v2-section-hd">
        <div className="min-w-0">
          <Tag id={id}>{title}</Tag>
          {sub ? <p>{sub}</p> : null}
        </div>
        {actions ? <div className="acts">{actions}</div> : null}
      </div>
      {children}
    </section>
  );
}

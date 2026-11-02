import type { ReactNode } from "react";
import { SectionHeader, type SectionMeta } from "@/components/ui/section-header";
import { cn } from "@/lib/cn";

/** Luft per sektion: tät för referens (typ, mått), rymlig där siffrorna är huvudperson. */
export type SectionAir = "tight" | "base" | "loose";

const air: Record<SectionAir, string> = {
  tight: "py-12",
  base: "py-16",
  loose: "py-16 md:py-24",
};

/**
 * En sektion på /design: etikett "01 / ORDMÄRKE", tvådelad rubrik med fakta
 * och ett 12-kolumnsrutnät som varje sektion fördelar på sitt eget sätt.
 */
export function SpecSection({
  id,
  index,
  eyebrow,
  title,
  aside,
  meta,
  actions,
  space = "base",
  tiles,
  children,
  className,
}: {
  id: string;
  index: number;
  eyebrow: string;
  title: string;
  aside?: string;
  meta?: ReadonlyArray<SectionMeta> | ReactNode;
  actions?: ReactNode;
  space?: SectionAir;
  /** Tätt rutnät (4 px-steg × 4) för sektioner som består av paneler. */
  tiles?: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      id={id}
      aria-labelledby={`${id}-title`}
      className={cn("scroll-mt-28 border-t border-line", air[space])}
    >
      <SectionHeader
        id={`${id}-title`}
        index={index}
        eyebrow={eyebrow}
        title={title}
        aside={aside}
        meta={meta}
        actions={actions}
      />
      <div
        className={cn(
          "mt-10 grid grid-cols-1 md:mt-12 lg:grid-cols-12",
          tiles ? "gap-4" : "gap-x-8 gap-y-12",
          className,
        )}
      >
        {children}
      </div>
    </section>
  );
}

/**
 * Underavsnitt utan ram: en hårfin linje, etikett med mått i mono
 * ("07.2 / INTÄKT TILL VINST · 30 D") och en mening med en siffra i fg.
 */
export function Sub({
  index,
  label,
  meta,
  title,
  children,
  className,
  id,
}: {
  index?: string;
  label: string;
  meta?: ReactNode;
  title?: ReactNode;
  children: ReactNode;
  className?: string;
  id?: string;
}) {
  return (
    <div className={cn("flex min-w-0 flex-col", className)}>
      <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-t border-line pt-3">
        <p className="label min-w-0 text-subtle">
          {index ? (
            <>
              <span className="tnum text-fg">{index}</span>
              <span aria-hidden className="text-faint">
                {" / "}
              </span>
            </>
          ) : null}
          {label}
        </p>
        {meta ? <p className="meta tnum text-subtle">{meta}</p> : null}
      </div>
      {title ? (
        <h3 id={id} className="mt-2 text-md font-medium text-balance text-fg">
          {title}
        </h3>
      ) : null}
      <div className={cn(title ? "mt-5" : "mt-4", "min-w-0")}>{children}</div>
    </div>
  );
}

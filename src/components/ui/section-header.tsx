import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

export type SectionHeaderSize = "xl" | "lg" | "md" | "sm";

/** En rad i metadatablocket: mono-etikett till vänster, värde till höger. */
export type SectionMeta = { label: string; value: ReactNode };

type SectionHeaderProps = {
  /** Sektionsnummer, t.ex. 1 → "01", eller "06.1" för undersektion. Utelämnas för mindre rubriker. */
  index?: number | string;
  /** Kategori i versaler, t.ex. "Försäljning" */
  eyebrow?: string;
  /** Första, ljusa delen av rubriken */
  title: string;
  /** Andra, grå delen av rubriken. Helst ett faktum med siffra, inte en fyllnadsfras. */
  aside?: string;
  description?: string;
  /**
   * Metadata i mono, högerställt i kolumn 9–12 från lg (under rubriken på
   * mindre skärmar). Lista med etikett/värde eller fritt innehåll.
   */
  meta?: ReadonlyArray<SectionMeta> | ReactNode;
  actions?: ReactNode;
  as?: "h1" | "h2" | "h3" | "h4";
  /** xl 32/44 px · lg 24/32 px (standard) · md 20 px · sm 16 px */
  size?: SectionHeaderSize;
  className?: string;
  id?: string;
};

const titleSize: Record<SectionHeaderSize, string> = {
  xl: "text-2xl lg:text-3xl",
  lg: "text-xl md:text-2xl",
  md: "text-lg",
  sm: "text-md",
};

function isMetaList(meta: SectionHeaderProps["meta"]): meta is ReadonlyArray<SectionMeta> {
  return Array.isArray(meta);
}

/**
 * "01 / FÖRSÄLJNING" följt av tvådelad rubrik: "Intäkt per dag. Bästa dagen var 26 okt."
 * Från lg ligger rubriken i kolumn 1–8 och metadata/åtgärder i kolumn 9–12.
 * Metadatablocket toppställs mot etiketten; åtgärderna står alltid sist.
 */
export function SectionHeader({
  index,
  eyebrow,
  title,
  aside,
  description,
  meta,
  actions,
  as: Tag = "h2",
  size = "lg",
  className,
  id,
}: SectionHeaderProps) {
  const hasEyebrow = index !== undefined || Boolean(eyebrow);
  const hasSide = Boolean(meta) || Boolean(actions);
  const small = size === "md" || size === "sm";

  return (
    <header
      className={cn(
        "grid min-w-0 grid-cols-1 gap-x-8",
        small ? "gap-y-3" : "gap-y-4",
        hasSide && "lg:grid-cols-12",
        // Med metadata linjerar blockets första linje med etiketten "05 / …";
        // med bara åtgärder står knapparna i höjd med rubrikens nederkant.
        hasSide && (meta ? "lg:items-start" : "lg:items-end"),
        className,
      )}
    >
      <div
        className={cn(
          "flex max-w-3xl min-w-0 flex-col",
          small ? "gap-2" : "gap-3",
          hasSide && "lg:col-span-8",
        )}
      >
        {hasEyebrow ? (
          <p className="label flex items-center gap-2 text-subtle">
            {index !== undefined ? (
              <span className="tnum text-fg">
                {typeof index === "number" ? String(index).padStart(2, "0") : index}
              </span>
            ) : null}
            {index !== undefined && eyebrow ? (
              <span aria-hidden className="text-faint">
                /
              </span>
            ) : null}
            {eyebrow ? <span>{eyebrow}</span> : null}
          </p>
        ) : null}
        <Tag id={id} className={cn("font-medium text-balance hyphens-none", titleSize[size])}>
          <span className="text-fg">{title}</span>
          {aside ? <span className="text-subtle"> {aside}</span> : null}
        </Tag>
        {description ? (
          <p className={cn("max-w-xl text-muted", small ? "text-sm" : "text-base")}>
            {description}
          </p>
        ) : null}
      </div>

      {hasSide ? (
        <div className="flex min-w-0 flex-col gap-3 lg:col-span-4 lg:col-start-9">
          {meta ? (
            isMetaList(meta) ? (
              <dl className="flex flex-col">
                {meta.map((m) => (
                  <div
                    key={m.label}
                    className="flex items-baseline justify-between gap-4 border-t border-line py-1.5 last:border-b"
                  >
                    <dt className="label shrink-0 text-subtle">{m.label}</dt>
                    <dd className="meta tnum min-w-0 truncate text-right text-fg">{m.value}</dd>
                  </div>
                ))}
              </dl>
            ) : (
              <div className="meta tnum text-muted lg:text-right">{meta}</div>
            )
          ) : null}
          {actions ? (
            <div className="flex flex-wrap items-center gap-2 lg:justify-end">{actions}</div>
          ) : null}
        </div>
      ) : null}
    </header>
  );
}

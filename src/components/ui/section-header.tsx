import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

export type SectionHeaderSize = "xl" | "lg" | "md" | "sm";

/** En rad i metadatablocket: mono-etikett till vänster, värde till höger. */
export type SectionMeta = { label: string; value: ReactNode };

type SectionHeaderProps = {
  /**
   * @deprecated Sektionsnummer ("01 / …") visas inte längre: de gjorde sidorna
   * tyngre utan att hjälpa. Propen finns kvar så att äldre anrop kompilerar.
   */
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
  /** Under md: dölj den grå delen (t.ex. när samma tal står under diagrammet). */
  hideAsideOnMobile?: boolean;
};

const titleSize: Record<SectionHeaderSize, string> = {
  // Under 400 px (iPhone SE och mini): ett steg mindre, så att rubriken ryms på två rader.
  xl: "text-2xl max-[399px]:text-xl lg:text-3xl",
  lg: "text-xl md:text-2xl",
  md: "text-lg",
  sm: "text-md",
};

function isMetaList(meta: SectionHeaderProps["meta"]): meta is ReadonlyArray<SectionMeta> {
  return Array.isArray(meta);
}

/**
 * "FÖRSÄLJNING" följt av tvådelad rubrik: "Intäkt per dag. Bästa dagen var 26 okt."
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
  hideAsideOnMobile = false,
}: SectionHeaderProps) {
  void index;
  const hasEyebrow = Boolean(eyebrow);
  const hasSide = Boolean(meta) || Boolean(actions);
  const small = size === "md" || size === "sm";
  // Sidans namn står redan i underfliken: under md visas en etikett över h1 bara när den
  // säger något mer (t.ex. "Hem · BL-001").
  const eyebrowRepeatsTab = Tag === "h1" && !eyebrow?.includes("·");

  return (
    <header
      className={cn(
        "grid min-w-0 grid-cols-1 gap-x-8",
        small ? "gap-y-3" : "gap-y-4",
        hasSide && "lg:grid-cols-12",
        // Med metadata linjerar blockets första linje med etiketten;
        // med bara åtgärder står knapparna i höjd med rubrikens nederkant.
        hasSide && (meta ? "lg:items-start" : "lg:items-end"),
        // Liten rubrik med bara åtgärder: under md på samma rad som rubriken ("Mest sålda.  Alla →").
        small &&
          Boolean(actions) &&
          !meta &&
          !description &&
          !eyebrow &&
          "max-md:flex max-md:items-baseline max-md:justify-between max-md:gap-x-4",
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
          <p
            className={cn(
              "label flex items-center gap-2 text-subtle",
              eyebrowRepeatsTab && "max-md:hidden",
            )}
          >
            <span>{eyebrow}</span>
          </p>
        ) : null}
        <Tag id={id} className={cn("font-medium text-balance hyphens-none", titleSize[size])}>
          <span className="text-fg">{title}</span>
          {aside ? (
            <span
              className={cn(
                "text-subtle",
                // Under md: den stora rubriken på en rad, den grå delen mindre under.
                size === "xl" && "max-md:mt-1 max-md:block max-md:text-lg max-[399px]:text-md",
                hideAsideOnMobile && "max-md:hidden",
              )}
            >
              {" "}
              {aside}
            </span>
          ) : null}
        </Tag>
        {description ? (
          <p className={cn("line-clamp-2 max-w-xl text-muted", small ? "text-sm" : "text-base")}>
            {description}
          </p>
        ) : null}
      </div>

      {hasSide ? (
        <div className="flex min-w-0 flex-col gap-3 max-md:shrink-0 lg:col-span-4 lg:col-start-9">
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

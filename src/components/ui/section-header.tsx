import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

type SectionHeaderProps = {
  /** Sektionsnummer, t.ex. 1 → "01", eller "06.1" för undersektion */
  index: number | string;
  /** Kategori i versaler, t.ex. "Försäljning" */
  eyebrow: string;
  /** Första, ljusa delen av rubriken */
  title: string;
  /** Andra, grå delen av rubriken */
  aside?: string;
  description?: string;
  actions?: ReactNode;
  as?: "h1" | "h2" | "h3";
  size?: "lg" | "md";
  className?: string;
  id?: string;
};

/** "01 / FÖRSÄLJNING" följt av tvådelad rubrik: "Intäkt per dag. Bästa dagen var 26 okt." */
export function SectionHeader({
  index,
  eyebrow,
  title,
  aside,
  description,
  actions,
  as: Tag = "h2",
  size = "lg",
  className,
  id,
}: SectionHeaderProps) {
  return (
    <header
      className={cn("flex flex-col gap-4 md:flex-row md:items-end md:justify-between", className)}
    >
      <div className="flex max-w-3xl min-w-0 flex-col gap-3">
        <p className="label flex items-center gap-2 text-subtle">
          <span className="tnum text-fg">
            {typeof index === "number" ? String(index).padStart(2, "0") : index}
          </span>
          <span aria-hidden className="text-faint">
            /
          </span>
          <span>{eyebrow}</span>
        </p>
        <Tag
          id={id}
          className={cn(
            "font-medium text-balance",
            size === "lg" ? "text-xl md:text-2xl" : "text-lg",
          )}
        >
          <span className="text-fg">{title}</span>
          {aside ? <span className="text-subtle"> {aside}</span> : null}
        </Tag>
        {description ? <p className="max-w-xl text-base text-muted">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  );
}

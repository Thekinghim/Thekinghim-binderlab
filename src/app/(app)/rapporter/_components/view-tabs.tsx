import Link from "next/link";

import { cn } from "@/lib/cn";

export type ViewTab<T extends string> = { value: T; label: string; count?: number };

/**
 * Under md radbryts flikarna i ett rutnät (hela bredden, 44 px höga), så att ingen flik
 * döljs utanför kanten.
 *
 * Flikar som länkar (?vy=), serverrenderade: fungerar utan JavaScript och
 * vald flik syns direkt. Samma utseende som Segmented.
 */
export function ViewTabs<T extends string>({
  tabs,
  value,
  hrefFor,
  label,
  className,
}: {
  tabs: ReadonlyArray<ViewTab<T>>;
  value: T;
  hrefFor: (value: T) => string;
  label: string;
  className?: string;
}) {
  return (
    <nav
      aria-label={label}
      className={cn(
        "inline-flex h-9 w-fit max-w-full [scrollbar-width:none] divide-x divide-line-strong overflow-x-auto rounded-sm border border-line-strong max-md:flex max-md:h-auto max-md:w-full max-md:flex-wrap max-md:gap-px max-md:divide-x-0 max-md:overflow-visible max-md:bg-line-strong",
        // V2-skalet: som .v2-seg (grå ränna, vald flik vit med skugga).
        "v2:gap-0.5 v2:divide-x-0 v2:rounded-v2 v2:border-0 v2:bg-v2-line v2:p-[3px]",
        className,
      )}
    >
      {tabs.map((t) => {
        const selected = t.value === value;
        return (
          <Link
            key={t.value}
            href={hrefFor(t.value)}
            scroll={false}
            aria-current={selected ? "page" : undefined}
            className={cn(
              "label relative inline-flex shrink-0 items-center gap-1.5 px-3.5 whitespace-nowrap transition-[background-color,color] duration-fast ease-instrument focus-visible:-outline-offset-2 max-md:min-h-11 max-md:min-w-11 max-md:grow max-md:basis-auto max-md:justify-center",
              selected
                ? "bg-hover font-medium text-fg after:pointer-events-none after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:bg-fg"
                : "text-subtle hover:bg-hover hover:text-muted max-md:bg-bg",
              "v2:rounded-v2-sm v2:text-v2-sm! v2:font-[550]! v2:after:hidden",
              selected
                ? "v2:bg-v2-panel v2:text-v2-ink v2:shadow-[0_0_0_1px_rgb(0_0_0/0.04),0_1px_2px_rgb(0_0_0/0.06)]"
                : "v2:bg-transparent v2:text-v2-mute v2:hover:bg-transparent v2:hover:text-v2-ink",
            )}
          >
            {t.label}
            {t.count !== undefined ? <span className="tnum text-subtle">{t.count}</span> : null}
          </Link>
        );
      })}
    </nav>
  );
}

/** Läser ?vy= och faller tillbaka på första fliken. */
export function pickView<T extends string>(
  raw: string | string[] | undefined,
  allowed: readonly T[],
): T {
  const v = Array.isArray(raw) ? raw[0] : raw;
  return (allowed as readonly string[]).includes(v ?? "") ? (v as T) : allowed[0]!;
}

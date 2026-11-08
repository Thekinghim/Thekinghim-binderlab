import Link from "next/link";

import { cn } from "@/lib/cn";

export type ViewTab<T extends string> = { value: T; label: string };

/**
 * Under md radbryts flikarna i ett rutnät (hela bredden, 44 px höga), så att ingen flik
 * döljs utanför kanten.
 *
 * Flikar som länkar (?vy=). Serverrenderade, så valt läge syns direkt och
 * fungerar utan JavaScript. Övriga parametrar (period, filter) följer med.
 */
export function ViewTabs<T extends string>({
  tabs,
  value,
  basePath,
  query,
  label,
  className,
}: {
  tabs: ReadonlyArray<ViewTab<T>>;
  value: T;
  basePath: string;
  /** Sidans frågesträng ("?period=…" eller ""), utan ?vy. */
  query: string;
  label: string;
  className?: string;
}) {
  const base = new URLSearchParams(query.replace(/^\?/, ""));
  base.delete("vy");
  return (
    <nav
      aria-label={label}
      className={cn(
        "inline-flex h-8 w-fit max-w-full [scrollbar-width:none] divide-x divide-line-strong overflow-x-auto rounded-sm border border-line-strong max-md:flex max-md:h-auto max-md:w-full max-md:flex-wrap max-md:gap-px max-md:divide-x-0 max-md:overflow-visible max-md:bg-line-strong",
        className,
      )}
    >
      {tabs.map((t, i) => {
        const selected = t.value === value;
        const q = new URLSearchParams(base);
        if (i > 0) q.set("vy", t.value);
        const qs = q.toString();
        return (
          <Link
            key={t.value}
            href={`${basePath}${qs ? `?${qs}` : ""}`}
            scroll={false}
            aria-current={selected ? "page" : undefined}
            className={cn(
              "label relative inline-flex shrink-0 items-center px-3 whitespace-nowrap transition-[background-color,color] duration-fast ease-instrument focus-visible:-outline-offset-2 max-md:min-h-11 max-md:min-w-11 max-md:grow max-md:basis-auto max-md:justify-center",
              selected
                ? "bg-hover font-medium text-fg after:pointer-events-none after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:bg-fg"
                : "text-subtle hover:text-muted max-md:bg-bg",
            )}
          >
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}

/** ?vy= → ett av flikvärdena, annars det första. */
export function pickTab<T extends string>(
  tabs: ReadonlyArray<ViewTab<T>>,
  raw: string | string[] | undefined,
): T {
  const v = Array.isArray(raw) ? raw[0] : raw;
  return (tabs.find((t) => t.value === v) ?? tabs[0]!).value;
}

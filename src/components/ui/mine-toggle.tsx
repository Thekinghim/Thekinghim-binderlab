import Link from "next/link";

import { cn } from "@/lib/cn";

/**
 * "Mina / Alla" som två länkar (fungerar utan JavaScript och kan bokmärkas). Samma utseende
 * som Segmented: valt läge har ett 2 px indexstreck och fylld yta.
 */
export function MineToggle({
  mine,
  hrefMine,
  hrefAll,
  label = "Visa",
  className,
}: {
  mine: boolean;
  hrefMine: string;
  hrefAll: string;
  label?: string;
  className?: string;
}) {
  const items = [
    { on: mine, href: hrefMine, text: "Mina" },
    { on: !mine, href: hrefAll, text: "Alla" },
  ];
  return (
    <nav
      aria-label={label}
      className={cn(
        "inline-flex h-8 w-fit divide-x divide-line-strong rounded-sm border border-line-strong max-md:h-[46px]",
        className,
      )}
    >
      {items.map((i) => (
        <Link
          key={i.text}
          href={i.href}
          aria-current={i.on ? "page" : undefined}
          scroll={false}
          className={cn(
            "label relative inline-flex items-center px-3 whitespace-nowrap transition-[background-color,color] duration-fast ease-instrument focus-visible:-outline-offset-2",
            i.on
              ? "bg-hover font-medium text-fg after:pointer-events-none after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:bg-fg"
              : "text-subtle hover:text-muted",
          )}
        >
          {i.text}
        </Link>
      ))}
    </nav>
  );
}

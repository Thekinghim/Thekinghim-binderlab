import Link from "next/link";
import type { ReactNode } from "react";

import { cn } from "@/lib/cn";

/**
 * En rad på Hem som leder vidare: en markering för nivån, en mening och en pil. Samma
 * utseende för utbetalningen, nästa sak att göra och svinnet, så att raderna läses som en
 * lista. `tone="signal"` = behöver dig nu (signalfärg), annars lugn.
 */
export function HomeRow({
  href,
  tone = "plain",
  children,
  className,
  ...data
}: {
  href: string;
  tone?: "signal" | "plain";
  children: ReactNode;
  className?: string;
} & Record<`data-${string}`, string | undefined>) {
  const signal = tone === "signal";
  return (
    <Link
      href={href}
      {...data}
      className={cn(
        "group flex min-h-11 items-center justify-between gap-3 rounded-sm border bg-surface px-4 py-2.5 text-base text-fg hover:bg-hover",
        signal ? "border-signal-line" : "border-line",
        className,
      )}
    >
      <span className="flex min-w-0 items-start gap-2.5">
        <span
          aria-hidden
          className={cn("mt-[0.55em] inline-block size-2 shrink-0", signal ? "bg-signal" : "bg-fg")}
        />
        <span className={cn("min-w-0", signal && "text-signal-fg")}>{children}</span>
      </span>
      <span aria-hidden className="shrink-0 text-subtle transition-colors group-hover:text-fg">
        →
      </span>
    </Link>
  );
}

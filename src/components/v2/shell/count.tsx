"use client";

import { Suspense, use } from "react";

import type { TodoCountSource } from "@/components/shell/side-nav";
import { cn } from "@/lib/cn";

/**
 * Räknaren vid en menypost (orange .cnt). Talet kan vara ett löfte som layouten skickar utan
 * att vänta (strömmar in). Inget ritas för 0 eller okänt.
 */
export function NavCount({
  count,
  neutral = false,
  label = "att göra",
}: {
  count: TodoCountSource;
  /** Grått tal utan bakgrund (antal stopp vid Rutt). */
  neutral?: boolean;
  label?: string;
}) {
  if (count === undefined || typeof count === "number") {
    return <Count n={count ?? 0} neutral={neutral} label={label} />;
  }
  return (
    <Suspense fallback={null}>
      <Streamed count={count} neutral={neutral} label={label} />
    </Suspense>
  );
}

function Streamed({
  count,
  neutral,
  label,
}: {
  count: Promise<number | undefined>;
  neutral: boolean;
  label: string;
}) {
  return <Count n={use(count) ?? 0} neutral={neutral} label={label} />;
}

function Count({ n, neutral, label }: { n: number; neutral: boolean; label: string }) {
  if (n <= 0) return null;
  return (
    <span className={cn("v2-cnt", neutral && "neutral")}>
      {n}
      <span className="sr-only"> {label}</span>
    </span>
  );
}

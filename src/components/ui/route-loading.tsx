import { cn } from "@/lib/cn";

import { Skeleton } from "./skeleton";

/** Laddningsläget för en sida (`loading.tsx`): rubrik, nyckeltal och innehåll som skeleton. */
export function RouteLoading({
  label,
  inset = "page",
  blocks = ["kpi", "chart", "table"],
}: {
  /** "Laddar rapporter" (skärmläsare). */
  label: string;
  inset?: "page" | "inset";
  blocks?: ReadonlyArray<"kpi" | "chart" | "table" | "form">;
}) {
  return (
    <div
      aria-busy="true"
      aria-label={label}
      role="status"
      className={cn(
        "flex w-full flex-col gap-10 md:gap-12",
        inset === "page" && "mx-auto max-w-[1280px] px-4 pt-8 pb-16 md:px-8 md:pt-12",
      )}
    >
      <span className="sr-only">{label}</span>
      <div className="flex flex-col gap-3">
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-10 w-full max-w-2xl" />
        <Skeleton className="h-10 w-2/3 max-w-xl" />
      </div>
      {blocks.map((b, i) =>
        b === "kpi" ? (
          <div key={i} className="grid grid-cols-2 gap-4 border-y border-line py-5 lg:grid-cols-5">
            {[0, 1, 2, 3, 4].map((n) => (
              <div key={n} className={cn("flex flex-col gap-3", n === 4 && "hidden lg:flex")}>
                <Skeleton className="h-3 w-20" />
                <Skeleton className="h-8 w-28" />
              </div>
            ))}
          </div>
        ) : b === "chart" ? (
          <div key={i} className="grid grid-cols-1 gap-8 lg:grid-cols-12">
            <Skeleton className="h-64 w-full lg:col-span-7" />
            <Skeleton className="h-64 w-full lg:col-span-5" />
          </div>
        ) : b === "form" ? (
          <div key={i} className="flex max-w-xl flex-col gap-4">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-9 w-full" />
          </div>
        ) : (
          <div key={i} className="flex flex-col gap-2">
            {[0, 1, 2, 3, 4, 5].map((n) => (
              <Skeleton key={n} className="h-9 w-full" />
            ))}
          </div>
        ),
      )}
    </div>
  );
}

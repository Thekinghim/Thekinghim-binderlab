"use client";

import { Skeleton, TableSkeleton } from "@/components/ui/skeleton";
import { useLocale } from "@/i18n/client";

/** Medan inköpspriserna läses: rubriken och titeltabellen. */
export default function Loading() {
  // Enkel vy på engelska (delägarens prislista ligger här): skärmläsaren säger "Loading".
  const label = useLocale() === "en" ? "Loading" : "Laddar inköpspriser";
  return (
    <div
      aria-busy="true"
      aria-label={label}
      className="mx-auto flex w-full max-w-[1280px] flex-col gap-12 px-4 pt-8 pb-16 md:px-8 md:pt-12"
    >
      <div className="flex flex-col gap-3">
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-11 w-full max-w-2xl" />
        <Skeleton className="h-11 w-2/3 max-w-xl" />
      </div>
      <div className="flex flex-col gap-8 border-t border-line pt-12">
        <Skeleton className="h-8 w-1/2 max-w-md" />
        <TableSkeleton rows={8} />
      </div>
    </div>
  );
}

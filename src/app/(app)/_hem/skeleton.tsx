import { KpiSkeleton, Skeleton } from "@/components/ui/skeleton";

/**
 * Hem medan siffrorna räknas: vinsten, i dag, målen och morgonbriefen, sedan Att göra,
 * nyckeltalen och diagrammet, i samma ordning som sidan så att inget hoppar.
 */
export function HemSkeleton() {
  return (
    <div
      aria-busy="true"
      aria-label="Laddar Hem"
      className="mx-auto flex w-full max-w-[1280px] flex-col px-4 pt-8 pb-16 md:px-8 md:pt-12"
    >
      <div className="flex flex-col gap-3">
        <Skeleton className="h-3 w-16" />
        <Skeleton className="h-11 w-full max-w-3xl lg:h-16" />
        <Skeleton className="h-6 w-2/3 max-w-xl" />
      </div>
      <Skeleton className="mt-8 h-24 w-full md:mt-10" />
      <Skeleton className="mt-6 h-6 w-48" />
      <Skeleton className="mt-6 h-28 w-full" />
      <div className="mt-10 flex flex-col gap-3 border-t border-line pt-8 md:mt-12">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
      </div>
      <div className="mt-10 md:mt-12">
        <KpiSkeleton />
      </div>
    </div>
  );
}

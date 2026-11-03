import { KpiSkeleton, Skeleton } from "@/components/ui/skeleton";

/**
 * Hem medan siffrorna räknas: rubriken, i dag hittills, nyckeltalen, diagrammet med Att göra bredvid och
 * topplistan, i samma rutnät som sidan så att inget hoppar när innehållet kommer.
 */
export function HemSkeleton() {
  return (
    <div
      aria-busy="true"
      aria-label="Laddar Hem"
      className="mx-auto flex w-full max-w-[1280px] flex-col px-4 pt-8 pb-16 md:px-8 md:pt-12"
    >
      <div className="grid grid-cols-1 gap-8 lg:grid-cols-12">
        <div className="flex flex-col gap-3 lg:col-span-8">
          <Skeleton className="h-3 w-16" />
          <Skeleton className="h-11 w-full max-w-2xl" />
          <Skeleton className="h-11 w-2/3 max-w-xl" />
        </div>
        <div className="hidden flex-col gap-3 lg:col-span-4 lg:flex">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-full" />
        </div>
      </div>
      <div className="mt-8 flex flex-col gap-4 md:mt-10">
        <Skeleton className="h-24 w-full" />
        <KpiSkeleton />
      </div>
      <Skeleton className="mt-6 h-24 w-full" />
      <div className="mt-10 grid grid-cols-1 gap-x-10 gap-y-16 border-t border-line pt-10 md:mt-12 md:pt-12 lg:grid-cols-12">
        <div className="flex flex-col gap-4 lg:col-span-8">
          <Skeleton className="h-6 w-1/2" />
          <Skeleton className="h-72 w-full" />
        </div>
        <div className="flex flex-col gap-4 lg:col-span-4">
          <Skeleton className="h-6 w-1/3" />
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      </div>
    </div>
  );
}

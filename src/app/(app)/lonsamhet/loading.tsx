import { KpiSkeleton, Skeleton, TableSkeleton } from "@/components/ui/skeleton";

/** Medan lönsamheten räknas: rubriken, nyckeltalen, vattenfallet och tabellen. */
export default function Loading() {
  return (
    <div
      aria-busy="true"
      aria-label="Laddar lönsamhet"
      className="mx-auto flex w-full max-w-[1280px] flex-col gap-10 px-4 pt-8 pb-16 md:gap-12 md:px-8 md:pt-12"
    >
      <div className="flex flex-col gap-3">
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-11 w-full max-w-2xl" />
        <Skeleton className="h-11 w-2/3 max-w-xl" />
      </div>
      <KpiSkeleton />
      <div className="grid grid-cols-1 gap-8 lg:grid-cols-12">
        <Skeleton className="h-72 w-full lg:col-span-7" />
        <Skeleton className="h-72 w-full lg:col-span-5" />
      </div>
      <TableSkeleton rows={8} />
    </div>
  );
}

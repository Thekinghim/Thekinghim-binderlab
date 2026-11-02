import { Skeleton, TableSkeleton } from "@/components/ui/skeleton";

/** Medan orderlistan laddas: rubrikens form och en tabell. */
export default function Loading() {
  return (
    <div
      aria-busy="true"
      aria-label="Laddar order"
      className="mx-auto flex w-full max-w-[1280px] flex-col gap-10 px-4 pt-8 pb-16 md:gap-12 md:px-8 md:pt-12"
    >
      <div className="flex flex-col gap-3">
        <Skeleton className="h-3 w-16" />
        <Skeleton className="h-9 w-full max-w-xl" />
        <Skeleton className="h-9 w-2/3 max-w-md" />
      </div>
      <div className="flex flex-col gap-6">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,16rem)] lg:grid-cols-[minmax(0,28rem)_minmax(0,16rem)]">
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-full" />
        </div>
        <TableSkeleton rows={10} />
      </div>
    </div>
  );
}

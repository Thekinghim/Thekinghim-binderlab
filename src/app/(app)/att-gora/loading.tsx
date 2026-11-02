import { Skeleton } from "@/components/ui/skeleton";

/** Medan Att göra räknas: rubriken med metablocket och de första punkterna. */
export default function Loading() {
  return (
    <div
      aria-busy="true"
      aria-label="Laddar Att göra"
      className="mx-auto flex w-full max-w-[1280px] flex-col gap-12 px-4 pt-8 pb-16 md:px-8 md:pt-12"
    >
      <div className="grid grid-cols-1 gap-8 lg:grid-cols-12">
        <div className="flex flex-col gap-3 lg:col-span-8">
          <Skeleton className="h-3 w-20" />
          <Skeleton className="h-11 w-full max-w-2xl" />
          <Skeleton className="h-4 w-2/3 max-w-xl" />
        </div>
        <div className="hidden flex-col gap-3 lg:col-span-4 lg:flex">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-full" />
        </div>
      </div>
      <div className="flex flex-col gap-8 border-t border-line pt-12">
        <Skeleton className="h-8 w-1/2 max-w-md" />
        {[0, 1, 2].map((i) => (
          <div key={i} className="grid grid-cols-1 gap-4 border-t border-line pt-6 lg:grid-cols-12">
            <div className="flex flex-col gap-2 lg:col-span-6">
              <Skeleton className="h-3 w-24" />
              <Skeleton className="h-5 w-3/4" />
              <Skeleton className="h-4 w-full" />
            </div>
            <Skeleton className="hidden h-12 w-full lg:col-span-3 lg:block" />
            <Skeleton className="h-9 w-40 lg:col-span-3 lg:justify-self-end" />
          </div>
        ))}
      </div>
    </div>
  );
}

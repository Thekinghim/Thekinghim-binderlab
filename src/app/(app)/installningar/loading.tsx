import { Skeleton } from "@/components/ui/skeleton";

/** Medan inställningarna läses: rubriken och de första fälten. Gäller också Användare. */
export default function Loading() {
  return (
    <div
      aria-busy="true"
      aria-label="Laddar inställningar"
      className="mx-auto flex w-full max-w-[1280px] flex-col gap-12 px-4 pt-8 pb-16 md:px-8 md:pt-12"
    >
      <div className="flex flex-col gap-3">
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-11 w-full max-w-2xl" />
      </div>
      <div className="grid grid-cols-1 gap-8 border-t border-line pt-12 lg:grid-cols-12">
        <div className="flex flex-col gap-3 lg:col-span-5">
          <Skeleton className="h-8 w-3/4" />
          <Skeleton className="h-4 w-full" />
        </div>
        <div className="flex flex-col gap-4 lg:col-span-7">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="flex flex-col gap-2">
              <Skeleton className="h-3 w-20" />
              <Skeleton className="h-9 w-full" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

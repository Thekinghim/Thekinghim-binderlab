import { Skeleton } from "@/components/ui/skeleton";

/** Medan veckan räknas: rubriken och korten. */
export default function Loading() {
  return (
    <div
      aria-busy="true"
      className="mx-auto flex w-full max-w-[720px] flex-col gap-4 px-4 pt-6 pb-16 md:px-8 md:pt-12"
    >
      <Skeleton className="h-3 w-40" />
      <Skeleton className="h-20 w-full" />
      <Skeleton className="h-40 w-full" />
      <Skeleton className="h-28 w-full" />
      <Skeleton className="h-24 w-full" />
    </div>
  );
}

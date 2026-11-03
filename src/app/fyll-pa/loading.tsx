import { Skeleton } from "@/components/ui/skeleton";

/** Laddningsläget för Fyll på: kortens platser, utan text. */
export default function Loading() {
  return (
    <div
      aria-busy="true"
      aria-label="Laddar"
      className="flex flex-col gap-3 px-4 pt-[calc(72px+env(safe-area-inset-top))]"
    >
      <Skeleton className="mb-3 h-8 w-3/4" />
      {[0, 1, 2, 3].map((i) => (
        <Skeleton key={i} className="h-24 rounded-md" />
      ))}
    </div>
  );
}

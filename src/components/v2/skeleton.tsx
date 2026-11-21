import { cn } from "@/lib/cn";

/** Laddningsyta i V2 (mjuk glans; still vid reducerad rörelse). */
export function Skeleton({
  className,
  width,
  height = 14,
}: {
  className?: string;
  width?: number | string;
  height?: number | string;
}) {
  return <span className={cn("v2-skel", className)} style={{ width, height }} aria-hidden="true" />;
}

/** Ett kort som laddar (Suspense-reserv): rubrikrad + några rader. */
export function SkeletonCard({ rows = 3, className }: { rows?: number; className?: string }) {
  return (
    <div className={cn("v2-card", className)} aria-busy="true" aria-label="Laddar">
      <div className="v2-card-hd">
        <Skeleton width={140} />
      </div>
      <div className="flex flex-col gap-3 px-[18px] py-4">
        {Array.from({ length: rows }, (_, i) => (
          <Skeleton key={i} width={`${90 - i * 12}%`} />
        ))}
      </div>
    </div>
  );
}

import { cn } from "@/lib/cn";

/** Laddningsyta. Pulserar svagt, ingen glänsande gradient. */
export function Skeleton({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cn("block animate-pulse-soft rounded-xs bg-hover", className)}
    />
  );
}

export function KpiSkeleton() {
  return (
    <div
      className="flex flex-col gap-5 rounded-md border border-line bg-surface p-4 md:p-5"
      aria-busy="true"
      aria-label="Laddar nyckeltal"
    >
      <Skeleton className="h-3 w-24" />
      <div className="flex flex-col gap-2">
        <Skeleton className="h-9 w-36" />
        <Skeleton className="h-3 w-28" />
      </div>
      <Skeleton className="h-9 w-full" />
    </div>
  );
}

export function TableSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div aria-busy="true" aria-label="Laddar tabell" className="flex flex-col">
      <div className="flex h-9 items-center justify-between border-b border-line-strong">
        <Skeleton className="h-2.5 w-20" />
        <Skeleton className="h-2.5 w-14" />
      </div>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex h-11 items-center justify-between gap-6 border-b border-line">
          <span className="block h-3" style={{ width: `${36 + ((i * 37) % 36)}%` }}>
            <Skeleton className="h-3 w-full" />
          </span>
          <div className="flex gap-6">
            <Skeleton className="h-3 w-12" />
            <Skeleton className="h-3 w-16" />
          </div>
        </div>
      ))}
    </div>
  );
}

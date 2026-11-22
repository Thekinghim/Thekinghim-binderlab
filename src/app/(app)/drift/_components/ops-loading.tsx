import { Skeleton, SkeletonCard } from "@/components/v2/skeleton";

/**
 * Laddningsläget för driftsidorna i V2 (Drift, Lager, Inköp, Veckan, Att göra, en automat):
 * sidhuvudets rubrik och kort som skeleton, med samma luft som V2Page.
 */
export function OpsLoading({ label, cards = [5, 3] }: { label: string; cards?: number[] }) {
  return (
    <div aria-busy="true" aria-label={label} role="status">
      <span className="sr-only">{label}</span>
      <div className="v2-top">
        <Skeleton width={160} height={20} />
      </div>
      <div className="v2-page-body">
        <div className="v2-stack">
          {cards.map((rows, i) => (
            <SkeletonCard key={i} rows={rows} />
          ))}
        </div>
      </div>
    </div>
  );
}

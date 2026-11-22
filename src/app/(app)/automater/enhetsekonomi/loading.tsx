import { Skeleton, SkeletonCard } from "@/components/v2/skeleton";

/** Medan enhetsekonomin räknas: rubriken och korten som skeleton (under skalets huvud). */
export default function Loading() {
  return (
    <div className="v2-page-body" aria-busy="true" aria-label="Laddar enhetsekonomi" role="status">
      <div className="v2-stack">
        <Skeleton width={280} height={20} />
        <SkeletonCard rows={2} />
        <SkeletonCard rows={6} />
      </div>
    </div>
  );
}

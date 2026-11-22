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

/**
 * Laddningsläget för en hel V2-sida (`loading.tsx`): sidhuvudets rubrik och datum som
 * skeleton och korten under, i huvudspalt och (med `side`) högerspalt. Med data-v2-page döljer
 * skalet de gamla sidornas huvud även medan sidan laddar, så att inget gammalt blinkar fram.
 */
export function V2PageSkeleton({
  label,
  main = [5, 3],
  side,
  kpis = 0,
  sub = false,
}: {
  /** "Laddar lönsamhet" (skärmläsare). */
  label: string;
  /** Rader per kort i huvudspalten. */
  main?: readonly number[];
  /** Rader per kort i högerspalten (utelämnat: en spalt). */
  side?: readonly number[];
  /** Antal nyckeltalsrutor överst (0: inga). */
  kpis?: number;
  /** En rad under rubriken (sidans sammanfattning). */
  sub?: boolean;
}) {
  const cards = (rows: readonly number[]) => rows.map((r, i) => <SkeletonCard key={i} rows={r} />);
  return (
    <div aria-busy="true" aria-label={label} role="status" data-v2-page>
      <span className="sr-only">{label}</span>
      <div className="v2-top">
        <span className="flex items-baseline gap-2.5">
          <Skeleton width={132} height={22} />
          <Skeleton width={128} className="max-[900px]:hidden" />
        </span>
        <Skeleton width={72} height={32} className="max-[900px]:hidden" />
      </div>
      {sub ? (
        <div className="v2-sub">
          <Skeleton width="min(80%, 360px)" />
        </div>
      ) : null}
      <div className="v2-page-body">
        <div className="v2-stack">
          {kpis > 0 ? (
            <div
              className="grid gap-3"
              style={{ gridTemplateColumns: `repeat(auto-fit, minmax(150px, 1fr))` }}
            >
              {Array.from({ length: kpis }, (_, i) => (
                <div key={i} className="v2-card flex flex-col gap-2.5 px-4 py-3.5">
                  <Skeleton width={84} height={12} />
                  <Skeleton width={110} height={22} />
                </div>
              ))}
            </div>
          ) : null}
          {side ? (
            <div className="v2-cols">
              <div className="v2-stack">{cards(main)}</div>
              <div className="v2-stack">{cards(side)}</div>
            </div>
          ) : (
            cards(main)
          )}
        </div>
      </div>
    </div>
  );
}

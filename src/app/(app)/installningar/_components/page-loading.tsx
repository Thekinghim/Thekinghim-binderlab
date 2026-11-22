import { Skeleton, SkeletonCard } from "@/components/v2/skeleton";

/**
 * Laddningsläget för Mer-sidorna i V2 (Inställningar, Datakällor, Inkorg, Assistent): sidhuvudets
 * rubrik och några kort i två spalter, samma mått som sidan.
 */
export function SettingsLoading({
  label,
  main = [4, 3],
  side = [3],
}: {
  label: string;
  main?: readonly number[];
  side?: readonly number[];
}) {
  return (
    <div aria-busy="true" aria-label={label} data-v2-page>
      <header className="v2-top">
        <Skeleton width={160} height={20} />
      </header>
      <div className="v2-page-body">
        <div className="v2-cols">
          <div className="v2-stack">
            {main.map((rows, i) => (
              <SkeletonCard key={i} rows={rows} />
            ))}
          </div>
          <div className="v2-stack">
            {side.map((rows, i) => (
              <SkeletonCard key={i} rows={rows} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

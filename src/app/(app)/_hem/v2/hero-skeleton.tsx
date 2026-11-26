import { Skeleton } from "@/components/v2/skeleton";

/**
 * Hjältekortet medan det laddar: samma delar och ungefär samma höjd som det färdiga kortet
 * (vinst, pallen, målet; på telefon målet som eget kort och nyckeltalen under), så att inget
 * hoppar när siffrorna kommer. Tidigare ett tomt vitt kort på 640 px på telefon.
 */
export function HemHeroSkeleton() {
  return (
    <div className="hh hh-calm hh-skel" role="status" aria-busy="true" aria-label="Laddar vinsten">
      <div className="v2-card hh-card">
        <div className="hh-sec hh-profit">
          <Skeleton className="lab" width={110} />
          <Skeleton className="sk-big" width={150} height={38} />
          <Skeleton className="sk-dl" width={120} height={18} />
          <Skeleton className="sk-spark" width="100%" height="var(--hh-sk-spark, 96px)" />
          <Skeleton className="sk-axis" width="100%" height={12} />
          <Skeleton className="sk-legend" width={180} height={12} />
        </div>
        <div className="hh-sec hh-pod">
          <Skeleton width={150} />
          <Skeleton className="sk-pod" width="min(100%, 240px)" height={170} />
        </div>
        <div className="hh-sec hh-goal">
          <Skeleton width={130} />
          <Skeleton className="sk-ring" width={120} height={120} />
        </div>
      </div>
      <div className="v2-card hh-goalcard">
        <div className="v2-card-hd">
          <Skeleton width={140} />
        </div>
        <div className="hh-goalcard-b">
          <Skeleton className="sk-ring" width={104} height={104} />
        </div>
      </div>
      <div className="v2-card hh-kpis hh-sk-kpis">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="hh-k">
            <Skeleton width={70} height={12} />
            <Skeleton className="sk-kv" width={90} height={20} />
          </div>
        ))}
      </div>
    </div>
  );
}

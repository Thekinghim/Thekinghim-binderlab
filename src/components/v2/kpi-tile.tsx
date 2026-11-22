import Link from "next/link";
import type { CSSProperties, ReactNode } from "react";

import { cn } from "@/lib/cn";

import { DeltaBadge } from "./badge";
import { Sparkline } from "./sparkline";

/**
 * En ruta i KPI-bandet (Hem, Pengar): etikett, tal, förändring mot jämförelsen och en liten
 * linje. Talet kommer färdigformaterat (eller som <RollingNumber/>). Med `href` är hela rutan
 * en länk.
 */
export function KpiTile({
  label,
  value,
  deltaBp,
  deltaUnit = "pct",
  goodWhenDown,
  neutral,
  compare,
  trend,
  href,
}: {
  label: string;
  value: ReactNode;
  /** Förändring i baspunkter (1 800 = 18 %); null/utelämnad = ingen jämförelse. */
  deltaBp?: number | null;
  deltaUnit?: "pct" | "pe";
  goodWhenDown?: boolean;
  /** Grått förändringsmärke (tal där upp inte är bättre, t.ex. lagervärdet). */
  neutral?: boolean;
  /** "mot förra", "mot i går", "mot förra v.". */
  compare?: string;
  /** Den lilla linjen (t.ex. per dag i perioden). Tom = ingen linje. */
  trend?: ReadonlyArray<number | null>;
  href?: string;
}) {
  const body = (
    <>
      <span className="kl">{label}</span>
      <span className="kn">{value}</span>
      {deltaBp !== null && deltaBp !== undefined ? (
        <span className="kd">
          <DeltaBadge bp={deltaBp} unit={deltaUnit} goodWhenDown={goodWhenDown} neutral={neutral} />
          {compare ? <span>{compare}</span> : null}
        </span>
      ) : compare ? (
        <span className="kd">
          <span>{compare}</span>
        </span>
      ) : null}
      {trend && trend.some((v) => v !== null) ? (
        <span className="ks">
          <Sparkline values={trend} />
        </span>
      ) : (
        <span className="ks-empty" />
      )}
    </>
  );
  return href ? (
    <Link href={href} className="v2-kt">
      {body}
    </Link>
  ) : (
    <div className="v2-kt">{body}</div>
  );
}

/**
 * KPI-bandet: 4 eller 8 rutor i en panel. 8 blir 2 × 4 under 1 240 px; på telefon två rutor
 * per rad, så att alla rutor och enheter syns utan att rulla.
 */
export function KpiBand({
  cols = 4,
  children,
  className,
  ariaLabel = "Nyckeltal",
}: {
  cols?: 4 | 8;
  children: ReactNode;
  className?: string;
  ariaLabel?: string;
}) {
  return (
    <div className={cn("v2-band-wrap", className)}>
      <div
        className="v2-band"
        data-cols={cols}
        style={{ "--cols": cols } as CSSProperties}
        role="group"
        aria-label={ariaLabel}
      >
        {children}
      </div>
    </div>
  );
}

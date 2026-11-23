import type { CSSProperties, ReactNode } from "react";

import { cn } from "@/lib/cn";

import { PackImage } from "./pack-image";
import { FAN_MAX, fanLayout, fanWidthInPacks, stackDepth } from "./visual-math";

/*
 * Packbilder som ligger på varandra: PackStack (en titels hög, tjockare ju fler hemma),
 * PackPodium (de tre mest sålda på en pall) och PackFan (en solfjäder av olika titlar: tomma
 * lägen, firanden, "saknar pris"). Alla bygger på PackImage, så titlar utan bild får samma
 * neutrala platta som överallt annars. Dekor: titlar och tal står alltid i text bredvid eller
 * under, så bilderna är aria-hidden (PackImage) och behållarna har ingen egen roll.
 * CSS: src/styles/v2.css, blocket "Packhög, pall och solfjäder".
 */

/* ---------------------------------------------------------------- PackStack */

export type PackStackSize = "m" | "l";

/**
 * En titels hög: packet framför och 0–4 kopior bakom, lätt vridna åt sidorna. Antalet kopior
 * följer `count` (antal hemma, se stackDepth) om inte `depth` anges. `ghost` = blekt (inget
 * hemma men på väg). `children` läggs ovanpå (t.ex. en etikett "+324 på väg").
 *
 * Höjd: m 64 px, l 96 px (Vårt lagers hylla).
 */
export function PackStack({
  title,
  count,
  depth,
  size = "l",
  ghost = false,
  className,
  children,
}: {
  title: string | null | undefined;
  count?: number | null;
  depth?: number;
  size?: PackStackSize;
  ghost?: boolean;
  className?: string;
  children?: ReactNode;
}) {
  const copies = Math.max(0, Math.min(4, Math.floor(depth ?? stackDepth(count))));
  return (
    <span className={cn("v2-pstack", size, ghost && "ghost", className)}>
      <PackImage title={title} size={size} className="v2-pstack-top" />
      {Array.from({ length: copies }, (_, i) => (
        <PackImage key={i} title={title} size={size} className="v2-pstack-cp" />
      ))}
      {children ? <span className="v2-pstack-over">{children}</span> : null}
    </span>
  );
}

/* ---------------------------------------------------------------- PackPodium */

export type PodiumItem = {
  title: string;
  /** Talet under packet, redan formaterat ("112 st"). */
  label: ReactNode;
  /** Valfri rad under talet (t.ex. titelns namn på dator). */
  sub?: ReactNode;
};

/**
 * De mest sålda på en pall: etta i mitten (störst, lite upplyft, mörk sifferbricka), tvåa till
 * vänster och trea till höger, lätt vridna inåt och överlappande. `items` i placeringsordning
 * (1, 2, 3); färre än tre går bra. Packen glider upp med 40 ms mellanrum när pallen visas
 * (bara toning med prefers-reduced-motion).
 *
 * Höjd: 150/128 px på dator, 112/96 px på telefon (≤ 900 px). Pallen är 236/178 px hög.
 */
export function PackPodium({
  items,
  className,
  "aria-label": ariaLabel,
}: {
  items: readonly PodiumItem[];
  className?: string;
  "aria-label"?: string;
}) {
  const top = items.slice(0, 3);
  // Visningsordning: 2, 1, 3.
  const order = [1, 0, 2].filter((i) => i < top.length);
  return (
    <ol className={cn("v2-podium", className)} aria-label={ariaLabel}>
      {order.map((i) => {
        const it = top[i]!;
        const rank = i + 1;
        return (
          <li key={rank} className={cn("v2-pod-i", `p${rank}`)} title={it.title} value={rank}>
            <span className="v2-pod-rk" aria-hidden="true">
              {rank}
            </span>
            <span className="sr-only">
              {rank}. {it.title}
            </span>
            <PackImage title={it.title} size="xl" className="v2-pod-img" priority={rank === 1} />
            <span className="v2-pod-n">{it.label}</span>
            {it.sub ? <span className="v2-pod-t">{it.sub}</span> : null}
          </li>
        );
      })}
    </ol>
  );
}

/* ---------------------------------------------------------------- PackFan */

export type PackFanSize = "s" | "m" | "l";

/**
 * En solfjäder av upp till fem titlar (fler ignoreras), symmetrisk kring mitten som ligger
 * överst. För tomma lägen ("Inga sålda än"), firanden ("Målet nått!") och små högar av olika
 * titlar (s, t.ex. "2 titlar saknar inköpspris"). Lägena räknas i fanLayout (visual-math.ts).
 * `shadow` = en mjuk skugga under, som om packen ligger på ett bord.
 *
 * Höjd per pack: s 62 px, m 112 px, l 132 px (på telefon s 56, m 96, l 112).
 */
export function PackFan({
  titles,
  size = "m",
  shadow = true,
  animate = true,
  className,
}: {
  titles: readonly (string | null | undefined)[];
  size?: PackFanSize;
  shadow?: boolean;
  animate?: boolean;
  className?: string;
}) {
  const list = titles.filter((t): t is string => Boolean(t?.trim())).slice(0, FAN_MAX);
  const slots = fanLayout(list.length);
  if (slots.length === 0) return null;
  return (
    <span
      aria-hidden="true"
      className={cn("v2-fan", size, animate && "anim", className)}
      style={{ "--fw": fanWidthInPacks(slots.length) } as CSSProperties}
    >
      {shadow ? <span className="v2-fan-floor" /> : null}
      {list.map((t, i) => {
        const s = slots[i]!;
        return (
          <span
            key={`${t}-${i}`}
            className="v2-fan-i"
            style={
              {
                "--x": `${s.x}%`,
                "--y": `${s.y}px`,
                "--r": `${s.rotate}deg`,
                "--sc": s.scale,
                "--dim": s.dim,
                "--i": i,
                zIndex: s.z,
              } as CSSProperties
            }
          >
            <PackImage title={t} size="xl" className="v2-fan-img" />
          </span>
        );
      })}
    </span>
  );
}

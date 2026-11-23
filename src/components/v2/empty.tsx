import type { ReactNode } from "react";

import { cn } from "@/lib/cn";
import { packKey } from "@/lib/pack-image";

import { PackFan } from "./pack-visuals";
import "./empty.css";

/** Solfjäderns reserv när organisationen inte har några titlar med bild än. */
export const EMPTY_PACKS_FALLBACK = [
  "Surging Sparks",
  "Prismatic Evolutions",
  "Scarlet & Violet 151",
] as const;

/** Rangordning → solfjäderns ordning (vänster → höger): etta i mitten, sedan vänster, höger. */
export function middleOut<T>(ranked: readonly T[]): T[] {
  const out: T[] = [];
  ranked.forEach((t, i) => {
    if (i % 2 === 1) out.unshift(t);
    else out.push(t);
  });
  return out;
}

/**
 * Titlar till ett tomt lägets solfjäder: de första `n` med packbild och olika bild (samma
 * pack tre gånger ser ut som en bugg), annars reserven. Den första står i mitten, överst.
 */
export function emptyPacks(
  titles: readonly (string | null | undefined)[],
  n = 3,
  fallback: readonly string[] = EMPTY_PACKS_FALLBACK,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of titles) {
    const key = packKey(t);
    if (!t || !key || seen.has(key)) continue;
    seen.add(key);
    out.push(t);
    if (out.length === n) break;
  }
  return middleOut(out.length >= Math.min(n, 2) ? out : fallback.slice(0, n));
}

/**
 * Tomt läge i V2: en rad som säger vad som saknas och vad man gör åt det.
 *
 * Med `packs` (titlar) står en liten solfjäder av packbilder ovanför, raden blir fet och
 * större och knappen står under: för tomma listor där packen är poängen (Order, Mystery
 * packs, packlistan). `done` lägger en grön bock på solfjädern (allt klart, inget att göra).
 * `size="l"` = sidans enda innehåll (större solfjäder, mer luft). Utan `packs`: som förut.
 */
export function Empty({
  title,
  children,
  action,
  className,
  packs,
  done = false,
  size = "m",
}: {
  title: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  className?: string;
  /** Titlar till solfjädern (högst fem visas; tomma hoppas över). */
  packs?: readonly (string | null | undefined)[];
  /** Grön bock på solfjädern: klart, inget att göra. */
  done?: boolean;
  /** m: i ett kort. l: sidans enda innehåll. */
  size?: "m" | "l";
}) {
  const fan = packs && packs.some((t) => t?.trim()) ? packs : null;
  if (!fan) {
    return (
      <div className={cn("v2-empty", className)}>
        <b>{title}</b>
        {children}
        {action ? <div className="mt-3 flex justify-center">{action}</div> : null}
      </div>
    );
  }
  return (
    <div className={cn("v2-empty v2-empty-packs", size === "l" && "l", className)}>
      <span className="v2-empty-art">
        <PackFan titles={fan} size={size === "l" ? "l" : "m"} />
        {done ? (
          <span className="v2-empty-ok" aria-hidden="true">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
              <path
                d="m5 12.5 4.5 4.5L19 7.5"
                stroke="currentColor"
                strokeWidth="2.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </span>
        ) : null}
      </span>
      <b>{title}</b>
      {children ? <div className="v2-empty-sub">{children}</div> : null}
      {action ? <div className="v2-empty-act">{action}</div> : null}
    </div>
  );
}

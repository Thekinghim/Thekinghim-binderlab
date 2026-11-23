import { cn } from "@/lib/cn";
import type { MachineLook } from "@/lib/machine-look";

import { MachineGlyph, type GlyphSize } from "./machine-glyph";

/**
 * Automatens bild i listor och kort: den riktiga automaten (MachineGlyph) med automatens eget
 * utseende (machines.appearance): svart med stjärnor eller gul. Utan `look` = svart med stjärnor.
 *
 * Dekor: automatens namn står alltid bredvid, så bilden är aria-hidden.
 * Storlekar (höjd): xs 26 (listrader), sm 40, md 64 (kort), lg 96 (butikskortets huvud).
 * Höjden sätts i CSS (--h, så att sidor kan krympa den); bilden skalas till rutan.
 * CSS: src/styles/v2.css, blocket "Automatbild".
 */
export type MachineThumbSize = "xs" | "sm" | "md" | "lg";

/**
 * Bildens detaljnivå per storlek. Upp till 64 px den enkla bilden (skärmen en färg, inga
 * packbilder eller ordmärke som blir grus); 96 px är exakt glyfens m.
 */
const GLYPH_SIZE: Readonly<Record<MachineThumbSize, GlyphSize>> = {
  xs: "xs",
  sm: "s",
  md: "s",
  lg: "m",
};

export function MachineThumb({
  size = "sm",
  look,
  className,
}: {
  machineId?: string | null;
  model?: string | null;
  /** Automatens utseende (machineLookOf(machines.appearance)). Utan = svart med stjärnor. */
  look?: MachineLook | null;
  size?: MachineThumbSize;
  className?: string;
}) {
  return (
    <span aria-hidden="true" className={cn("v2-mthumb", size, className)}>
      <MachineGlyph decorative look={look} size={GLYPH_SIZE[size]} />
    </span>
  );
}

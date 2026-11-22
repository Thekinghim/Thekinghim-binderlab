import type { ReactNode } from "react";

/**
 * Var n:e x-etikett under ett stapeldiagram (Hem och Pengar · Resultat), gallrad efter bredd.
 *
 * Servern vet inte hur brett diagrammet blir, så etiketterna får en nivå (`data-k`): 1 = var
 * `step`:e stapel, 2 = varannan av dem, 4 = var fjärde. CSS (v2.css, "x-axelns etiketter") döljer
 * nivå 1 när axeln är smal (telefon) och nivå 2 när den är mycket smal, så att etiketterna aldrig
 * krockar. Texten centreras under stapeln och flyttas in när den annars skulle sticka ut vid
 * kanterna: första etiketten börjar vid stapeln, en etikett nära högerkanten slutar vid den.
 *
 * Axelraden behöver klassen `v2-axr` (containern som bredden mäts mot). Serverkomponent.
 */
export function AxisTick({
  index,
  count,
  step,
  children,
}: {
  /** Staplens plats (0 …). */
  index: number;
  /** Antal staplar. */
  count: number;
  /** Var n:e stapel får etikett i full bredd. */
  step: number;
  children: ReactNode;
}) {
  const s = Math.max(1, step);
  if (index % s !== 0) return null;
  const nth = index / s;
  const k = nth % 4 === 0 ? 4 : nth % 2 === 0 ? 2 : 1;
  const left = count - 1 - index;
  return (
    <span
      className="v2-axt"
      data-k={k}
      data-start={index === 0 ? "" : undefined}
      // Sista etiketten i varje nivå sitter nära högerkanten: ankras i slutet om den inte får plats.
      data-end={left < s ? "" : undefined}
      data-end2={k >= 2 && left < 2 * s ? "" : undefined}
      data-end4={k >= 4 && left < 4 * s ? "" : undefined}
    >
      <b>{children}</b>
    </span>
  );
}

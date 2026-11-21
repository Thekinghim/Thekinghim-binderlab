import { cn } from "@/lib/cn";

/** Fyllnadens ton: röd vid tom, orange vid låg (≤ 25 %, LOW_FILL_BP), annars bläck. */
export function fillTone(bp: number | null, low = 2_500): "critical" | "warning" | undefined {
  if (bp === null) return undefined;
  if (bp <= 0) return "critical";
  if (bp <= low) return "warning";
  return undefined;
}

/**
 * Fyllnadsstapel med procent ("▬▬▬ 53 %"). `bp` 0–10 000; null = okänd (grå, "–", med
 * förklaringen i title, t.ex. "Inte läst från Awish").
 */
export function FillBar({
  bp,
  width = 120,
  showPct = true,
  unknownText = "Inte läst från Awish",
  className,
}: {
  bp: number | null;
  width?: number;
  showPct?: boolean;
  unknownText?: string;
  className?: string;
}) {
  const tone = fillTone(bp);
  const scale = bp === null ? 0 : Math.max(0, Math.min(1, bp / 10_000));
  const pct = bp === null ? "–" : `${Math.round(bp / 100)} %`;
  return (
    <span className={cn("v2-fill", className)} title={bp === null ? unknownText : undefined}>
      <span className="v2-track" style={{ width, flex: "none" }} aria-hidden="true">
        <i className={cn(tone, bp === null && "off")} style={{ transform: `scaleX(${scale})` }} />
      </span>
      {showPct ? (
        <span className={cn("pct", tone)}>
          {pct}
          {bp === null ? <span className="sr-only"> {unknownText}</span> : null}
        </span>
      ) : null}
    </span>
  );
}

import { V2PageSkeleton } from "@/components/v2/skeleton";

/**
 * Laddningsläget för en sida (`loading.tsx`) i V2: sidhuvudet och korten som skeleton
 * (V2PageSkeleton). Blocken blir kort: nyckeltal som rutor, diagram, tabell och formulär
 * som kort med rader.
 */
export function RouteLoading({
  label,
  blocks = ["kpi", "chart", "table"],
}: {
  /** "Laddar rapporter" (skärmläsare). */
  label: string;
  /** Äldre val, utan verkan: sidan har alltid V2-sidans luft. */
  inset?: "page" | "inset";
  blocks?: ReadonlyArray<"kpi" | "chart" | "table" | "form">;
}) {
  const rows = { chart: 6, table: 7, form: 4 } as const;
  return (
    <V2PageSkeleton
      label={label}
      kpis={blocks.includes("kpi") ? 4 : 0}
      main={blocks.filter((b) => b !== "kpi").map((b) => rows[b as keyof typeof rows])}
    />
  );
}

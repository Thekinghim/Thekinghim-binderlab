import { V2PageSkeleton } from "@/components/v2/skeleton";

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
  return <V2PageSkeleton label={label} main={main} side={side} />;
}

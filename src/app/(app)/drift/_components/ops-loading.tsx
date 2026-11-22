import { V2PageSkeleton } from "@/components/v2/skeleton";

/**
 * Laddningsläget för driftsidorna i V2 (Drift, Lager, Inköp, Veckan, Att göra, en automat):
 * sidhuvudets rubrik och kort som skeleton, med samma luft som V2Page.
 */
export function OpsLoading({ label, cards = [5, 3] }: { label: string; cards?: number[] }) {
  return <V2PageSkeleton label={label} main={cards} />;
}

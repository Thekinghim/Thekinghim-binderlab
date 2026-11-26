import { V2PageSkeleton } from "@/components/v2/skeleton";

/** Medan utbetalningarna hämtas: rubriken och listan som skeleton (utan periodval). */
export default function UtbetalningarLoading() {
  return <V2PageSkeleton label="Laddar utbetalningar" main={[6, 4]} />;
}

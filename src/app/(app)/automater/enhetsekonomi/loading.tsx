import { V2PageSkeleton } from "@/components/v2/skeleton";

/** Medan enhetsekonomin räknas: sidhuvudet och korten som skeleton. */
export default function Loading() {
  return <V2PageSkeleton label="Laddar enhetsekonomi" sub main={[2, 6]} />;
}

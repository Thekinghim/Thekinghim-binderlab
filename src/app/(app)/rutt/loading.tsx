import { V2PageSkeleton } from "@/components/v2/skeleton";

/** Medan rutten hämtas: rubriken och stoppen som skeleton direkt vid trycket på fliken. */
export default function RuttLoading() {
  return <V2PageSkeleton label="Laddar rutt" main={[4, 5, 3]} />;
}

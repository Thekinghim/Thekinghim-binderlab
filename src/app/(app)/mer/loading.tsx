import { V2PageSkeleton } from "@/components/v2/skeleton";

/** Medan Mer hämtas: rubriken och listorna som skeleton direkt vid trycket på fliken. */
export default function MerLoading() {
  return <V2PageSkeleton label="Laddar mer" main={[6, 8]} side={[4]} />;
}

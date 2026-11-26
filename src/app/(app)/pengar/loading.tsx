import { V2PageSkeleton } from "@/components/v2/skeleton";

/** Medan Pengar hämtas: rubriken, periodvalet och korten som skeleton direkt vid trycket. */
export default function PengarLoading() {
  return <V2PageSkeleton label="Laddar pengar" period main={[5, 6]} side={[5]} />;
}

import { PageSkeleton } from "@/components/v2/page-intro";

/** Medan sidan hämtar och räknar: rubriken och korten som skeleton (V2). */
export default function MarknadLoading() {
  return <PageSkeleton label="Laddar marknad" main={[6, 6]} />;
}

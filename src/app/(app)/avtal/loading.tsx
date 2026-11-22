import { PageSkeleton } from "@/components/v2/page-intro";

/** Medan sidan hämtar och räknar: rubriken och korten som skeleton (V2). */
export default function AvtalLoading() {
  return <PageSkeleton label="Laddar avtal" main={[8]} />;
}

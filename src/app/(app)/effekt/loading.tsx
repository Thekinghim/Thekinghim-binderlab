import { PageSkeleton } from "@/components/v2/page-intro";

/** Medan sidan hämtar och räknar: rubriken och korten som skeleton (V2). */
export default function EffektLoading() {
  return <PageSkeleton label="Laddar effekt" main={[8, 4]} />;
}

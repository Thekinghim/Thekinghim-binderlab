import { PageSkeleton } from "@/components/v2/page-intro";

/** Medan sidan hämtar och räknar: rubriken och korten som skeleton (V2). */
export default function ExpansionLoading() {
  return <PageSkeleton label="Laddar expansion" main={[4, 6]} />;
}

import { PageSkeleton } from "@/components/v2/page-intro";

/** Medan butikens siffror räknas: rubriken och korten som skeleton (V2). */
export default function StoreLoading() {
  return <PageSkeleton label="Laddar butiken" main={[4, 8, 5]} />;
}

import { PageSkeleton } from "@/components/v2/page-intro";

/** Medan sidan hämtar och räknar: rubrikraden och korten som skeleton. */
export default function EkonomiLoading() {
  return <PageSkeleton label="Laddar ekonomi" main={[3, 6]} side={[4, 2]} />;
}

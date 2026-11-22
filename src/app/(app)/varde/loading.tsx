import { PageSkeleton } from "@/components/v2/page-intro";

/** Medan sidan hämtar och räknar: rubrikraden och korten som skeleton. */
export default function VardeLoading() {
  return <PageSkeleton label="Laddar värdet" main={[2, 4, 5]} />;
}

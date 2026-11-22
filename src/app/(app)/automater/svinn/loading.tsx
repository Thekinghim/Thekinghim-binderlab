import { PageSkeleton } from "@/components/v2/page-intro";

/** Medan svinnet räknas: rubrikraden och korten per automat. */
export default function SvinnLoading() {
  return <PageSkeleton label="Laddar svinn" main={[5, 5]} />;
}

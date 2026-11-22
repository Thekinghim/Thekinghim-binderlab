import { PageSkeleton } from "@/components/v2/page-intro";

/** Medan lönsamheten räknas: rubrikraden, vattenfallet, tabellen och korten till höger. */
export default function Loading() {
  return <PageSkeleton label="Laddar lönsamhet" main={[6, 8]} side={[5, 4]} />;
}

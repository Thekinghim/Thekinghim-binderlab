import { PageSkeleton } from "@/components/v2/page-intro";

/** Medan orderlistan laddas: rubrikraden och listans kort. */
export default function Loading() {
  return <PageSkeleton label="Laddar order" main={[10]} />;
}

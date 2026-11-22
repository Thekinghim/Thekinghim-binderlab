import { OpsLoading } from "../drift/_components/ops-loading";

/** Medan Att göra räknas: rubriken och de första punkterna. */
export default function Loading() {
  return <OpsLoading label="Laddar Att göra" cards={[4, 3]} />;
}

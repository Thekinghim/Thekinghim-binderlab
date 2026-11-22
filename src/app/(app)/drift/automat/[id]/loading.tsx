import { OpsLoading } from "../../_components/ops-loading";

/** Medan tidslinjen hämtas: rubriken och händelserna som skeleton. */
export default function TimelineLoading() {
  return <OpsLoading label="Laddar tidslinjen" cards={[3, 6]} />;
}

import { OpsLoading } from "../drift/_components/ops-loading";

/** Medan sidan hämtar och räknar: rubriken och korten som skeleton. */
export default function LagerLoading() {
  return <OpsLoading label="Laddar lager" cards={[4, 8]} />;
}

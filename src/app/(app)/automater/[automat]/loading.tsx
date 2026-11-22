import { OpsLoading } from "../../drift/_components/ops-loading";

/** Medan automatens siffror räknas: rubriken, nyckeltal och korten som skeleton. */
export default function MachineLoading() {
  return <OpsLoading label="Laddar automaten" cards={[3, 6, 4]} />;
}

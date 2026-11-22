import { OpsLoading } from "../drift/_components/ops-loading";

/** Medan veckan räknas: rubriken och korten. */
export default function Loading() {
  return <OpsLoading label="Laddar veckan" cards={[3, 3, 2]} />;
}

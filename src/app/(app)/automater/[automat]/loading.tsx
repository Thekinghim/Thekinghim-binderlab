import { RouteLoading } from "@/components/ui/route-loading";

/** Medan automatens siffror räknas: rubriken, nyckeltal och diagram som skeleton. */
export default function MachineLoading() {
  return <RouteLoading label="Laddar automaten" blocks={["kpi", "chart", "table"]} />;
}

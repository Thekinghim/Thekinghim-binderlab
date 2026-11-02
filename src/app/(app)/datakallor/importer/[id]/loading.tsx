import { RouteLoading } from "@/components/ui/route-loading";

/** Medan importen och radloggen hämtas: rubriken och tabellen som skeleton. */
export default function ImportLoading() {
  return <RouteLoading label="Laddar importen" blocks={["kpi", "table"]} />;
}

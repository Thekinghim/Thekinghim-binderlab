import { RouteLoading } from "@/components/ui/route-loading";

/** Medan sidan hämtar och räknar: rubriken och innehållet som skeleton. */
export default function AvtalLoading() {
  return <RouteLoading label="Laddar avtal" blocks={["kpi", "table"]} />;
}

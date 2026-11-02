import { RouteLoading } from "@/components/ui/route-loading";

/** Medan sidan hämtar och räknar: rubriken och innehållet som skeleton. */
export default function LagerLoading() {
  return <RouteLoading label="Laddar lager" blocks={["kpi", "table"]} />;
}
